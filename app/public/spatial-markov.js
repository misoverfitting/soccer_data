export const spatialKinds = ['player', 'ball'];
export const hasPosition = point => Number.isFinite(point?.x) && Number.isFinite(point?.y);
export const focusLabel = point => point.number == null ? point.name : `#${point.number} ${point.name}`;

export function spatialEntities(frame, roster) {
  if (!frame) return [];
  const players = (frame.player_data ?? []).flatMap(point => {
    const player = roster.get(point.player_id);
    if (!player || player.player_role?.name === 'Goalkeeper' || !hasPosition(point)) return [];
    return [{
      id: String(point.player_id), kind: 'player', team: player.team_id,
      name: player.short_name ?? player.name ?? String(point.player_id), number: player.number, x: point.x, y: point.y,
    }];
  });
  return hasPosition(frame.ball_data)
    ? [{ id: 'ball', kind: 'ball', name: 'Ball', x: frame.ball_data.x, y: frame.ball_data.y }, ...players]
    : players;
}

export function recentVelocity(current, previous, seconds) {
  return previous ? { vx: (current.x - previous.x) / seconds, vy: (current.y - previous.y) / seconds }
    : { vx: 0, vy: 0 };
}

export function displacementFactor(seconds, halfLife) {
  const decay = Math.LN2 / halfLife;
  return -Math.expm1(-decay * seconds) / decay;
}

function integratedVelocityNoise(seconds, halfLife) {
  const decay = Math.LN2 / halfLife;
  const z = decay * seconds;
  if (z < 1e-3) return seconds ** 3 / 3 * (1 - 0.75 * z + 0.35 * z * z);
  return (seconds + (2 * Math.expm1(-z) - 0.5 * Math.expm1(-2 * z)) / decay) / decay ** 2;
}

// Both components are normalized to unit variance at one second.
export function positionVarianceFactor(seconds, halfLife, positionMix) {
  const acceleration = integratedVelocityNoise(seconds, halfLife) / integratedVelocityNoise(1, halfLife);
  return positionMix * seconds + (1 - positionMix) * acceleration;
}

export function spatialForecast(point, velocity, seconds, parameters) {
  const factor = displacementFactor(seconds, parameters.halfLife);
  const variance = parameters.variance * positionVarianceFactor(seconds, parameters.halfLife, parameters.positionMix);
  return { x: point.x + factor * velocity.vx, y: point.y + factor * velocity.vy, variance };
}

export const radius80 = variance => Math.sqrt(-2 * variance * Math.log(0.2));

export function normalCdf(value) {
  const t = 1 / (1 + 0.2316419 * Math.abs(value));
  const tail = Math.exp(-(value ** 2) / 2) / Math.sqrt(2 * Math.PI)
    * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value < 0 ? tail : 1 - tail;
}

export function rectangleProbability(forecast, rectangle) {
  const { xMin, xMax, yMin, yMax } = rectangle;
  const { x, y, variance } = forecast;
  if (!variance) return Number(x >= xMin && x <= xMax && y >= yMin && y <= yMax);
  const sd = Math.sqrt(variance);
  const mass = (min, max, mean) => normalCdf((max - mean) / sd) - normalCdf((min - mean) / sd);
  return mass(xMin, xMax, x) * mass(yMin, yMax, y);
}
