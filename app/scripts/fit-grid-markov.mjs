import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cellKey, gridState, gridTransition, velocityKey } from '../public/grid-markov.js';
import { spatialEntities, spatialKinds } from '../public/spatial-markov.js';
import { trackingStream } from '../tracking-stream.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const split = await readJson('app/public/markov-fit.json');
const gitDirectory = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: root, encoding: 'utf8' }).trim();
const bins = [1, 2, 4];
const alphas = [5, 25, 100];
const zonePriors = [null, 20, 100];

async function collect(match) {
  const { id } = match;
  const prefix = `data/matches/${id}/${id}`;
  const meta = await readJson(`${prefix}_match.json`);
  const roster = new Map(meta.players.map(player => [player.id, player]));
  const stream = await trackingStream(path.join(root, `${prefix}_tracking_extrapolated.jsonl`),
    id, gitDirectory, split.sourceCommit);
  const counts = Object.fromEntries(spatialKinds.map(kind => [kind, new Map()]));
  let previous, run = 0, before, current;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.timestamp == null || previous?.timestamp == null || frame.period !== previous.period
      || frame.frame !== previous.frame + 1) run++;
    previous = frame;
    if (frame.timestamp == null || frame.frame % 10 !== 0) continue;
    const next = { run, points: new Map(spatialEntities(frame, roster).map(point => [point.id, point])) };
    if (before?.run === run && current?.run === run) {
      for (const point of current.points.values()) {
        const prior = before.points.get(point.id), after = next.points.get(point.id);
        if (!prior || !after) continue;
        const state = gridState(point, prior, meta.pitch_length, meta.pitch_width);
        const dx = Math.floor(after.x) - state.x, dy = Math.floor(after.y) - state.y;
        const key = [state.zone, state.vx, state.vy, dx, dy].join(',');
        const rows = counts[point.kind];
        if (!rows.has(key)) rows.set(key, { state, dx, dy, n: 0 });
        rows.get(key).n++;
      }
    }
    before = current;
    current = next;
  }
  console.error(`Read ${id}`);
  return counts;
}

const histogram = () => ({ n: 0, outcomes: Object.create(null) });
function add(row, outcome, n) {
  row.n += n;
  row.outcomes[outcome] = (row.outcomes[outcome] ?? 0) + n;
}

function fit(matches, kind, bin) {
  const global = histogram(), velocity = Object.create(null), local = Object.create(null);
  for (const match of matches) {
    for (const { state, dx, dy, n } of match[kind].values()) {
      const key = velocityKey(state, bin), localKey = `${state.zone}:${key}`, outcome = cellKey(dx, dy);
      add(global, outcome, n);
      add(velocity[key] ??= histogram(), outcome, n);
      add(local[localKey] ??= histogram(), outcome, n);
    }
  }
  return { bin, global, velocity, local, tailScale: kind === 'ball' ? 12 : 3 };
}

function score(model, rows, evaluateBaselines = false) {
  let logLoss = 0, baselineLoss = 0, cellMatch = 0, count = 0;
  const transitions = new Map();
  const baseline = evaluateBaselines
    ? gridTransition({ ...model, velocity: {}, local: null }, { vx: 0, vy: 0 }) : null;
  for (const { state, dx, dy, n } of rows.values()) {
    const key = `${state.zone}:${velocityKey(state, model.bin)}`;
    if (!transitions.has(key)) transitions.set(key, gridTransition(model, state));
    logLoss -= n * Math.log(transitions.get(key)(dx, dy));
    if (baseline) baselineLoss -= n * Math.log(baseline(dx, dy));
    if (state.vx === dx && state.vy === dy) cellMatch += n;
    count += n;
  }
  return { count, logLoss: logLoss / count, baselineLoss: baselineLoss / count, exactConstantVelocity: cellMatch / count };
}

const training = [];
for (const match of split.training) training.push(await collect(match));
const models = {};
for (const kind of spatialKinds) {
  let best;
  for (const bin of bins) {
    const folds = training.map((_, i) => fit(training.filter((__, j) => i !== j), kind, bin));
    for (const alpha of alphas) for (const zonePrior of zonePriors) {
      const losses = folds.map((fold, i) => score({
        ...fold, alpha, zonePrior, local: zonePrior ? fold.local : null,
      }, training[i][kind]).logLoss);
      const cvLoss = losses.reduce((sum, value) => sum + value, 0) / losses.length;
      if (!best || cvLoss < best.cvLoss) best = { bin, alpha, zonePrior, cvLoss };
    }
  }
  const final = fit(training, kind, best.bin);
  models[kind] = { ...final, ...best, local: best.zonePrior ? final.local : null };
}
const holdout = await collect(split.holdout);
const validation = Object.fromEntries(spatialKinds.map(kind => [kind, score(models[kind], holdout[kind], true)]));
await writeFile(path.join(root, 'app/public/grid-markov-fit.json'), JSON.stringify({
  sourceCommit: split.sourceCommit, holdout: split.holdout, training: split.training, validation, models,
}) + '\n');
console.table(spatialKinds.map(kind => {
  const { bin, alpha, zonePrior, cvLoss } = models[kind];
  return { kind, bin, alpha, zonePrior, cvLoss, ...validation[kind] };
}));
