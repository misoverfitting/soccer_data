// Pitch control, value and carry models: a line-for-line port of Sections 2–4c of
// notebooks/defensive_shape_integrity.ipynb (pitch_control, time_to_reach, context_value, carry_options).
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
export const NO_CARRY = -1;         // marks cells no carry can reach (nobody on the ball, v0, or beyond the longest carries)

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

  /** v2 value: location value × multiplier for the defensive situation at each point (Section 4b). */
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

  /**
   * Compute one model version for one frame.
   * s: {n, x, y, vx, vy, vmax, amax, att, ball:[x, y], carrier?} in the attacking frame; carrier = index of the player
   *    in possession, or −1/undefined to use the attacker within 1.5 m of the ball.
   * version: 'v0' (literature settings, location-only value, passes only) or
   *          'v2' (fitted settings, context value, passes and carries).
   * Returns Float64Arrays over the 105 × 68 grid (row = y): pAtt, pSucc, value, gain (best of pass or carry),
   * gainPass, pKeep (0 without carries), keepView (P_keep, or NO_CARRY where no carry is possible), protect;
   * and vBall, integrity, carrier (index or −1).
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
    return {pAtt, pSucc, value, gain, gainPass, pKeep: car ? car.pKeep : pKeep0, keepView: car ? car.keepView : view0,
            vBall, protect, integrity,
            carrier: car ? car.carrier : -1};
  }

  /**
   * Integrity I = protection (Section 5 of the notebook, definition chosen in Section 8b):
   * how well the defence denies passes (and, in v2, carries) into the valuable space between the ball and goal.
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
