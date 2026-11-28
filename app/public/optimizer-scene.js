import { possessionSource } from './possession.js';

export function optimizerSnapshot(frames, index, meta, physical) {
  const frame = frames[index];
  const source = possessionSource(frames, index);
  const possession = frames[source.index]?.possession;
  const roster = new Map(meta.players.map(player => [player.id, player]));
  const team = roster.get(possession?.player_id)?.team_id
    ?? ({ 'home team': meta.home_team.id, 'away team': meta.away_team.id })[possession?.group];
  if (team == null) return { team, reason: 'Attacking team unavailable for this frame.' };

  const { pitch_length: pitchLength, pitch_width: pitchWidth } = meta;
  const length = pitchLength / 2;
  const width = pitchWidth / 2;
  const onPitch = p => Number.isFinite(p?.x) && Number.isFinite(p?.y)
    && Math.abs(p.x) <= length && Math.abs(p.y) <= width;
  const tracked = new Map((frame.player_data ?? []).filter(p => roster.has(p.player_id)).map(p => [p.player_id, p]));
  const attack = [...tracked.values()].filter(p => roster.get(p.player_id).team_id === team);
  const defenders = [...tracked.keys()].filter(id => roster.get(id).team_id !== team);
  const homeSide = meta.home_team_side?.[frame.period - 1];
  if (!['right_to_left', 'left_to_right'].includes(homeSide)) return { team, reason: 'Attacking direction unavailable.' };
  const right = (homeSide === 'left_to_right') === (team === meta.home_team.id);
  const keeperId = defenders.find(id => roster.get(id).player_role?.name === 'Goalkeeper');
  const keeper = tracked.get(keeperId);
  if (!onPitch(keeper)) return { team, reason: 'Tracked goalkeeper position unavailable on the pitch.' };
  const keeperBounds = { minX: keeper.x, maxX: keeper.x, minY: keeper.y, maxY: keeper.y };
  const ball = frame.ball_data;
  if (!onPitch(ball) || !attack.length || !attack.every(onPitch)) {
    return { team, reason: 'On-pitch ball and attacker positions are required.' };
  }
  const profiles = defenders.map(id => ({ id, ...physical?.[id], ...(id === keeperId ? { gk: true, bounds: keeperBounds } : {}) }));
  // attacker velocities from the tracked frames 0.2 s either side (as the viewer model does), for free-attacker danger
  const near = offset => frames[index + offset]?.period === frame.period
    && Math.abs(frames[index + offset].frame - frame.frame) <= 2 ? frames[index + offset] : frame;
  const lo = near(-2), hi = near(2), dt = (hi.frame - lo.frame) / 10;
  const at = (f, id) => (f.player_data ?? []).find(p => p.player_id === id);
  const velocity = p => {
    const a = at(lo, p.player_id) ?? p, b = at(hi, p.player_id) ?? p;
    return dt > 0 ? { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt } : { vx: 0, vy: 0 };
  };
  const isKeeper = id => roster.get(id).player_role?.name === 'Goalkeeper';
  // Include the tracked formation as a starting point if it satisfies the same constraints as the search.
  const positions = defenders.map(id => tracked.get(id));
  const usableStart = positions.every((p, i) => onPitch(p)
    && positions.every((q, j) => i === j || Math.hypot(p.x - q.x, p.y - q.y) >= 0.75));
  return {
    team, keeper: { id: keeperId, x: keeper.x, y: keeper.y },
    scene: {
      pitchLength, pitchWidth, attackDirection: right ? 'right' : 'left',
      attackers: attack.map(p => ({ x: p.x, y: p.y, ...velocity(p), ...physical?.[p.player_id],
        ...(isKeeper(p.player_id) ? { gk: true } : {}) })),
      ball: { x: ball.x, y: ball.y },
      defenders: profiles.map((p, i) => usableStart ? { ...p, x: positions[i].x, y: positions[i].y } : p),
    },
  };
}
