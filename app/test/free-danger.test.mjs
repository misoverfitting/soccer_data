// Extended danger (defensive_shape_integrity.ipynb Section 8f: the two most dangerous free attackers, 3 s ahead)
// must reproduce the notebook. The reference states and values are the model viewer's notebook fixtures
// (model_viewer/scripts/make_fixtures.py), which store every player in the attacking frame with velocities.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {buildIntegrity, FREE_DANGER} from '../public/integrity.js';
import {optimizeDefense} from '../public/defensive-position-optimizer.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const fitted = {settings: read('../../notebooks/fitted/pitch_control_settings.json').settings,
                valueModel: read('../../notebooks/fitted/value_model.json')};
const cases = read('../../model_viewer/test/fixtures.json');

// One fixture as three tracking frames (0.2 s apart) in which the attacking team, `home`, attacks left to right.
function model(c) {
  const at = sign => c.players.map(p => ({player_id: p.id, x: p.x + sign * 0.2 * p.vx, y: p.y + sign * 0.2 * p.vy}));
  const frame = n => ({frame: n, period: 1, ball_data: {x: c.ball[0], y: c.ball[1]}, possession: {player_id: c.carrier_id, group: 'home team'},
    player_data: at((n - 10) / 2)});
  const meta = {pitch_length: 105, pitch_width: 68, home_team: {id: 'home'}, away_team: {id: 'away'}, home_team_side: ['left_to_right'],
    players: c.players.map(p => ({id: p.id, team_id: p.att ? 'home' : 'away', ...(p.gk ? {player_role: {name: 'Goalkeeper'}} : {})}))};
  const physical = Object.fromEntries(c.players.map(p => [p.id, {vmax: p.vmax, amax: p.amax}]));
  return buildIntegrity(frame(10), frame(8), frame(12), meta, {...fitted, physical});
}

test('the default is Section 8f: top two free attackers, 3 s ahead', () => {
  assert.deepEqual(FREE_DANGER, {ahead: 3, top: 2});
});

for (const c of cases) {
  test(`frame ${c.frame}: extended danger matches the notebook`, () => {
    const d = model(c).freeDanger();
    assert.ok(Math.abs(d.danger - c.v3.danger_ext) < 1e-6, `notebook ${c.v3.danger_ext}, app ${d.danger}`);
    assert.deepEqual(d.who.map(m => m.attacker.player_id), c.v3.danger_ext_who, 'same two free attackers');
    assert.equal(d.danger, d.who[0].share + d.who[1].share);
  });
  test(`frame ${c.frame}: with one attacker, 1 s ahead, it is Section 8d's score`, () => {
    const d = model(c).freeDanger({ahead: 1, top: 1});
    assert.ok(Math.abs(d.danger - c.v3.danger) < 1e-6, `notebook ${c.v3.danger}, app ${d.danger}`);
    assert.equal(d.who[0].attacker.player_id, c.v3.danger_who);
  });
}

test('the optimizer scores free-attacker danger with attacker velocities and lowers it', () => {
  const c = cases.find(x => x.frame === 44209);
  const physical = p => ({vmax: p.vmax, amax: p.amax, ...(p.gk ? {gk: true} : {})});
  const attackers = c.players.filter(p => p.att).map(p => ({x: p.x, y: p.y, vx: p.vx, vy: p.vy, ...physical(p)}));
  const keeper = c.players.find(p => !p.att && p.gk);
  const outfield = c.players.filter(p => !p.att && !p.gk);
  const scene = {metric: 'FreeDanger', attackers, ball: {x: c.ball[0], y: c.ball[1]}, restarts: 1,
    defenders: [{id: keeper.id, x: keeper.x, y: keeper.y, bounds: {minX: keeper.x, maxX: keeper.x, minY: keeper.y, maxY: keeper.y}, ...physical(keeper)},
                ...outfield.map(p => ({id: p.id, x: p.x, y: p.y, ...physical(p)}))]};
  // the tracked formation, scored by the optimizer, is the notebook's value for a defence at rest
  const pinned = {...scene, defenders: scene.defenders.map(d => ({...d, reachable: [{x: d.x, y: d.y}]}))};
  const tracked = optimizeDefense(pinned, fitted, {direction: 'minimum'}).minimum.value;
  assert.ok(Number.isFinite(tracked) && tracked > 0);
  const best = optimizeDefense(scene, fitted, {direction: 'minimum'}).minimum;
  assert.ok(best.value <= tracked + 1e-12, `optimum ${best.value} vs tracked ${tracked}`);
  // velocities matter: the same scene with attackers standing still scores differently
  const still = optimizeDefense({...pinned, attackers: attackers.map(({vx, vy, ...p}) => p)}, fitted, {direction: 'minimum'}).minimum.value;
  assert.notEqual(still, tracked);
});
