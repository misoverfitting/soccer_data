import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { gridCell } from '../public/grid-markov.js';
import { entityCount, featureCount, jointSnapshot } from '../public/joint-markov.js';
import { spatialEntities } from '../public/spatial-markov.js';
import { trackingStream } from '../tracking-stream.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const split = await readJson('app/public/markov-fit.json');
const gitDirectory = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: root, encoding: 'utf8' }).trim();
const outputs = 2 * entityCount;
const dimension = featureCount + outputs;
const matrix = (rows, columns = rows, entry = () => 0) =>
  Array.from({ length: rows }, (_, i) => Float64Array.from({ length: columns }, (_, j) => entry(i, j)));
const sum = values => values.reduce((a, b) => a + b, 0);
const dot = (a, b) => a.reduce((total, value, i) => total + value * b[i], 0);

async function collect(match) {
  const { id } = match;
  const prefix = `data/matches/${id}/${id}`;
  const meta = await readJson(`${prefix}_match.json`);
  const roster = new Map(meta.players.map(player => [player.id, player]));
  const stream = await trackingStream(path.join(root, `${prefix}_tracking_extrapolated.jsonl`),
    id, gitDirectory, split.sourceCommit);
  const moments = matrix(dimension);
  let previous, run = 0, before, current, count = 0, eligible = 0, velocityError = 0;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.timestamp == null || previous?.timestamp == null || frame.period !== previous.period
      || frame.frame !== previous.frame + 1) run++;
    previous = frame;
    if (frame.timestamp == null || frame.frame % 10 !== 0) continue;
    const next = { run, period: frame.period, points: spatialEntities(frame, roster) };
    if (before?.run === run && current?.run === run) {
      eligible++;
      const snapshot = jointSnapshot(current.points, before.points, meta, current.period);
      const final = new Map(next.points.map(point => [point.id, gridCell(point)]));
      if (snapshot?.points.every(point => final.has(point.id)) && next.points.length === entityCount) {
        const targets = snapshot.points.flatMap(point => {
          const position = final.get(point.id);
          const dx = snapshot.flip * (position.x - point.cell.x), dy = position.y - point.cell.y;
          velocityError += (dx - point.vx) ** 2 + (dy - point.vy) ** 2;
          return [dx, dy];
        });
        const sample = [...snapshot.features, ...targets];
        for (let i = 0; i < dimension; i++) {
          for (let j = 0; j <= i; j++) moments[i][j] += sample[i] * sample[j];
        }
        count++;
      }
    }
    before = current;
    current = next;
  }
  for (let i = 0; i < dimension; i++) for (let j = i + 1; j < dimension; j++) moments[i][j] = moments[j][i];
  console.error(`Read ${id}: ${count}/${eligible} complete transitions`);
  return { count, eligible, velocityError, moments };
}

function combine(matches) {
  return { count: sum(matches.map(match => match.count)),
    moments: matrix(dimension, dimension, (i, j) => sum(matches.map(match => match.moments[i][j]))) };
}

function cholesky(covariance) {
  const factor = matrix(covariance.length);
  for (let i = 0; i < factor.length; i++) for (let j = 0; j <= i; j++) {
    let value = covariance[i][j];
    for (let k = 0; k < j; k++) value -= factor[i][k] * factor[j][k];
    factor[i][j] = i === j ? Math.sqrt(value) : value / factor[j][j];
    if (!Number.isFinite(factor[i][j])) throw new Error('Covariance is not positive definite');
  }
  return factor;
}

function solve(factor, target) {
  const result = Float64Array.from(target);
  for (let i = 0; i < factor.length; i++) {
    for (let j = 0; j < i; j++) result[i] -= factor[i][j] * result[j];
    result[i] /= factor[i][i];
  }
  for (let i = factor.length - 1; i >= 0; i--) {
    for (let j = i + 1; j < factor.length; j++) result[i] -= factor[j][i] * result[j];
    result[i] /= factor[i][i];
  }
  return result;
}

