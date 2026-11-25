import { buildIntegrity } from './integrity.js';

const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function randomSequence(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function gridPoints(length, width, step) {
  // Subsample the same cell centers as the viewer, including at noninteger pitch sizes.
  const points = [];
  for (let row = Math.floor(step / 2); row < Math.ceil(width); row += step) {
    for (let col = Math.floor(step / 2); col < Math.ceil(length); col += step) {
      points.push({ x: col + 0.5 - length / 2, y: width / 2 - row - 0.5 });
    }
  }
  return points;
}

export function optimizeDefense(scene, fitted, { direction = 'both' } = {}) {
  const {
    attackers, ball, metric, defenders = Array.from({ length: 11 }, () => ({})),
    pitchLength = 105, pitchWidth = 68, attackDirection = 'right',
    seed = 1, restarts = 3, searchGridStep = Math.min(5, Math.floor(pitchLength), Math.floor(pitchWidth)), minSpacing = 0.75,
  } = scene;
  const objective = String(metric).toLowerCase();
  if (!['integrity', 'danger', 'epv'].includes(objective)) {
    throw new Error('Metric must be Integrity, Danger, or EPV');
  }
  if (!['right', 'left'].includes(attackDirection)
      || ![pitchLength, pitchWidth].every(n => Number.isFinite(n) && n >= 1 && n <= 150)
      || !Number.isSafeInteger(seed) || !Number.isInteger(restarts) || restarts < 1 || restarts > 30
      || !Number.isInteger(searchGridStep) || searchGridStep < 1 || searchGridStep > Math.min(pitchLength, pitchWidth)
      || !Number.isFinite(minSpacing) || minSpacing < 0) {
    throw new Error('Invalid pitch or search settings');
  }
  const pitch = { minX: -pitchLength / 2, maxX: pitchLength / 2, minY: -pitchWidth / 2, maxY: pitchWidth / 2 };
  const inBounds = (p, b) => p?.x >= b.minX && p?.x <= b.maxX && p?.y >= b.minY && p?.y <= b.maxY
    && Number.isFinite(p.x) && Number.isFinite(p.y);
  if (!Array.isArray(attackers) || !attackers.length || !attackers.every(p => inBounds(p, pitch))
      || !Array.isArray(defenders) || !defenders.length || !inBounds(ball, pitch)) {
    throw new Error('Supply on-pitch ball and attacker coordinates and at least one defender');
  }
  const bounds = defenders.map((p, i) => {
    const b = { ...pitch, ...p.bounds };
    if (!inBounds({ x: b.minX, y: b.minY }, pitch)
        || !inBounds({ x: b.maxX, y: b.maxY }, pitch) || b.minX > b.maxX || b.minY > b.maxY) {
      throw new Error('Invalid bounds for defender ' + (i + 1));
    }
    return b;
  });
  const reachable = defenders.map((defender, i) => {
    const points = defender.reachable;
    if (points && (!points.length || !points.every(point => inBounds(point, bounds[i])))) {
      throw new Error('Reachable positions must be on the pitch');
    }
    return points;
  });
  const players = [...attackers, ...defenders];
  const physical = Object.fromEntries(players.map((p, i) => {
    const { vmax = 8, amax = 5 } = p;
    if (![vmax, amax].every(n => Number.isFinite(n) && n > 0)) {
      throw new Error('Player speed and acceleration must be positive');
    }
    return [i, { vmax, amax }];
  }));
  const flip = attackDirection === 'right' ? 1 : -1;
  const meta = {
    pitch_length: pitchLength, pitch_width: pitchWidth,
    home_team: { id: 0 }, away_team: { id: 1 },
    home_team_side: [flip === 1 ? 'left_to_right' : 'right_to_left'],
    players: players.map((_, id) => ({ id, team_id: id < attackers.length ? 0 : 1 })),
  };
  const data = { ...fitted, physical };
  const frame = {
    frame: 0, period: 1, ball_data: ball, possession: { group: 'home team' },
    player_data: attackers.map(({ x, y }, player_id) => ({ x, y, player_id })),
  };
  const searchPoints = objective === 'epv' ? [] : gridPoints(pitchLength, pitchWidth, searchGridStep);
  const finalPoints = objective === 'epv' ? [] : gridPoints(pitchLength, pitchWidth, 1);
  let evaluations = 0;
  function score(layout, points) {
    evaluations++;
    const defenderData = layout.map(({ x, y }, i) => ({ x, y, player_id: attackers.length + i }));
    const model = buildIntegrity({ ...frame, player_data: [...frame.player_data, ...defenderData] }, null, null, meta, data);
    if (model.reason) throw new Error(model.reason);
    if (objective === 'epv') return model.ballValue;
    if (objective === 'danger') {
      let peak = -Infinity;
      for (const q of points) peak = Math.max(peak, model.evaluate(q).gain);
      return peak;
    }
    let denied = 0;
    let total = 0;
    for (const q of points) {
      if (q.x * flip < ball.x * flip - 5) continue;
      const weight = model.location(q);
      denied += weight * (1 - model.evaluate(q).success);
      total += weight;
    }
    if (!(total > 0)) throw new Error('No positive location value on the integrity grid');
    return denied / total;
  }

  const spaced = (point, layout, index) => layout.every((p, i) => i === index || distance(p, point) >= minSpacing);
  const random = randomSequence(seed);
  const initialProvided = defenders.some(p => p.x !== undefined || p.y !== undefined);
  const initial = initialProvided ? defenders.map(({ x, y }) => ({ x, y })) : null;
  if (initial && !initial.every((p, i) => inBounds(p, bounds[i]) && spaced(p, initial, i))) {
    throw new Error('Initial coordinates must be supplied for every defender and satisfy bounds and spacing');
  }

  function randomLayout() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const layout = [];
      for (const [index, b] of bounds.entries()) {
        for (let draw = 0; draw < 100; draw++) {
          const points = reachable[index];
          const point = points ? points[attempt === 0 && draw === 0 ? 0 : Math.floor(random() * points.length)]
            : { x: b.minX + random() * (b.maxX - b.minX), y: b.minY + random() * (b.maxY - b.minY) };
          if (!spaced(point, layout, -1)) continue;
          layout.push(point);
          break;
        }
        if (layout.length < index + 1) break;
      }
      if (layout.length === defenders.length) return layout;
    }
    throw new Error('Could not sample a feasible formation. Check player bounds and spacing or supply a feasible initial layout.');
  }

  const starts = [initial ?? randomLayout()];
  while (starts.length < restarts) starts.push(randomLayout());
  // Keep the full pitch grid as a fallback when the coarse grid misses the narrow region ahead of the ball.
  const coarse = objective === 'integrity' && !searchPoints.some(q => q.x * flip >= ball.x * flip - 5)
    ? finalPoints : searchPoints;
  const useFinal = coarse === finalPoints || searchGridStep === 1 || objective === 'epv';
  const report = (layout, value) => ({
    value,
    defenders: layout.map((p, i) => ({ id: defenders[i].id ?? i + 1, ...p })),
  });

  function coordinatedMove(layout, value, sign) {
    const alternatives = reachable.map((points, index) => {
      if (!points || points.length < 2) return [];
      return points.filter(point => distance(point, layout[index]) > 0).map(point => {
        const candidate = layout.slice();
        candidate[index] = point;
        // Keep promising moves even if they only work once a teammate moves too.
        return { point, value: score(candidate, coarse) };
      }).sort((a, b) => sign * (b.value - a.value)).slice(0, 2);
    });
    let best = { layout, value };
    for (let first = 0; first < alternatives.length; first++) {
      for (let second = first + 1; second < alternatives.length; second++) {
        for (const a of alternatives[first]) {
          for (const b of alternatives[second]) {
            const candidate = layout.slice();
            candidate[first] = a.point;
            candidate[second] = b.point;
            if (!spaced(a.point, candidate, first) || !spaced(b.point, candidate, second)) continue;
            const jointValue = score(candidate, coarse);
            if (sign * (jointValue - best.value) > 1e-12) best = { layout: candidate, value: jointValue };
          }
        }
      }
    }
    return best;
  }

  const constrainedSearch = reachable.some(Boolean);

  function search(sign) {
    let best = scoredStarts[0].layout;
    let bestValue = scoredStarts[0].value;
    const improves = (a, b) => sign * (a - b) > 1e-12;
    for (const { layout: start, value: startValue } of scoredStarts) {
      if (improves(startValue, bestValue)) {
        best = start;
        bestValue = startValue;
      }
      let layout = start.slice();
      let value = score(layout, coarse);
      for (const step of constrainedSearch ? [1] : [12, 6, 3, 1]) {
        for (let sweep = 0; sweep < 2; sweep++) {
          let changed = false;
          for (let i = 0; i < layout.length; i++) {
            const origin = layout[i];
            const b = bounds[i];
            const candidates = reachable[i] ?? directions.map(([dx, dy]) => ({
              x: clamp(origin.x + step * dx, b.minX, b.maxX),
              y: clamp(origin.y + step * dy, b.minY, b.maxY),
            }));
            for (const point of candidates) {
              if (distance(origin, point) === 0 || !spaced(point, layout, i)) continue;
              const candidate = layout.slice();
              candidate[i] = point;
              const candidateValue = score(candidate, coarse);
              if (!improves(candidateValue, value)) continue;
              layout = candidate;
              value = candidateValue;
              changed = true;
            }
          }
          if (!changed) break;
        }
      }
      let finalValue = useFinal ? value : score(layout, finalPoints);
      if (constrainedSearch) {
        const joint = coordinatedMove(layout, value, sign);
        if (joint.layout !== layout) {
          const jointValue = useFinal ? joint.value : score(joint.layout, finalPoints);
          if (improves(jointValue, finalValue)) {
            layout = joint.layout;
            finalValue = jointValue;
          }
        }
      }
      if (improves(finalValue, bestValue)) {
        best = layout;
        bestValue = finalValue;
      }
    }
    return report(best, bestValue);
  }

  const scoredStarts = starts.map(layout => ({ layout, value: score(layout, finalPoints) }));
  const maximum = direction === 'minimum' ? undefined : search(1);
  const minimum = direction === 'maximum' ? undefined : search(-1);
  return { metric: objective, maximum, minimum, evaluations };
}
