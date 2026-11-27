import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { distributionEntropy, markovState, transitionMatrix } from '../public/markov.js';

test('continuous-time forecasts match the analytical two-state chain', () => {
  const generator = [[-2, 2], [1, -1]];
  assert.deepEqual(transitionMatrix(generator, 0), [[1, 0], [0, 1]]);
  const transition = transitionMatrix(generator, 0.7);
  assert.ok(Math.abs(transition[0][1] - 2 / 3 * (1 - Math.exp(-2.1))) < 1e-12);
  assert.ok(Math.abs(transition[1][0] - 1 / 3 * (1 - Math.exp(-2.1))) < 1e-12);
  const long = transitionMatrix(generator, 60);
  assert.ok(Math.abs(long[0][1] - 2 / 3) < 1e-12);
  assert.equal(distributionEntropy([1, 0]), 0);
  assert.equal(distributionEntropy([0.5, 0.5]), 1);
});

test('possession thirds follow each team’s attacking direction', () => {
  const meta = {
    pitch_length: 105, home_team: { id: 1 }, away_team: { id: 2 },
    home_team_side: ['left_to_right', 'right_to_left'],
  };
  const roster = new Map([[10, 1], [20, 2]]);
  const frame = { timestamp: '00:01', period: 1, ball_data: { x: 22 } };
  assert.equal(markovState({ ...frame, possession: { player_id: 10 } }, meta, roster), 2);
  assert.equal(markovState({ ...frame, possession: { group: 'away team' } }, meta, roster), 3);
  assert.equal(markovState({ ...frame, period: 2, possession: { player_id: 20 } }, meta, roster), 5);
  assert.equal(markovState(frame, meta, roster), 6);
  assert.equal(markovState({ ...frame, ball_data: null, possession: { player_id: 10 } }, meta, roster), null);
});

test('the fitted generator gives normalized predictions and keeps the holdout separate', async () => {
  const fit = JSON.parse(await readFile(new URL('../public/markov-fit.json', import.meta.url), 'utf8'));
  assert.equal(fit.training.length, 9);
  assert.ok(fit.training.every(match => match.date <= fit.holdout.date && match.id !== fit.holdout.id));
  for (const [i, row] of fit.rates.entries()) {
    assert.ok(Math.abs(row.reduce((sum, value) => sum + value, 0)) < 1e-12);
    assert.ok(row.every((value, j) => i === j ? value <= 0 : value >= 0));
  }
  for (const seconds of [1, 5, 60]) {
    for (const row of transitionMatrix(fit.rates, seconds)) {
      assert.ok(row.every(probability => probability >= 0 && probability <= 1));
      assert.ok(Math.abs(row.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
    }
  }
});
