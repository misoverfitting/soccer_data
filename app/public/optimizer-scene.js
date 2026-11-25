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
  const keeper = defenders.find(id => roster.get(id).player_role?.name === 'Goalkeeper') ?? 'GK';
  if (!defenders.includes(keeper)) defenders.push(keeper);
  const depth = Math.min(16.5, pitchLength);
  const halfBox = Math.min(20.16, width);
  const keeperBounds = {
    minX: right ? length - depth : -length,
    maxX: right ? length : -length + depth,
    minY: -halfBox, maxY: halfBox,
  };
  const ball = frame.ball_data;
  if (!onPitch(ball) || !attack.length || !attack.every(onPitch)) {
    return { team, reason: 'On-pitch ball and attacker positions are required.' };
  }
  const profiles = defenders.map(id => ({ id, ...physical?.[id], ...(id === keeper ? { bounds: keeperBounds } : {}) }));
  // Include the tracked formation as a starting point if it satisfies the same constraints as the search.
  const positions = defenders.map(id => tracked.get(id));
  const usableStart = positions.every((p, i) => onPitch(p) && (defenders[i] !== keeper
    || (p.x >= keeperBounds.minX && p.x <= keeperBounds.maxX && Math.abs(p.y) <= halfBox))
    && positions.every((q, j) => i === j || (q && Math.hypot(p.x - q.x, p.y - q.y) >= 0.75)));
  return {
    team, keeper,
    scene: {
      pitchLength, pitchWidth, attackDirection: right ? 'right' : 'left',
      attackers: attack.map(({ x, y, player_id }) => ({ x, y, ...physical?.[player_id] })),
      ball: { x: ball.x, y: ball.y },
      defenders: profiles.map((p, i) => usableStart ? { ...p, x: positions[i].x, y: positions[i].y } : p),
    },
  };
}