function means({ count, moments }, ridge) {
  const predictor = cholesky(matrix(featureCount, featureCount, (i, j) =>
    moments[i][j] / count + (i === j && i !== 0 ? ridge : 0)));
  return Array.from({ length: outputs }, (_, i) =>
    solve(predictor, moments[featureCount + i].slice(0, featureCount).map(value => value / count)));
}

function errorCovariance({ count, moments }, coefficients) {
  const predicted = coefficients.map(row => Float64Array.from({ length: featureCount },
    (_, j) => dot(moments[j].subarray(0, featureCount), row)));
  return matrix(outputs, outputs, (i, j) => (
    moments[featureCount + i][featureCount + j] + dot(coefficients[i], predicted[j])
    - dot(coefficients[i], moments[featureCount + j].subarray(0, featureCount))
    - dot(coefficients[j], moments[featureCount + i].subarray(0, featureCount))
  ) / count);
}

const covarianceFactor = (error, shrink) => cholesky(matrix(outputs, outputs, (i, j) =>
  i === j ? error[i][j] + 1 / 12 : (1 - shrink) * error[i][j]));

function logDensityLoss(error, factor) {
  let trace = 0, logDet = 0;
  for (let i = 0; i < outputs; i++) {
    const inverseColumn = solve(factor, Float64Array.from({ length: outputs }, (_, j) => Number(i === j)));
    trace += dot(error[i], inverseColumn);
    logDet += 2 * Math.log(factor[i][i]);
  }
  return (outputs * Math.log(2 * Math.PI) + logDet + trace) / (2 * outputs);
}

const training = [];
for (const match of split.training) training.push(await collect(match));
const folds = training.map((held, i) => ({ held, train: combine(training.filter((_, j) => j !== i)) }));
const tuning = [];
for (const ridge of [0.0001, 0.001, 0.01, 0.1]) {
  const errors = folds.map(({ train, held }) => {
    const coefficients = means(train, ridge);
    return { train: errorCovariance(train, coefficients), held: errorCovariance(held, coefficients) };
  });
  for (const shrink of [0, 0.15, 0.5, 1]) {
    const loss = sum(errors.map(fold => logDensityLoss(fold.held, covarianceFactor(fold.train, shrink)))) / errors.length;
    tuning.push({ ridge, shrink, loss });
  }
}
tuning.sort((a, b) => a.loss - b.loss);
const selected = tuning[0], pooled = combine(training);
const coefficients = means(pooled, selected.ridge);
const trainingError = errorCovariance(pooled, coefficients);
const factor = covarianceFactor(trainingError, selected.shrink);
const held = await collect(split.holdout);
const error = errorCovariance(held, coefficients);
const rmse = (start, end) => Math.sqrt(sum(Array.from({ length: end - start }, (_, i) => error[i + start][i + start])) / ((end - start) / 2));
const persistence = (start, end) => Math.sqrt(sum(Array.from({ length: end - start }, (_, i) => {
  const coordinate = i + start + featureCount;
  return held.moments[coordinate][coordinate];
})) / (held.count * (end - start) / 2));
const validation = {
  complete: held.count, eligible: held.eligible,
  frameRmse: rmse(0, outputs), playerRmse: rmse(2, outputs), ballRmse: rmse(0, 2),
  playerPersistence: persistence(2, outputs), ballPersistence: persistence(0, 2),
  frameConstantVelocity: Math.sqrt(held.velocityError / (held.count * entityCount)),
  loss: logDensityLoss(error, factor), diagonalLoss: logDensityLoss(error, covarianceFactor(trainingError, 1)),
};
const rows = array => array.map(row => Array.from(row));
await writeFile(path.join(root, 'app/public/joint-markov-fit.json'), JSON.stringify({
  sourceCommit: split.sourceCommit, holdout: split.holdout, training: split.training, trainingCount: pooled.count,
  selected, validation, coefficients: rows(coefficients), factor: rows(factor),
}) + '\n');
console.log({ selected, training: pooled.count, validation });
