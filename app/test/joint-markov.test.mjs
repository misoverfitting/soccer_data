import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  entityMarginal, featureCount, jointSnapshot, latentMean, nextCellProbability, sampleJointFrame,
} from '../public/joint-markov.js';

const meta = { home_team: { id: 1 }, away_team: { id: 2 }, home_team_side: ['left_to_right', 'right_to_left'],
  pitch_length: 105, pitch_width: 68 };
const points = [{ id: 'ball', kind: 'ball', x: 0, y: 0 }, ...Array.from({ length: 20 }, (_, i) => ({
  id: String(i), kind: 'player', x: i - 10, y: i % 3, team: i < 10 ? 1 : 2,
}))];

test('joint snapshots preserve player identity and include the full formation', () => {
  const snapshot = jointSnapshot(points, [...points].reverse(), meta, 1);
  assert.equal(snapshot.features.length, featureCount);
  assert.equal(snapshot.points.length, 21);
  assert.ok(snapshot.points.every(point => point.vx === 0 && point.vy === 0));
  assert.equal(jointSnapshot(points, points.slice(1), meta, 1), null);
  assert.equal(jointSnapshot(points.slice(0, -1), points, meta, 1), null);
});

test('the fitted ball prediction responds to player placement and samples whole frames', async () => {
  const fit = JSON.parse(await readFile(new URL('../public/joint-markov-fit.json', import.meta.url), 'utf8'));
  const snapshot = jointSnapshot(points, points, meta, 1);
  const moved = points.map(point => point.id === '3' ? { ...point, y: point.y + 8 } : point);
  const other = jointSnapshot(moved, moved, meta, 1);
  const mean = latentMean(fit, snapshot);
  assert.notDeepEqual(mean.slice(0, 2), latentMean(fit, other).slice(0, 2));
  assert.ok(fit.factor[2].slice(0, 2).some(value => Math.abs(value) > 1e-5));
  const sample = sampleJointFrame(fit, snapshot, mean, 42);
  assert.deepEqual(sample, sampleJointFrame(fit, snapshot, mean, 42));
  assert.notDeepEqual(sample, sampleJointFrame(fit, snapshot, mean, 43));
  for (const [i, result] of sample.entries()) {
    assert.equal(result.id, snapshot.points[i].id);
    assert.equal(result.x - snapshot.points[i].cell.x, result.vx);
    assert.equal(result.y - snapshot.points[i].cell.y, result.vy);
  }
  const marginal = entityMarginal(fit, snapshot, mean, 0);
  let probability = 0;
  for (let x = -60; x <= 60; x++) for (let y = -60; y <= 60; y++) probability += nextCellProbability(marginal, x, y);
  assert.ok(Math.abs(1 - probability) < 1e-6);
});
