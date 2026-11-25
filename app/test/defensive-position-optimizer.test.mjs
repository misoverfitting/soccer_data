import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { optimizeDefense } from '../public/defensive-position-optimizer.js';
import { summarizePath, pathFormation, plausibleSamples, plausiblePlaybackStep, plausibleArrowPhase } from '../public/optimizer-path.js';
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

test('alignment measures last-second tracked motion toward the current optimum', () => {
  const keeper = { id: 'GK' };
  const optimum = { id: 'CB', x: 10, y: 0 };
  const priorTracked = new Map([['CB', { x: 0, y: 0 }]]);
  const result = { defenders: [keeper, optimum] };
  for (const [x, y, expected] of [[2, 0, 1], [-2, 0, 0], [0, 2, 0.5], [0, 0, 0.5]]) {
    const tracked = new Map([['CB', { x, y }]]);
    const [sample] = summarizePath([{ keeper, tracked, priorTracked }], [result]);
    assert.equal(sample.alignment, expected);
  }
  const tracked = new Map([['CB', { x: 2, y: 0 }]]);
  assert.equal(summarizePath([{ keeper, tracked }], [result])[0].alignment, null);
  const atTarget = new Map([['CB', optimum]]);
  assert.equal(summarizePath([{ keeper, tracked, priorTracked: atTarget }], [result])[0].alignment, null);
});


test('plausible search uses the next tracked game state and respects one-second reach', () => {
  const meta = {
    pitch_length: 50, pitch_width: 30, home_team: { id: 1 }, away_team: { id: 2 },
    home_team_side: ['left_to_right'],
    players: [
      {id: 'A', team_id: 1}, {id: 'CB', team_id: 2},
      {id: 'GK', team_id: 2, player_role: {name: 'Goalkeeper'}},
    ],
  };
  const frames = Array.from({ length: 21 }, (_, i) => ({
    frame: i, period: 1, possession: { player_id: 'A' }, ball_data: {x: i / 10, y: 2},
    player_data: [
      {player_id: 'A', x: i / 10, y: 2}, {player_id: 'CB', x: 10 + i / 5, y: 5},
      {player_id: 'GK', x: 24, y: 0},
    ],
  }));
  const samples = plausibleSamples(frames, meta, { CB: {vmax: 4, amax: 2} });
  assert.equal(samples[2].scene, undefined);
  const sample = samples[1];
  assert.equal(sample.index, 10);
  assert.deepEqual(sample.scene.ball, {x: 2, y: 2});
  assert.equal(sample.scene.attackers[0].x, 2);
  const back = sample.scene.defenders.find(p => p.id === 'CB');
  assert.ok(Math.abs(back.reachable[0].x - 14) < 1e-9);
  assert.equal(back.reachable[0].y, 5);
  for (const point of back.reachable) {
    assert.ok(Math.hypot(point.x - 14, point.y - 5) <= 1 + 1e-9);
    assert.ok(Math.hypot(2 * (point.x - 12) - 2, 2 * (point.y - 5)) <= 4 + 1e-9);
  }
  const result = optimizeDefense({ ...sample.scene, metric: 'epv' }, fitted, {direction: 'minimum'});
  const { id, ...destination } = result.minimum.defenders.find(p => p.id === 'CB');
  assert.ok(back.reachable.some(p => p.x === destination.x && p.y === destination.y));
});

test('plausible playback holds at each recommendation and splits the pause into fade and draw', () => {
  const stops = [{ index: 0, arrows: ['first'] }, { index: 10, arrows: ['second'] }];
  const first = plausiblePlaybackStep(stops, null, 0, 0, 0);
  assert.equal(first.waiting, true);
  assert.equal(plausiblePlaybackStep(stops, first.hold, 0, 5, 1999).index, 0);
  assert.equal(plausiblePlaybackStep(stops, first.hold, 0, 5, 2000).index, 5);
  const next = plausiblePlaybackStep(stops, first.hold, 5, 12, 2500);
  assert.equal(next.index, 10);
  assert.deepEqual(plausibleArrowPhase(next.hold, 3000), { arrows: ['first'], opacity: 0.5, progress: 1 });
  assert.deepEqual(plausibleArrowPhase(next.hold, 4000), { arrows: ['second'], opacity: 1, progress: 0.5 });
  assert.deepEqual(plausibleArrowPhase(next.hold, 4500), { arrows: ['second'], opacity: 1, progress: 1 });
});
