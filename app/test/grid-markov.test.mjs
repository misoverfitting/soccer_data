import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { gridState, gridTransition } from '../public/grid-markov.js';

test('a 1 m state uses signed net cell displacement over one second', () => {
  const state = gridState({ x: -0.1, y: 5.99 }, { x: -2.4, y: 8 }, 105, 68);
  assert.deepEqual(state, { x: -1, y: 5, vx: 2, vy: -3, zone: 4 });
});

test('the fitted displacement kernel has unit mass and supports unseen transitions', async () => {
  const fit = JSON.parse(await readFile(new URL('../public/grid-markov-fit.json', import.meta.url), 'utf8'));
  for (const model of Object.values(fit.models)) {
    for (const state of [{ vx: 2, vy: -3, zone: 4 }, { vx: 300, vy: 15, zone: 1 }]) {
      const probability = gridTransition(model, state);
      assert.ok(probability(200, -300) > 0);
      let mass = 0;
      for (let dx = -250; dx <= 250; dx++) for (let dy = -250; dy <= 250; dy++) {
        mass += probability(dx, dy);
      }
      assert.ok(Math.abs(1 - mass) < 1e-8);
    }
  }
  assert.equal(fit.training.length, 9);
  assert.ok(fit.training.every(match => match.id !== fit.holdout.id));
});
