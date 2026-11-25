import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { optimizeDefense } from '../public/defensive-position-optimizer.js';
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

test('optimizer worker minimizes Danger and maximizes Integrity and EPV', async () => {
  let message;
  globalThis.self = { postMessage: value => { message = value; } };
  try {
    await import('../public/optimizer-worker.js');
    for (const [metric, direction] of [['danger', 'minimum'], ['integrity', 'maximum'], ['epv', 'maximum']]) {
      const scene = {
        metric, attackers, defenders, ball: attackers[0], attackDirection: 'left',
        pitchLength: 50, pitchWidth: 30, restarts: 1,
      };
      self.onmessage({ data: { scene, fitted } });
      assert.deepEqual(message, { result: optimizeDefense(scene, fitted)[direction] });
    }
  } finally {
    delete globalThis.self;
  }
});
