// The JavaScript models must reproduce the notebook's Python models (fixtures from scripts/make_fixtures.py).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createModel, PROT_BEHIND_M, PROTECT_OUT} from '../public/model.js';

const models = JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url)));
const cases = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url)));
const model = createModel(models);

const toState = c => {
  const p = c.players, n = p.length, arr = k => Float64Array.from(p.map(r => r[k]));
  return {n, x: arr('x'), y: arr('y'), vx: arr('vx'), vy: arr('vy'), vmax: arr('vmax'), amax: arr('amax'),
          att: Uint8Array.from(p.map(r => r.att ? 1 : 0)), ball: c.ball,
          carrier: c.carrier_id == null ? -1 : p.findIndex(r => r.id === c.carrier_id)};
};

for (const c of cases) {
  for (const version of ['v0', 'v2']) {
    test(`frame ${c.frame} ${version} matches the Python model`, () => {
      const t0 = performance.now();
      const out = model.compute(toState(c), version);
      const ms = performance.now() - t0;
      const ref = c[version];
      const worst = {p_att: 0, p_succ: 0, p_keep: 0, value: 0, gain: 0, gain_pass: 0};
      ref.cells.forEach((k, j) => {
        worst.p_att = Math.max(worst.p_att, Math.abs(out.pAtt[k] - ref.p_att[j]));
        worst.p_succ = Math.max(worst.p_succ, Math.abs(out.pSucc[k] - ref.p_succ[j]));
        worst.p_keep = Math.max(worst.p_keep, Math.abs(out.pKeep[k] - ref.p_keep[j]));
        worst.value = Math.max(worst.value, Math.abs(out.value[k] - ref.value[j]));
        worst.gain = Math.max(worst.gain, Math.abs(out.gain[k] - ref.gain[j]));
        worst.gain_pass = Math.max(worst.gain_pass, Math.abs(out.gainPass[k] - ref.gain_pass[j]));
      });
      console.log(`  frame ${c.frame} ${version}: ${ms.toFixed(0)} ms, worst |Δ|`, Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, v.toExponential(1)])));
      assert.ok(worst.p_att < 1e-5 && worst.p_succ < 1e-5 && worst.p_keep < 1e-5, 'probabilities');
      assert.ok(worst.value < 1e-6 && worst.gain < 1e-6 && worst.gain_pass < 1e-6, 'value and gain');
      assert.ok(Math.abs(out.vBall - ref.v_ball) < 1e-6, 'ball value');
      const carrierId = out.carrier >= 0 ? c.players[out.carrier].id : null;
      assert.equal(carrierId, ref.carrier_id, 'same player on the ball');
    });

    test(`frame ${c.frame} ${version} integrity matches the notebook`, () => {
      const out = model.compute(toState(c), version), V = model.V_LOC;
      let num = 0, den = 0;
      for (let k = 0; k < model.N; k++) {
        const pAny = Math.max(out.pSucc[k], out.pKeep[k]);
        if (model.cellX[k] >= c.ball[0] - PROT_BEHIND_M) {
          num += V[k] * (1 - pAny); den += V[k];
          assert.equal(out.protect[k], 1 - pAny);
        } else assert.equal(out.protect[k], PROTECT_OUT);
      }
      assert.ok(Math.abs(out.integrity - num / den) < 1e-12, 'I = Σ V(1 − max(P_succ, P_keep)) / Σ V');
      assert.ok(Math.abs(out.integrity - c[version].integrity) < 1e-5, `notebook I ${c[version].integrity}, viewer ${out.integrity}`);
    });
  }
  test(`frame ${c.frame}: v0 has no carries, v2's gain is the better of passing and carrying`, () => {
    const s = toState(c), o0 = model.compute(s, 'v0');
    assert.ok(o0.pKeep.every(v => v === 0) && o0.carrier === -1);
    const o2 = model.compute(s, 'v2');
    for (let k = 0; k < model.N; k++) assert.ok(o2.gain[k] >= o2.gainPass[k]);
  });
}

function ref(c, version) { return c[version]; }
