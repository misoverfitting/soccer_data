// Pitch control, value and carry models: a line-for-line port of Sections 2–4c of
// notebooks/defensive_shape_integrity.ipynb (pitch_control, time_to_reach, context_value, carry_options),
// plus the danger scores of Section 8d (free_attacker_danger) and Section 8f (danger_ext: top two free attackers, 3 s ahead).
// Runs in the browser and in Node (tests compare it with the Python output in test/fixtures.json).
//
// Every computation is in the ATTACKING frame: the team in possession attacks towards +x,
// and the defending team protects the goal at x = +52.5.

const sig = z => 1 / (1 + Math.exp(-z));
const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// numpy rounds halves to the nearest even integer; match it so grid lookups agree exactly
const roundHalfEven = v => { const r = Math.round(v); return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
const FRACS = Array.from({length: 8}, (_, i) => 0.15 + i * (0.75 / 7));   // np.linspace(0.15, 0.9, 8)
export const PROT_BEHIND_M = 5;     // the protection zone starts 5 m behind the ball (notebook: CELLS[:, 0] >= ball[0] - 5)
export const PROTECT_OUT = -1;      // marks cells outside the protection zone
export const NO_CARRY = -1;         // marks cells no carry can reach (nobody on the ball, v0/v2, or beyond the longest carries)

export function createModel(models) {
  const {x0, y0, nx, ny, half_l: HALF_L} = models.grid;
  const N = nx * ny;
  const CX = new Float64Array(N), CY = new Float64Array(N);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) { CX[iy * nx + ix] = x0 + ix; CY[iy * nx + ix] = y0 + iy; }
  const VM = models.value;
  const V_LOC = Float64Array.from(VM.V_loc);
  const V_OPP = new Float64Array(N);                     // V[::-1, ::-1]: the opponent's value if the ball is lost here
  for (let k = 0; k < N; k++) V_OPP[k] = V_LOC[N - 1 - k];
  const LOFT_MIN = models.constants.LOFT_MIN_DIST;
  const COS_CONE = Math.cos(VM.cone_deg * Math.PI / 180);
  const lookup = (x, y) => {                             // value_at(): nearest grid cell, clipped to the pitch
    const ix = clip(roundHalfEven(x + HALF_L - 0.5), 0, nx - 1);
    const iy = clip(roundHalfEven(y + models.grid.half_w - 0.5), 0, ny - 1);
    return iy * nx + ix;
  };

  // buffers reused between frames, per settings version
  const buffers = {};
  const buf = (key, len) => (buffers[key] && buffers[key].length === len) ? buffers[key] : (buffers[key] = new Float64Array(len));

  /** Facing: direction of travel if moving faster than 1.5 m/s, otherwise towards the ball. */
  function facing(s) {
    const fx = new Float64Array(s.n), fy = new Float64Array(s.n);
    for (let i = 0; i < s.n; i++) {
      const moving = Math.hypot(s.vx[i], s.vy[i]) > 1.5;
      const ax = moving ? s.vx[i] : s.ball[0] - s.x[i], ay = moving ? s.vy[i] : s.ball[1] - s.y[i];
      const nrm = Math.hypot(ax, ay) + 1e-9;
      fx[i] = ax / nrm; fy[i] = ay / nrm;
    }
    return {fx, fy};
  }

  /** Arrival time of player i at (tx, ty): react, then accelerate to top speed, plus a turn penalty. */
  function arrive(s, i, f, set, tx, ty) {
    const a = s.amax[i] * set.ACC_SCALE, vm = s.vmax[i];
    const px = s.x[i] + s.vx[i] * set.T_REACT, py = s.y[i] + s.vy[i] * set.T_REACT;
    const dx = tx - px, dy = ty - py, d = Math.hypot(dx, dy);
    const dAcc = vm * vm / (2 * a);
    let t = set.T_REACT + (d < dAcc ? Math.sqrt(2 * d / a) : vm / a + (d - dAcc) / vm);
    if (d > 1.0) {
      const c = clip((dx * f.fx[i] + dy * f.fy[i]) / (d + 1e-9), -1, 1);
      t += Math.acos(c) / set.OMEGA;
    }
    return t;
  }

  /** Min arrival time over attackers and over defenders (goalkeepers included), for every cell.
   *  keepRows: also keep each defender's own grid (the carry model sums over defenders). */
  function arrivalGrids(s, set, key, keepRows = false) {
    const f = facing(s);
    const tAtt = buf(key + ':att', N), tDef = buf(key + ':def', N), defRows = [];
    tAtt.fill(Infinity); tDef.fill(Infinity);
    for (let i = 0; i < s.n; i++) {
      const target = s.att[i] ? tAtt : tDef;
      const row = keepRows && !s.att[i] ? buf(`${key}:defrow${defRows.length}`, N) : null;
      if (row) defRows.push(row);
      for (let k = 0; k < N; k++) {
        const t = arrive(s, i, f, set, CX[k], CY[k]);
        if (row) row[k] = t;
        if (t < target[k]) target[k] = t;
      }
    }
    return {tAtt, tDef, f, defRows};
  }

  /** P_att (pitch control) and P_succ (pass success) for every cell. */
  function pitchControl(s, set, key, keepRows = false) {
    const K = Math.PI / (Math.sqrt(3) * set.SIGMA);
    const {tAtt, tDef, f, defRows} = arrivalGrids(s, set, key, keepRows);
    const pAtt = buf(key + ':patt', N), pSucc = buf(key + ':psucc', N);
    const eff = (t, tb) => Math.max(t, tb) + set.TIE_BREAK * t;
    const [bx, by] = s.ball;
    for (let k = 0; k < N; k++) {
      const dist = Math.hypot(CX[k] - bx, CY[k] - by);
      const tb = dist / set.V_BALL;
      const pa = sig(K * (eff(tDef[k], tb) - eff(tAtt[k], tb)));
      pAtt[k] = pa;
      // interception: can a defender reach a point on the ball's path before the ball?
      let pInt = 0;
      for (const fr of FRACS) {
        const qx = bx + fr * (CX[k] - bx), qy = by + fr * (CY[k] - by);
        const dq = Math.hypot(qx - bx, qy - by);
        if (dq > 2.0) pInt = Math.max(pInt, sig(K * (dq / set.V_BALL - tDef[lookup(qx, qy)])));
      }
      const pGround = (1 - pInt) * pa;
      // lofted alternative: no interception, slower ball, harder first touch
      let pLoft = 0;
      if (dist > LOFT_MIN) {
        const tl = dist / set.V_LOFT + set.T_HANG;
        pLoft = set.LOFT_CONTROL * sig(K * (eff(tDef[k], tl) - eff(tAtt[k], tl)));
      }
      pSucc[k] = Math.max(pGround, pLoft);
    }
    return {pAtt, pSucc, tDef, f, defRows};
  }

  /** v2/v3 value: location value × multiplier for the defensive situation at each point (Section 4b). */
  function contextValueAt(s, px, py, pressureT, base) {
    let nearest = Infinity, ahead = 0;
    const gx = HALF_L - px, gy = -py, dGoal = Math.hypot(gx, gy);
    for (let i = 0; i < s.n; i++) {
      if (s.att[i]) continue;
      const dx = s.x[i] - px, dy = s.y[i] - py, d = Math.hypot(dx, dy);
      if (d < nearest) nearest = d;
      const cos = (dx * gx + dy * gy) / (d * dGoal + 1e-9);
      const closer = Math.hypot(s.x[i] - HALF_L, s.y[i]) < dGoal;
      if (cos > COS_CONE && closer) ahead++;
    }
    const F = [clip(pressureT, 0, VM.pressure_cap_s), Math.log1p(clip(nearest, 0, VM.nearest_cap_m)), ahead];
    const close = Math.exp(-dGoal / VM.near_goal_scale_m);
    let z = VM.intercept;
    for (let j = 0; j < 3; j++) z += VM.coef[j] * F[j] + VM.coef[j + 3] * F[j] * close;
    return base * Math.exp(z);
  }

  /**
   * Carries (Section 4c, carry_options): the chance the player on the ball keeps it running to each cell, and the
   * gain of doing so. Survival model: the risk of losing the ball per second is BASE + RATE · Σ_defenders
   * σ(k·(MARGIN − time the defender still needs to reach the carrier)), summed along a straight run.
   * Returns null when there is no carrier (nobody on the ball).
   */
  const CM = models.carry || null;
  const carriesOn = version => !!CM && CM.versions.includes(version);
  function findCarrier(s) {
    if (s.carrier != null && s.carrier >= 0 && s.carrier < s.n) return s.carrier;
    let best = -1, bd = CM.ball_dist_m;
    for (let i = 0; i < s.n; i++) {
      if (!s.att[i]) continue;
      const d = Math.hypot(s.x[i] - s.ball[0], s.y[i] - s.ball[1]);
      if (d <= bd) { bd = d; best = i; }
    }
    return best;
  }
  function carry(s, set, key, defRows, value, vBall) {
    const r = findCarrier(s);
    if (r < 0) return null;
    const pKeep = buf(key + ':pkeep', N), gainC = buf(key + ':gaincarry', N), view = buf(key + ':keepview', N);
    const H = CM.hazard, kH = Math.PI / (Math.sqrt(3) * H.SIGMA), F = CM.fracs, J = F.length, D = defRows.length;
    const px = s.x[r], py = s.y[r], vx = s.vx[r], vy = s.vy[r];
    const vm = s.vmax[r] * CM.carry_speed, am = s.amax[r] * set.ACC_SCALE, dAcc = vm * vm / (2 * am);
    const moving = Math.hypot(vx, vy) > 1.5, nv = Math.hypot(vx, vy) + 1e-9;
    const fx = moving ? vx / nv : 0, fy = moving ? vy / nv : 0;         // as in the fit: no facing when standing
    const carrierTime = (tx, ty) => {                                     // no reaction delay, slower with the ball
      const dx = tx - px, dy = ty - py, d = Math.hypot(dx, dy);
      let t = d < dAcc ? Math.sqrt(2 * d / am) : vm / am + (d - dAcc) / vm;
      if (d > 1.0) t += Math.acos(clip((dx * fx + dy * fy) / (d + 1e-9), -1, 1)) / set.OMEGA;
      return t;
    };
    const tc = new Float64Array(J), lam = new Float64Array(J), seg = new Float64Array(J);
    for (let k = 0; k < N; k++) {
      for (let j = 0; j < J; j++) {
        const qx = px + F[j] * (CX[k] - px), qy = py + F[j] * (CY[k] - py);
        tc[j] = carrierTime(qx, qy);
        const c = lookup(qx, qy);
        let contest = 0;
        for (let d = 0; d < D; d++) contest += sig(kH * (H.MARGIN - (defRows[d][c] + CM.def_delay - tc[j])));
        lam[j] = H.BASE + H.RATE * contest;
      }
      let haz = 0;
      for (let j = 1; j < J; j++) { seg[j] = 0.5 * (lam[j] + lam[j - 1]) * Math.max(0, tc[j] - tc[j - 1]); haz += seg[j]; }
      if (tc[J - 1] > CM.max_duration_s) { pKeep[k] = 0; gainC[k] = -Infinity; view[k] = NO_CARRY; continue; }
      const pk = Math.exp(-haz);
      let vOpp = 0;                                                        // where the ball is lost, if it is
      for (let j = 1; j < J; j++) {
        const mf = 0.5 * (F[j] + F[j - 1]);
        vOpp += seg[j] / (haz + 1e-12) * V_OPP[lookup(px + mf * (CX[k] - px), py + mf * (CY[k] - py))];
      }
      pKeep[k] = pk; view[k] = pk;
      gainC[k] = pk * value[k] - (1 - pk) * vOpp - vBall;
    }
    return {pKeep, gainCarry: gainC, keepView: view, carrier: r};
  }

  /** Minimum-cost assignment of rows to columns (rows ≤ columns), like scipy's linear_sum_assignment. Returns col per row. */
  function assign(cost, nr, nc) {
    const u = new Float64Array(nr + 1), v = new Float64Array(nc + 1), p = new Int32Array(nc + 1), way = new Int32Array(nc + 1);
    for (let i = 1; i <= nr; i++) {
      p[0] = i; let j0 = 0;
      const minv = new Float64Array(nc + 1).fill(Infinity), used = new Uint8Array(nc + 1);
      do {
        used[j0] = 1; const i0 = p[j0]; let delta = Infinity, j1 = 0;
        for (let j = 1; j <= nc; j++) if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= nc; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const colOf = new Int32Array(nr).fill(-1);
    for (let j = 1; j <= nc; j++) if (p[j] > 0) colOf[p[j] - 1] = j - 1;
    return colOf;
  }

  /**
   * Danger: how dangerous are the attackers the defence has left free?
   * Each outfield attacker except the one nearest the ball is projected `ahead` seconds ahead (position + velocity).
   * Outfield defenders are assigned one attacker each (minimum total arrival time). An attacker is covered if their
   * defender arrives within ball travel + T_CONTROL, halved if the defender is not goal-side. Each attacker's share is
   * V × (1 − covered), with V the version's value (context value in v2/v3, location value in v0), and the score is the
   * sum of the `top` largest shares.
   *   Section 8d (free_attacker_danger, free_ctx_1s): ahead = 1, top = 1 → the most dangerous free attacker in 1 s.
   *   Section 8f (danger_ext, free_top2_3s):          ahead = 3, top = 2 → the two most dangerous free attackers in 3 s.
   * Returns {danger, who, list}: who = state indices of the top attackers (most dangerous first);
   * list = per attacker {i, x, y, contrib, def}.
   */
  const T_CONTROL = models.constants.T_CONTROL ?? 1.0, HALF_W = models.grid.half_w;
  const DANGER_8D = {ahead: 1, top: 1}, DANGER_EXT = {ahead: 3, top: 2};
  function danger(s, set, f, value, {ahead, top}) {
    const gk = s.gk || new Uint8Array(s.n);
    const att = [], dfs = [];
    for (let i = 0; i < s.n; i++) (s.att[i] ? att : dfs).push(i);
    const atts = att.filter(i => !gk[i]), defs = dfs.filter(i => !gk[i]);
    if (!atts.length) return {danger: NaN, who: [], list: []};
    let near = atts[0], nd = Infinity;
    for (const i of atts) { const d = Math.hypot(s.x[i] - s.ball[0], s.y[i] - s.ball[1]); if (d < nd) { nd = d; near = i; } }
    const tg = atts.filter(i => i !== near);
    const ax = tg.map(i => clip(s.x[i] + ahead * s.vx[i], -HALF_L + 0.5, HALF_L - 0.5));
    const ay = tg.map(i => clip(s.y[i] + ahead * s.vy[i], -HALF_W + 0.5, HALF_W - 0.5));
    const T = defs.map(d => tg.map((_, a) => arrive(s, d, f, set, ax[a], ay[a])));
    const defOf = new Int32Array(tg.length).fill(-1);
    if (defs.length && tg.length) {
      if (defs.length <= tg.length) assign(T, defs.length, tg.length).forEach((a, d) => { if (a >= 0) defOf[a] = d; });
      else assign(tg.map((_, a) => defs.map((_, d) => T[d][a])), tg.length, defs.length).forEach((d, a) => { defOf[a] = d; });
    }
    const K = Math.PI / (Math.sqrt(3) * set.SIGMA);
    const list = tg.map((i, a) => {
      let cov = 0; const d = defOf[a];
      if (d >= 0) {
        const di = defs[d], tBall = Math.hypot(ax[a] - s.ball[0], ay[a] - s.ball[1]) / set.V_BALL;
        const goalSide = (HALF_L - ax[a]) * (s.x[di] - ax[a]) + (0 - ay[a]) * (s.y[di] - ay[a]) > 0;
        cov = sig(K * (tBall + T_CONTROL - T[d][a])) * (goalSide ? 1 : 0.5);
      }
      const contrib = value[lookup(ax[a], ay[a])] * (1 - cov);
      return {i, x: ax[a], y: ay[a], contrib, def: d >= 0 ? defs[d] : -1};
    });
    // the `top` largest shares, most dangerous first (a stable sort keeps the first attacker on ties, like the notebook's argmax)
    const ranked = list.map((a, k) => k).sort((p, q) => list[q].contrib - list[p].contrib).slice(0, top);
    const D = ranked.reduce((sum, k) => sum + list[k].contrib, 0);
    return {danger: tg.length ? D : NaN, who: ranked.map(k => list[k].i), list};
  }

  /**
   * Compute one model version for one frame.
   * s: {n, x, y, vx, vy, vmax, amax, att, ball:[x, y], carrier?} in the attacking frame; carrier = index of the player
   *    in possession, or −1/undefined to use the attacker within 1.5 m of the ball.
   * version: 'v0' (literature settings, location-only value, passes only),
   *          'v2' (fitted settings, context value, passes only) or
   *          'v3' (v2 plus carries).
   * Returns Float64Arrays over the 105 × 68 grid (row = y): pAtt, pSucc, value, gain (best of pass or carry),
   * gainPass, pKeep (0 without carries), keepView (P_keep, or NO_CARRY where no carry is possible), protect;
   * and vBall, integrity, danger (8d, + dangerWho, dangerList), dangerExt (8f, + dangerExtWho = the top two, dangerExtList),
   * carrier (index or −1).
 * s.gk (optional): 1 for goalkeepers, who are left out of the danger scores as in the notebook.
   */
  function compute(s, version) {
    const set = models.settings[version], withCarry = carriesOn(version);
    const {pAtt, pSucc, tDef, f, defRows} = pitchControl(s, set, version, withCarry);
    const value = buf(version + ':value', N), gain = buf(version + ':gain', N);
    let vBall;
    if (version === 'v0') {
      value.set(V_LOC);
      vBall = V_LOC[lookup(s.ball[0], s.ball[1])];
    } else {
      for (let k = 0; k < N; k++) value[k] = contextValueAt(s, CX[k], CY[k], tDef[k], V_LOC[k]);
      let tb = Infinity;
      for (let i = 0; i < s.n; i++) if (!s.att[i]) tb = Math.min(tb, arrive(s, i, f, set, s.ball[0], s.ball[1]));
      vBall = contextValueAt(s, s.ball[0], s.ball[1], tb, V_LOC[lookup(s.ball[0], s.ball[1])]);
    }
    const gainPass = buf(version + ':gainpass', N), pKeep0 = buf(version + ':pkeep0', N), view0 = buf(version + ':view0', N);
    for (let k = 0; k < N; k++) gainPass[k] = pSucc[k] * value[k] - (1 - pSucc[k]) * V_OPP[k] - vBall;
    const car = withCarry ? carry(s, set, version, defRows, value, vBall) : null;
    const pAny = buf(version + ':pany', N);
    for (let k = 0; k < N; k++) {
      gain[k] = car ? Math.max(gainPass[k], car.gainCarry[k]) : gainPass[k];
      pAny[k] = car ? Math.max(pSucc[k], car.pKeep[k]) : pSucc[k];
    }
    if (!car) { pKeep0.fill(0); view0.fill(NO_CARRY); }
    const {protect, integrity} = protection(s, pAny, version);
    const dz = danger(s, set, f, value, DANGER_8D), dx = danger(s, set, f, value, DANGER_EXT);
    return {pAtt, pSucc, value, gain, gainPass, pKeep: car ? car.pKeep : pKeep0, keepView: car ? car.keepView : view0,
            vBall, protect, integrity, danger: dz.danger, dangerWho: dz.who[0] ?? -1, dangerList: dz.list,
            dangerExt: dx.danger, dangerExtWho: dx.who, dangerExtList: dx.list,
            carrier: car ? car.carrier : -1};
  }

  /**
   * Integrity I = protection (Section 5 of the notebook, definition chosen in Section 8b):
   * how well the defence denies passes (and, in v3, carries) into the valuable space between the ball and goal.
   *   zone: cells at most 5 m behind the ball, up to the goal line ("ballgoal")
   *   I = Σ_zone V_loc · (1 − P_any) / Σ_zone V_loc,   P_any = max(P_succ, P_keep)
   * Both versions weight by the location value V_loc, as the notebook does.
   * protect[k] = 1 − P_any inside the zone, PROTECT_OUT outside it.
   */
  function protection(s, pSucc, key) {
    const protect = buf(key + ':protect', N), x0 = s.ball[0] - PROT_BEHIND_M;
    let num = 0, den = 0;
    for (let k = 0; k < N; k++) {
      if (CX[k] >= x0) { const deny = 1 - pSucc[k]; protect[k] = deny; num += V_LOC[k] * deny; den += V_LOC[k]; }
      else protect[k] = PROTECT_OUT;
    }
    return {protect, integrity: den > 0 ? num / den : NaN};
  }

  return {compute, grid: models.grid, N, cellX: CX, cellY: CY, lookup, V_LOC, carriesOn};
}
