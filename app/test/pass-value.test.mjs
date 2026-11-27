import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passFlightPoint, passInTransit } from '../public/pass-value.js';

test('pass flight is confined to its period and rejects stoppage-length gaps', () => {
  const pass = { period: 1, release: 100, complete: 120 };
  assert.equal(passInTransit([pass], { period: 1, frame: 100 }), pass);
  assert.equal(passInTransit([pass], { period: 1, frame: 120 }), undefined);
  assert.equal(passInTransit([pass], { period: 2, frame: 105 }), undefined);
  assert.equal(passInTransit([{ ...pass, complete: 180 }], { period: 1, frame: 105 }), undefined);
  assert.deepEqual(passFlightPoint({ x: 2, y: 1 }, { x: 10, y: 5 }, pass, 110), { x: 6, y: 3 });
  assert.deepEqual(passFlightPoint({ x: 2, y: 1 }, { x: 10, y: 5 }, pass, 130), { x: 10, y: 5 });
});
