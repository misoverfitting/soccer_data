import { hasPosition } from './spatial-markov.js';

export function passValueFeatures(frame, meta, roster) {
  if (!hasPosition(frame?.ball_data)) return null;
  const direction = meta.home_team_side?.[frame.period - 1];
  if (!['left_to_right', 'right_to_left'].includes(direction)) return null;
  const team = roster.get(frame.possession?.player_id)?.team_id
    ?? { 'home team': meta.home_team.id, 'away team': meta.away_team.id }[frame.possession?.group];
  if (team == null) return null;
  const flip = (team === meta.home_team.id) === (direction === 'left_to_right') ? 1 : -1;
  const ball = frame.ball_data;
  const attack = [], defense = [];
  for (const point of frame.player_data ?? []) {
    const player = roster.get(point.player_id);
    if (!player || !hasPosition(point)) continue;
    const dx = flip * (point.x - ball.x), dy = (point.y - ball.y) * flip;
    const unit = { dx, dy, distance: Math.hypot(dx, dy) };
    (player.team_id === team ? attack : defense).push(unit);
  }
  if (!attack.length || !defense.length) return null;
  const x = flip * ball.x / (meta.pitch_length / 2), y = flip * ball.y / (meta.pitch_width / 2);
  const features = [1, x, y, x * x, y * y, attack.length / 11, defense.length / 11];
  for (const units of [attack, defense]) {
    units.sort((a, b) => a.distance - b.distance || a.dx - b.dx || a.dy - b.dy);
    for (let i = 0; i < 11; i++) {
      const point = units[i];
      features.push(point ? point.dx / 50 : 0, point ? point.dy / 35 : 0, point ? point.distance / 50 : 0);
    }
  }
  for (let i = 0; i < 11; i++) {
    const point = attack[i];
    const clearance = point ? Math.min(...defense.map(opponent => Math.hypot(point.dx - opponent.dx, point.dy - opponent.dy))) : 0;
    features.push(clearance / 25, point ? (point.dx / 50) * (clearance / 25) : 0);
  }
  return features;
}

export const passValue = (fit, features) => features
  ? fit.coefficients.reduce((sum, coefficient, i) => sum + coefficient * features[i], 0) : null;

export function passInTransit(passes, frame) {
  return frame && passes?.find(pass => pass.period === frame.period
    && pass.complete - pass.release <= 50
    && frame.frame >= pass.release && frame.frame < pass.complete);
}

export function passFlightPoint(release, target, event, frameNumber) {
  const t = Math.max(0, Math.min(1, (frameNumber - event.release) / Math.max(1, event.complete - event.release)));
  return { x: release.x + (target.x - release.x) * t, y: release.y + (target.y - release.y) * t };
}
