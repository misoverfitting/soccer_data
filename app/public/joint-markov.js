import { gridCell } from './grid-markov.js';
import { normalCdf } from './spatial-markov.js';

export const entityCount = 21;
export const featureCount = 1 + 4 * entityCount + 20;

export function jointSnapshot(current, previous, meta, period) {
  if (current.length !== entityCount || previous.length !== entityCount) return null;
  const direction = meta.home_team_side?.[period - 1];
  if (!['left_to_right', 'right_to_left'].includes(direction)) return null;
  const flip = direction === 'left_to_right' ? 1 : -1;
  const prior = new Map(previous.map(point => [point.id, gridCell(point)]));
  const points = current.filter(point => prior.has(point.id)).map(point => {
    const cell = gridCell(point), before = prior.get(point.id);
    return { ...point, cell, vx: flip * (cell.x - before.x), vy: cell.y - before.y };
  });
  const ball = points.find(point => point.kind === 'ball');
  const byDepth = (a, b) => flip * (a.cell.x - b.cell.x) || a.cell.y - b.cell.y || a.id.localeCompare(b.id);
  const home = points.filter(point => point.team === meta.home_team.id && point.kind === 'player').sort(byDepth);
  const away = points.filter(point => point.team === meta.away_team.id && point.kind === 'player').sort((a, b) => byDepth(b, a));
  if (!ball || home.length !== 10 || away.length !== 10) return null;
  const ordered = [ball, ...home, ...away];
  const motion = ordered.flatMap(point => [
    flip * (point.cell.x + 0.5) / (meta.pitch_length / 2), (point.cell.y + 0.5) / (meta.pitch_width / 2),
    point.vx / (point.kind === 'ball' ? 18 : 5), point.vy / (point.kind === 'ball' ? 18 : 5),
  ]);
  const ballDistances = ordered.slice(1).map(point =>
    Math.hypot(point.cell.x - ball.cell.x, point.cell.y - ball.cell.y) / meta.pitch_length);
  return { flip, points: ordered, features: [1, ...motion, ...ballDistances] };
}

export function latentMean(fit, snapshot) {
  return fit.coefficients.map(row => row.reduce((sum, weight, i) => sum + weight * snapshot.features[i], 0));
}

// One normal vector drives the entire frame. The Cholesky factor couples its
// player and ball innovations before displacements are rounded to grid cells.
export function sampleJointFrame(fit, snapshot, mean, seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 0.5) / 2 ** 32;
  };
  const normal = [];
  for (let i = 0; i < mean.length; i += 2) {
    const magnitude = Math.sqrt(-2 * Math.log(uniform())), angle = 2 * Math.PI * uniform();
    normal.push(magnitude * Math.cos(angle), magnitude * Math.sin(angle));
  }
  const steps = fit.factor.map((row, i) =>
    Math.round(row.reduce((sum, coefficient, j) => sum + coefficient * normal[j], mean[i])));
  return snapshot.points.map((point, i) => {
    const x = point.cell.x + snapshot.flip * steps[2 * i], y = point.cell.y + steps[2 * i + 1];
    return { id: point.id, x, y, vx: x - point.cell.x, vy: y - point.cell.y };
  });
}

export function entityMarginal(fit, snapshot, mean, entityIndex) {
  const x = 2 * entityIndex, y = x + 1;
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
  const rowX = fit.factor[x], rowY = fit.factor[y], cell = snapshot.points[entityIndex].cell;
  return {
    x: cell.x + snapshot.flip * mean[x], y: cell.y + mean[y],
    varianceX: dot(rowX, rowX), varianceY: dot(rowY, rowY), covariance: snapshot.flip * dot(rowX, rowY),
  };
}

const quadrature = [
  [-0.9061798459, 0.2369268851], [-0.5384693101, 0.4786286705],
  [0, 0.5688888889], [0.5384693101, 0.4786286705], [0.9061798459, 0.2369268851],
];

export function nextCellProbability(marginal, x, y) {
  const sigmaX = Math.sqrt(marginal.varianceX);
  const lo = (x - 0.5 - marginal.x) / sigmaX, hi = (x + 0.5 - marginal.x) / sigmaX;
  const middle = (hi + lo) / 2, radius = (hi - lo) / 2;
  const scale = marginal.covariance / sigmaX;
  const sigmaY = Math.sqrt(marginal.varianceY - scale * scale);
  // Integrate the X density against Y's conditional cell probability.
  return radius * quadrature.reduce((sum, [node, weight]) => {
    const z = middle + radius * node;
    const meanY = marginal.y + scale * z;
    const massY = normalCdf((y + 0.5 - meanY) / sigmaY) - normalCdf((y - 0.5 - meanY) / sigmaY);
    return sum + weight * Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * massY;
  }, 0);
}
