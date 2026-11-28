// Carries (defensive_shape_integrity.ipynb Section 4c): Pitch Tiles must reproduce the notebook's P_keep, carry gain
// and choice of carrier. Reference: the model viewer's notebook fixtures (model_viewer/scripts/make_fixtures.py),
// which store every player in the attacking frame and the notebook's v3 surfaces on a sample of grid cells.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {buildIntegrity} from '../public/integrity.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const fit = read('../../notebooks/fitted/carry_model.json');
const fitted = {settings: read('../../notebooks/fitted/pitch_control_settings.json').settings,
                valueModel: read('../../notebooks/fitted/value_model.json'),
                carryModel: {hazard: fit.hazard, carry_speed: fit.carry_speed, def_delay: fit.def_delay, fracs: fit.fracs,
                             max_duration_s: fit.max_duration_s, ball_dist_m: 1.5}};
const cases = read('../../model_viewer/test/fixtures.json');

// One fixture as three tracking frames 0.2 s apart; the attacking team, `home`, attacks left to right.
// The notebook's carrier (from the events) becomes a player possession covering the frame.
function model(c, {carryModel = fitted.carryModel, onBall} = {}) {
  const at = sign => c.players.map(p => ({player_id: p.id, x: p.x + sign * 0.2 * p.vx, y: p.y + sign * 0.2 * p.vy}));
  const frame = n => ({frame: n, period: 1, ball_data: {x: c.ball[0], y: c.ball[1]}, possession: {group: 'home team'},
    player_data: at((n - 10) / 2)});
  const meta = {pitch_length: 105, pitch_width: 68, home_team: {id: 'home'}, away_team: {id: 'away'}, home_team_side: ['left_to_right'],
    players: c.players.map(p => ({id: p.id, team_id: p.att ? 'home' : 'away', ...(p.gk ? {player_role: {name: 'Goalkeeper'}} : {})}))};
  const physical = Object.fromEntries(c.players.map(p => [p.id, {vmax: p.vmax, amax: p.amax}]));
  onBall ??= c.carrier_id == null ? [] : [{player_id: c.carrier_id, team: 'home', start: 0, end: 20, period: 1}];
  return buildIntegrity(frame(10), frame(8), frame(12), meta, {...fitted, carryModel, onBall, physical});
}
const cellCentre = k => ({x: -52 + (k % 105), y: -33.5 + Math.floor(k / 105)});   // the notebook's grid, attacking frame

for (const c of cases) {
  test(`frame ${c.frame}: same carrier, P_keep and carry gain as the notebook (v3)`, () => {
    const m = model(c), ref = c.v3;
    assert.equal(m.carrier?.player_id ?? null, ref.carrier_id, 'same player on the ball');
    let worstKeep = 0, worstGain = 0, carryWins = 0;
    ref.cells.forEach((k, j) => {
      const v = m.evaluate(cellCentre(k));
      worstKeep = Math.max(worstKeep, Math.abs(v.keep - ref.p_keep[j]));
      if (ref.gain[j] > ref.gain_pass[j] + 1e-7) { carryWins++; worstGain = Math.max(worstGain, Math.abs(v.gainCarry - ref.gain[j])); }
      assert.equal(v.gain, Math.max(v.gainPass, v.gainCarry));
      assert.equal(v.reach, Math.max(v.success, v.keep));
    });
    console.log(`  frame ${c.frame}: worst |ΔP_keep| ${worstKeep.toExponential(1)}, carry best at ${carryWins} cells, worst |Δgain| ${worstGain.toExponential(1)}`);
    assert.ok(worstKeep < 2e-6, `P_keep differs by ${worstKeep}`);
    assert.ok(worstGain < 2e-6, `carry gain differs by ${worstGain}`);
    if (ref.carrier_id == null) assert.ok(ref.p_keep.every(x => x === 0), 'no carries with nobody on the ball');
  });
}

test('a carrier is found within 1.5 m of the ball when no possession covers the frame', () => {
  const c = cases.find(x => x.frame === 44209), ball = {x: c.ball[0], y: c.ball[1]};
  const nearest = c.players.filter(p => p.att).map(p => [p.id, Math.hypot(p.x - ball.x, p.y - ball.y)]).sort((a, b) => a[1] - b[1])[0];
  const m = model(c, {onBall: []});
  assert.equal(m.carrier?.player_id ?? null, nearest[1] <= 1.5 ? nearest[0] : null);
});

test('without a carry model the app scores passes only, as before', () => {
  const c = cases.find(x => x.frame === 44209);
  const passes = model(c, {carryModel: null}), both = model(c);
  const q = {x: c.ball[0] + 6, y: c.ball[1] + 2}, a = passes.evaluate(q), b = both.evaluate(q);
  assert.equal(a.keep, 0); assert.equal(a.gain, a.gainPass); assert.equal(a.reach, a.success);
  assert.equal(b.success, a.success); assert.equal(b.gainPass, a.gainPass);
  assert.ok(b.keep > 0.5, 'a short carry into open space is usually kept');
  // counting carries can only lower integrity and raise threat
  const ga = passes.grid(), gb = both.grid();
  assert.ok(gb.integrity <= ga.integrity + 1e-12 && gb.threat >= ga.threat - 1e-12);
});

test('pass recommendations stay passes: a named receiver never gets a carry', () => {
  const c = cases.find(x => x.frame === 44209), m = model(c), receiver = m.receivers[0];
  const v = m.evaluate({x: receiver.x, y: receiver.y}, receiver, null);
  assert.equal(v.keep, 0); assert.equal(v.gain, v.gainPass);
});
