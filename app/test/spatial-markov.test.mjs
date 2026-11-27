import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  positionVarianceFactor, radius80, recentVelocity, rectangleProbability, spatialEntities, spatialForecast,
} from '../public/spatial-markov.js';

test('the spatial snapshot includes the ball and outfield players', () => {
  const roster = new Map([[1, { short_name: 'Keeper', player_role: { name: 'Goalkeeper' } }],
    [2, { short_name: 'Defender', team_id: 4 }]]);
  const points = spatialEntities({
    ball_data: { x: 4, y: 2 },
    player_data: [{ player_id: 1, x: 0, y: 2 }, { player_id: 2, x: 12, y: -2 }],
  }, roster);
  assert.deepEqual(points.map(point => point.id), ['ball', '2']);
  assert.deepEqual(recentVelocity(points[0], { x: 1, y: 1 }, 0.5), { vx: 6, vy: 2 });
});

test('spatial diffusion starts at the observed position and spreads with time', () => {
  const parameters = { halfLife: 2, positionMix: 0.5, variance: 4 };
  const point = { x: 0, y: 0 }, velocity = { vx: 2, vy: 0 };
  assert.deepEqual(spatialForecast(point, velocity, 0, parameters), { ...point, variance: 0 });
  assert.equal(positionVarianceFactor(1, 2, 0.5), 1);
  const one = spatialForecast(point, velocity, 1, parameters);
  const five = spatialForecast(point, velocity, 5, parameters);
  assert.ok(one.x > 0 && one.x < 2 && five.x > one.x);
  assert.ok(radius80(five.variance) > radius80(one.variance));
});

test('the backward terminal condition and Gaussian region probability agree', () => {
  const region = { xMin: 0, xMax: 10, yMin: 0, yMax: 10 };
  assert.equal(rectangleProbability({ x: 5, y: 5, variance: 0 }, region), 1);
  assert.equal(rectangleProbability({ x: -1, y: 5, variance: 0 }, region), 0);
  assert.ok(Math.abs(rectangleProbability({ x: 0, y: 0, variance: 1 }, region) - 0.25) < 1e-6);
});
