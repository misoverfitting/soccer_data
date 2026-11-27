export const stateLabels = [
  'Home · defensive third', 'Home · middle third', 'Home · attacking third',
  'Away · defensive third', 'Away · middle third', 'Away · attacking third',
  'No recorded possession',
];

export function markovState(frame, meta, roster) {
  if (!frame || frame.timestamp == null) return null;
  const team = roster.get(frame.possession?.player_id)
    ?? { 'home team': meta.home_team.id, 'away team': meta.away_team.id }[frame.possession?.group];
  if (team == null) return 6;
  const direction = meta.home_team_side?.[frame.period - 1];
  const x = frame.ball_data?.x;
  if (!Number.isFinite(x) || !['left_to_right', 'right_to_left'].includes(direction)) return null;
  const home = team === meta.home_team.id;
  const progress = x * ((direction === 'left_to_right') === home ? 1 : -1);
  const third = meta.pitch_length / 6;
  return (home ? 0 : 3) + (progress < -third ? 0 : progress < third ? 1 : 2);
}

const matrix = (n, entry) => Array.from({ length: n }, (_, i) =>
  Array.from({ length: n }, (_, j) => entry(i, j)));
const multiply = (a, b) => matrix(a.length, (i, j) =>
  a[i].reduce((sum, value, k) => sum + value * b[k][j], 0));

// Uniformization sums Poisson-weighted powers of the embedded transition
// matrix. Squaring keeps that series numerically stable at longer horizons.
export function transitionMatrix(generator, seconds) {
  const size = generator.length;
  const identity = matrix(size, (i, j) => Number(i === j));
  const rate = Math.max(...generator.map((row, i) => -row[i]));
  if (!rate || !seconds) return identity;
  const steps = Math.max(0, Math.ceil(Math.log2(rate * seconds / 12)));
  const mean = rate * seconds / 2 ** steps;
  const embedded = matrix(size, (i, j) => identity[i][j] + generator[i][j] / rate);
  let power = identity, weight = Math.exp(-mean);
  let result = matrix(size, (i, j) => weight * identity[i][j]);
  for (let k = 1; k <= 60; k++) {
    power = multiply(power, embedded);
    weight *= mean / k;
    result = matrix(size, (i, j) => result[i][j] + weight * power[i][j]);
    if (k > mean && weight < 1e-15) break;
  }
  for (let i = 0; i < steps; i++) result = multiply(result, result);
  return result.map(row => {
    const total = row.reduce((sum, value) => sum + value, 0);
    return row.map(value => value / total);
  });
}

export function distributionEntropy(probabilities) {
  return probabilities.reduce((sum, p) => p > 0 ? sum - p * Math.log2(p) : sum, 0);
}
