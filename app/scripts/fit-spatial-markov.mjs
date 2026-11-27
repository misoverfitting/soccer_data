import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  displacementFactor, positionVarianceFactor, radius80, recentVelocity, spatialEntities, spatialKinds,
} from '../public/spatial-markov.js';
import { trackingStream } from '../tracking-stream.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const split = await readJson('app/public/markov-fit.json');
const gitDirectory = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: root, encoding: 'utf8' }).trim();
const horizons = [1, 3, 5, 10, 20];
const lookbacks = [3, 6, 10];
const sum = values => values.reduce((a, b) => a + b, 0);
const search = lookbacks.flatMap(lookback => [0.25, 0.5, 1, 2, 4, 8, 16].flatMap(halfLife =>
  [0, 0.25, 0.5, 0.75, 1].map(positionMix => ({ lookback, halfLife, positionMix }))));
const group = (lookback, kind, seconds) => `${lookback}:${kind}:${seconds}`;

async function collect(match, fitted) {
  const { id } = match;
  const prefix = `data/matches/${id}/${id}`;
  const meta = await readJson(`${prefix}_match.json`);
  const roster = new Map(meta.players.map(player => [player.id, player]));
  const stream = await trackingStream(path.join(root, `${prefix}_tracking_extrapolated.jsonl`),
    id, gitDirectory, split.sourceCommit);
  const snapshots = new Map();
  const offsets = new Set([0, ...lookbacks.map(value => (10 - value) % 10)]);
  let run = 0, previous;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.timestamp == null || previous?.timestamp == null || frame.period !== previous.period
      || frame.frame !== previous.frame + 1) run++;
    previous = frame;
    if (frame.timestamp != null && offsets.has(frame.frame % 10)) {
      snapshots.set(frame.frame, {
        run, points: new Map(spatialEntities(frame, roster).map(point => [point.id, point])),
      });
    }
  }
  const stats = new Map();
  for (const lag of lookbacks) for (const kind of spatialKinds) for (const seconds of horizons) {
    stats.set(group(lag, kind, seconds), { n: 0, displacementSq: 0, dot: 0, speedSq: 0, covered: 0 });
  }
  for (const [frame, start] of snapshots) {
    if (frame % 10 !== 0) continue;
    for (const lag of lookbacks) {
      const past = snapshots.get(frame - lag);
      if (past?.run !== start.run) continue;
      for (const seconds of horizons) {
        const end = snapshots.get(frame + seconds * 10);
        if (end?.run !== start.run) continue;
        for (const point of start.points.values()) {
          const before = past.points.get(point.id), after = end.points.get(point.id);
          if (!before || !after) continue;
          const { vx, vy } = recentVelocity(point, before, lag / 10);
          const dx = after.x - point.x, dy = after.y - point.y;
          const sample = stats.get(group(lag, point.kind, seconds));
          sample.n++;
          sample.displacementSq += dx * dx + dy * dy;
          sample.dot += dx * vx + dy * vy;
          sample.speedSq += vx * vx + vy * vy;
          const parameters = fitted?.[point.kind];
          if (parameters?.lookback === lag) {
            const factor = displacementFactor(seconds, parameters.halfLife);
            const sdSq = parameters.variance * positionVarianceFactor(seconds, parameters.halfLife, parameters.positionMix);
            if (Math.hypot(dx - factor * vx, dy - factor * vy) <= radius80(sdSq)) sample.covered++;
          }
        }
      }
    }
  }
  console.error(`Read ${id}: ${snapshots.size} tracking snapshots`);
  return stats;
}

const residual = (sample, factor) =>
  Math.max(0, sample.displacementSq - 2 * factor * sample.dot + factor ** 2 * sample.speedSq);

function variance(matches, kind, parameters) {
  const { lookback, halfLife, positionMix } = parameters;
  let weighted = 0, count = 0;
  for (const seconds of horizons) {
    const factor = displacementFactor(seconds, halfLife);
    const shape = positionVarianceFactor(seconds, halfLife, positionMix);
    for (const match of matches) {
      const stats = match.get(group(lookback, kind, seconds));
      weighted += residual(stats, factor) / shape;
      count += stats.n;
    }
  }
  return weighted / (2 * count);
}

function score(match, kind, seconds, parameters) {
  const { lookback, halfLife, positionMix } = parameters;
  const stats = match.get(group(lookback, kind, seconds));
  const factor = displacementFactor(seconds, halfLife);
  const spread = parameters.variance * positionVarianceFactor(seconds, halfLife, positionMix);
  const error = residual(stats, factor) / stats.n;
  return {
    count: stats.n, rmse: Math.sqrt(error), persistence: Math.sqrt(stats.displacementSq / stats.n),
    constantVelocity: Math.sqrt(residual(stats, seconds) / stats.n),
    nll: Math.log(2 * Math.PI * spread) + error / (2 * spread), coverage80: stats.covered / stats.n,
  };
}

const training = [];
for (const match of split.training) training.push(await collect(match));
const parameters = Object.fromEntries(spatialKinds.map(kind => {
  const tuning = search.map(candidate => {
    const scores = training.flatMap((held, i) => {
      const fold = training.filter((_, index) => index !== i);
      const fitted = { ...candidate, variance: variance(fold, kind, candidate) };
      return horizons.map(seconds => score(held, kind, seconds, fitted).nll);
    });
    return { ...candidate, cvNll: sum(scores) / scores.length };
  });
  const best = tuning.reduce((a, b) => a.cvNll < b.cvNll ? a : b);
  return [kind, { ...best, variance: variance(training, kind, best) }];
}));
const held = await collect(split.holdout, parameters);
const validation = horizons.map(seconds => ({
  seconds, ...Object.fromEntries(spatialKinds.map(kind => [kind, score(held, kind, seconds, parameters[kind])])),
}));
await writeFile(path.join(root, 'app/public/spatial-markov-fit.json'), JSON.stringify({
  training: split.training, holdout: split.holdout, sourceCommit: split.sourceCommit, parameters, validation,
}, null, 2) + '\n');
console.log(parameters);
console.table(validation.map(row => ({
  seconds: row.seconds, player: row.player.rmse, playerPersistence: row.player.persistence,
  ball: row.ball.rmse, ballPersistence: row.ball.persistence,
})));
