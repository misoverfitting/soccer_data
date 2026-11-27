import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { passingData } from '../passing-data.mjs';
import { buildIntegrity } from '../public/integrity.js';
import { passInTransit, passValueFeatures } from '../public/pass-value.js';
import { trackingStream } from '../tracking-stream.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const split = await readJson('app/public/markov-fit.json');

async function collect(match, gitDirectory) {
  const { id } = match;
  const prefix = `data/matches/${id}/${id}`;
  const meta = await readJson(`${prefix}_match.json`);
  const roster = new Map(meta.players.map(player => [player.id, player]));
  const data = await passingData(root, id, meta);
  const teacherData = { ...data, runs: [] };
  let recent = [], stats, total = 0, count = 0;
  const stream = await trackingStream(path.join(root, `${prefix}_tracking_extrapolated.jsonl`),
    id, gitDirectory, split.sourceCommit);
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    const before = recent[0];
    recent = [recent.at(-1), frame];
    if (frame.timestamp == null) continue;
    total++;
    const features = passValueFeatures(frame, meta, roster);
    if (!features || passInTransit(data.passes, frame)) continue;
    const model = buildIntegrity(frame, before, null, meta, teacherData);
    if (model.reason || !model.receivers.length) continue;
    const best = Math.max(...model.receivers.map(receiver => model.projectedOption(receiver).gain));
    if (!Number.isFinite(best)) continue;
    const sample = [...features, best];
    stats ??= sample.map(() => new Float64Array(sample.length));
    for (let i = 0; i < sample.length; i++) {
      for (let j = 0; j <= i; j++) stats[i][j] += sample[i] * sample[j];
    }
    count++;
  }
  if (!count) throw new Error(`No usable pass-value targets for match ${id}`);
  console.error(`Read ${id}: ${count}/${total} supervised frames`);
  return { stats, count, total };
}

function combine(matches) {
  const count = matches.reduce((sum, match) => sum + match.count, 0);
  const stats = matches[0].stats.map((row, i) => row.map((_, j) =>
    matches.reduce((sum, match) => sum + match.stats[i][j], 0)));
  return { stats, count };
}

function ridgeFit({ stats, count }, ridge) {
  const dimension = stats.length - 1;
  const factor = Array.from({ length: dimension }, () => new Float64Array(dimension));
  const result = stats[dimension].slice(0, dimension).map(value => value / count);
  for (let i = 0; i < dimension; i++) {
    for (let j = 0; j <= i; j++) {
      let value = stats[i][j] / count + (i === j && i > 0 ? ridge : 0);
      for (let k = 0; k < j; k++) value -= factor[i][k] * factor[j][k];
      factor[i][j] = i === j ? Math.sqrt(value) : value / factor[j][j];
    }
    for (let j = 0; j < i; j++) result[i] -= factor[i][j] * result[j];
    result[i] /= factor[i][i];
  }
  for (let i = dimension - 1; i >= 0; i--) {
    for (let j = i + 1; j < dimension; j++) result[i] -= factor[j][i] * result[j];
    result[i] /= factor[i][i];
  }
  return Array.from(result);
}

function mse({ stats, count }, coefficients) {
  const dimension = stats.length - 1;
  let residual = stats[dimension][dimension];
  for (let i = 0; i < dimension; i++) {
    residual -= 2 * coefficients[i] * stats[dimension][i];
    for (let j = 0; j <= i; j++) {
      residual += coefficients[i] * coefficients[j] * stats[i][j] * (i === j ? 1 : 2);
    }
  }
  return Math.max(0, residual / count);
}

if (!isMainThread) parentPort.postMessage(await collect(workerData.match, workerData.gitDirectory));
else {
  const gitDirectory = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: root, encoding: 'utf8' }).trim();
  const training = await Promise.all(split.training.map(match => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { match, gitDirectory } });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', code => { if (code) reject(new Error(`Training worker exited with ${code}`)); });
  })));
  const folds = training.map((held, i) => ({ held, train: combine(training.filter((_, j) => j !== i)) }));
  const tuning = [0.00001, 0.0001, 0.001, 0.01, 0.1].map(ridge => ({
    ridge, rmse: Math.sqrt(folds.reduce((sum, { held, train }) => sum + mse(held, ridgeFit(train, ridge)), 0) / folds.length),
  })).sort((a, b) => a.rmse - b.rmse);
  const pooled = combine(training), selected = tuning[0];
  const coefficients = ridgeFit(pooled, selected.ridge);
  const held = await collect(split.holdout, gitDirectory);
  const average = pooled.stats.at(-1)[0] / pooled.count;
  const baseline = [average, ...coefficients.slice(1).map(() => 0)];
  const validation = { count: held.count, total: held.total,
    rmse: Math.sqrt(mse(held, coefficients)), baseline: Math.sqrt(mse(held, baseline)) };
  const fitted = { selected, coefficients, training: split.training, holdout: split.holdout,
    trainingCount: pooled.count, trainingTotal: training.reduce((sum, match) => sum + match.total, 0), validation };
  await writeFile(path.join(root, 'app/public/pass-value-fit.json'), JSON.stringify(fitted, null, 2) + '\n');
  console.log({ selected, trainingCount: pooled.count, trainingTotal: fitted.trainingTotal, validation });
}
