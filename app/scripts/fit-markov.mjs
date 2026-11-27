import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { markovState, stateLabels, transitionMatrix } from '../public/markov.js';
import { trackingStream } from '../tracking-stream.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const sourceCommit = (await readJson('app/chance-catalogue.json')).sourceCommit;
const gitDirectory = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: root, encoding: 'utf8' }).trim();
const fixtures = (await readJson('data/matches.json')).sort((a, b) =>
  a.date_time.localeCompare(b.date_time) || a.id - b.id).slice(0, 10);
const size = stateLabels.length;
const cadences = [2, 5, 10]; // Source frames, tracked at 10 Hz.
const horizons = [1, 3, 5, 10, 20];
const grid = entry => Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => entry(i, j)));
const zero = () => grid(() => 0);
const sum = values => values.reduce((total, n) => total + n, 0);
const combine = tables => grid((i, j) => sum(tables.map(table => table[i][j])));

async function collect({ id, date_time: date }) {
  const filename = `data/matches/${id}/${id}`;
  const meta = await readJson(`${filename}_match.json`);
  const roster = new Map(meta.players.map(player => [player.id, player.team_id]));
  const stream = await trackingStream(path.join(root, `${filename}_tracking_extrapolated.jsonl`),
    id, gitDirectory, sourceCommit);
  const runs = [];
  let run = [], prior;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    const state = markovState(frame, meta, roster);
    if (state == null || frame.period !== prior?.period || frame.frame !== prior?.frame + 1) {
      run = [];
    }
    if (state != null) {
      if (!run.length) runs.push(run);
      run.push(state);
    }
    prior = frame;
  }
  const counts = (lag, stride) => {
    const pairs = zero();
    for (const states of runs) {
      for (let i = 0; i + lag < states.length; i += stride) pairs[states[i]][states[i + lag]]++;
    }
    return pairs;
  };
  const result = {
    id, date, fixture: `${meta.home_team.name} vs ${meta.away_team.name}`,
    frames: sum(runs.map(states => states.length)),
    jumps: cadences.map(lag => counts(lag, lag)),
    outcomes: horizons.map(seconds => counts(seconds * 10, 10)),
  };
  console.error(`Read ${id}: ${result.frames} states`);
  return result;
}

function fit(matches, { cadence, priorSeconds, rateScale }) {
  const counts = combine(matches.map(match => match.jumps[cadences.indexOf(cadence)]));
  const exposure = counts.map(row => sum(row) * cadence / 10);
  const pooledRate = sum(counts.map((row, i) => sum(row) - row[i])) / sum(exposure);
  const frequency = exposure.map(value => value / sum(exposure));
  const rates = grid((i, j) => i === j ? 0 : rateScale *
    (counts[i][j] + priorSeconds * pooledRate * frequency[j] / (1 - frequency[i])) /
    (exposure[i] + priorSeconds));
  for (const [i, row] of rates.entries()) row[i] = -sum(row);
  return { rates, frequency };
}

function score(pairs, probability) {
  let logLoss = 0, brier = 0, correct = 0, count = 0;
  for (const [i, row] of pairs.entries()) {
    const prediction = probability[i];
    const top = prediction.indexOf(Math.max(...prediction));
    const squared = sum(prediction.map(p => p * p));
    for (const [j, n] of row.entries()) {
      count += n;
      logLoss -= n * Math.log(Math.max(1e-15, prediction[j]));
      brier += n * (1 - 2 * prediction[j] + squared);
      if (j === top) correct += n;
    }
  }
  return { count, logLoss: logLoss / count, brier: brier / count, accuracy: correct / count };
}

const training = await Promise.all(fixtures.slice(0, 9).map(collect));
const candidates = cadences.flatMap(cadence => [0, 20, 100].flatMap(priorSeconds =>
  [0.7, 1, 1.3].map(rateScale => ({ cadence, priorSeconds, rateScale }))));
const tuning = candidates.map(parameters => {
  const losses = training.flatMap((match, held) => {
    const { rates } = fit(training.filter((_, i) => i !== held), parameters);
    return horizons.map((seconds, i) => score(match.outcomes[i], transitionMatrix(rates, seconds)).logLoss);
  });
  return { ...parameters, logLoss: sum(losses) / losses.length };
}).sort((a, b) => a.logLoss - b.logLoss);
const selected = tuning[0];
const { rates, frequency } = fit(training, selected);

// Read the validation match only after selecting all model parameters.
const held = await collect(fixtures[9]);
const validation = horizons.map((seconds, i) => {
  const directCounts = combine(training.map(match => match.outcomes[i]));
  const direct = grid((from, to) => (directCounts[from][to] + frequency[to]) / (sum(directCounts[from]) + 1));
  return {
    seconds,
    chain: score(held.outcomes[i], transitionMatrix(rates, seconds)),
    frequency: score(held.outcomes[i], grid((_, to) => frequency[to])),
    direct: score(held.outcomes[i], direct),
  };
});
const describe = ({ id, date, fixture, frames }) => ({ id, date, fixture, frames });
await writeFile(path.join(root, 'app/public/markov-fit.json'), JSON.stringify({
  sourceCommit, training: training.map(describe), holdout: describe(held), states: stateLabels,
  rates, frequency, selected, tuning, validation,
}, null, 2) + '\n');
console.table(validation.map(({ seconds, chain, frequency, direct }) => ({
  seconds, windows: chain.count, chain: chain.logLoss, frequency: frequency.logLoss, direct: direct.logLoss,
})));
console.log('Selected', selected);
