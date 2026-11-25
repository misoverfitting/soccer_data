import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { optimizeDefense } from '../public/defensive-position-optimizer.js';
import { summarizePath, pathFormation } from '../public/optimizer-path.js';
import { buildIntegrity } from '../public/integrity.js';

const readFit = name => JSON.parse(readFileSync(new URL('../../notebooks/fitted/' + name, import.meta.url)));
const fitted = {
  settings: readFit('pitch_control_settings.json').settings,
  valueModel: readFit('value_model.json'),
};
const attackers = [{ x: -10, y: 0 }, { x: -19, y: 8 }];
const defenders = [
  { id: 'GK', x: -24, y: 0, bounds: { minX: -25, maxX: -21, minY: -3, maxY: 3 } },
  { id: 'CB', x: -15, y: -5 },
];

function viewerScore(layout, metric) {
  const player_data = [...attackers, ...layout].map(({ x, y }, player_id) => ({ x, y, player_id }));
  const frame = { frame: 0, period: 1, ball_data: attackers[0], possession: { group: 'home team' }, player_data };
  const meta = {
    pitch_length: 50, pitch_width: 30, home_team: { id: 0 }, away_team: { id: 1 },
    home_team_side: ['right_to_left'],
    players: player_data.map(({ player_id: id }) => ({ id, team_id: id < 2 ? 0 : 1 })),
  };
  const physical = Object.fromEntries(player_data.map(p => [p.player_id, { vmax: 8, amax: 5 }]));
  const model = buildIntegrity(frame, null, null, meta, { ...fitted, physical });
  if (metric === 'EPV') return model.ballValue;
  const grid = model.grid();
  return metric === 'Integrity' ? grid.integrity : grid.threat;
}

for (const metric of ['Integrity', 'Danger', 'EPV']) {
  test(metric + ' returns feasible extrema scored with the viewer model', () => {
    const scene = {
      metric, attackers, ball: attackers[0], defenders, attackDirection: 'left',
      pitchLength: 50, pitchWidth: 30, restarts: 1, minSpacing: 3,
    };
    const { minimum, maximum } = optimizeDefense(scene, fitted);
    const observed = viewerScore(defenders, metric);
    assert.ok(minimum.value <= observed && observed <= maximum.value);
    assert.ok(minimum.value < maximum.value);
    for (const result of [minimum, maximum]) {
      const [keeper, centreBack] = result.defenders;
      assert.deepEqual(result.defenders.map(p => p.id), ['GK', 'CB']);
      assert.ok(keeper.x >= -25 && keeper.x <= -21 && Math.abs(keeper.y) <= 3);
      assert.ok(Math.abs(centreBack.x) <= 25 && Math.abs(centreBack.y) <= 15);
      assert.ok(Math.hypot(keeper.x - centreBack.x, keeper.y - centreBack.y) >= 3);
      assert.equal(result.value, viewerScore(result.defenders, metric));
    }
  });
}

test('optimizer worker minimizes Danger and EPV and maximizes Integrity', async () => {
  const messages = [];
  globalThis.self = { postMessage: value => messages.push(value) };
  try {
    await import('../public/optimizer-worker.js');
    for (const [metric, direction] of [['danger', 'minimum'], ['integrity', 'maximum'], ['epv', 'minimum']]) {
      const fixedKeeper = { id: 'GK', bounds: { minX: -5, maxX: -5, minY: 2, maxY: 2 } };
      const scene = {
        metric, attackers, defenders: [fixedKeeper, { id: 'CB' }], ball: attackers[0], attackDirection: 'left',
        pitchLength: 50, pitchWidth: 30, restarts: 1,
      };
      self.onmessage({ data: { scene, fitted } });
      const expected = optimizeDefense(scene, fitted)[direction];
      assert.deepEqual(messages.pop(), { result: expected });
      assert.deepEqual(expected.defenders[0], { id: 'GK', x: -5, y: 2 });
      self.onmessage({ data: { scenes: [scene, null], fitted } });
      assert.deepEqual(messages.splice(0), [{ completed: 1 }, { completed: 2 }, { results: [expected, null] }]);
    }
  } finally {
    delete globalThis.self;
  }
});


test('clip movement compares the same outfield players and interpolates by tracking frame', () => {
  const keeper = { id: 'GK' };
  const scene = { defenders: [keeper, { id: 'CB', vmax: 6 }, { id: 'FB' }] };
  const samples = [
    { second: 0, frame: 40, period: 1, team: 1, scene, keeper },
    { second: 1, frame: 50, period: 1, team: 1, scene, keeper },
    { second: 2, frame: 60, period: 1, team: 0, scene, keeper },
  ];
  const result = (keeperX, backX, fullBackX) => ({
    value: 0.15,
    defenders: [{ ...keeper, x: keeperX, y: 0 }, { id: 'CB', x: backX, y: 0 }, { id: 'FB', x: fullBackX, y: 9 }],
  });
  samples[1].tracked = new Map([
    ['GK', { x: 0, y: 0 }], ['CB', { x: 1, y: 0 }], ['FB', { x: 3, y: 9 }],
  ]);
  const path = summarizePath(samples, [result(0, 0, 0), result(20, 7, 8), result(0, 0, 0)]);
  assert.deepEqual(path.map(sample => sample.movement), [
    { distance: 0, overThreshold: 0, players: 2 },
    { distance: 15, overThreshold: 1, players: 2 },
    null,
  ]);
  assert.deepEqual(path[1].offset, { distance: 11, overThreshold: 1, players: 2 });
  assert.deepEqual(pathFormation(path, { frame: 45, period: 1 }, samples[0]), {
    defenders: [{ id: 'CB', x: 3.5, y: 0 }, { id: 'FB', x: 4, y: 9 }],
  });
  assert.equal(pathFormation(path, { frame: 55, period: 1 }, samples[2]), null);
});
