import { optimizerSnapshot } from './optimizer-scene.js';

const framesPerSecond = 10;
export const distanceThreshold = 5;

function trackedPositions(frame) {
  return new Map((frame.player_data ?? []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map(player => [player.player_id, player]));
}

export function clipSamples(frames, meta, physical) {
  const samples = [];
  const start = frames[0].frame;
  const framesByNumber = new Map(frames.map(frame => [frame.frame, frame]));
  for (const [index, frame] of frames.entries()) {
    const second = Math.floor((frame.frame - start) / framesPerSecond);
    if (second < samples.length) continue;
    while (samples.length < second) samples.push({ second: samples.length });
    const { scene, team, keeper } = optimizerSnapshot(frames, index, meta, physical);
    const priorFrame = framesByNumber.get(frame.frame - framesPerSecond);
    samples.push({
      second, frame: frame.frame, period: frame.period, scene, team, keeper,
      tracked: trackedPositions(frame),
      priorTracked: priorFrame?.period === frame.period ? trackedPositions(priorFrame) : null,
    });
  }
  return samples;
}

export function summarizePath(samples, results) {
  return samples.map(({ scene, keeper, tracked, priorTracked, ...sample }, i) => {
    const result = results[i];
    const previous = samples[i - 1];
    const priorResult = results[i - 1];
    let movement = null;
    if (result && !i) {
      movement = { distance: 0, overThreshold: 0, players: result.defenders.length - 1 };
    } else if (result && priorResult && comparable(sample, previous)) {
      const prior = new Map(priorResult.defenders.map(player => [player.id, player]));
      const elapsed = (sample.frame - previous.frame) / framesPerSecond;
      let distance = 0, overThreshold = 0, players = 0;
      for (const player of scene.defenders) {
        if (player.id === keeper.id || player.id === previous.keeper.id || !prior.has(player.id)) continue;
        const current = result.defenders.find(p => p.id === player.id);
        const last = prior.get(player.id);
        const moved = Math.hypot(current.x - last.x, current.y - last.y);
        distance += moved;
        players++;
        if (moved > (player.vmax ?? 8) * elapsed) overThreshold++;
      }
      if (players) movement = { distance, overThreshold, players };
    }
    let offset = null, alignment = null;
    if (result && tracked) {
      let distance = 0, overThreshold = 0, players = 0;
      let alignmentSum = 0, alignedPlayers = 0;
      for (const player of result.defenders) {
        if (player.id === keeper.id || !tracked.has(player.id)) continue;
        const actual = tracked.get(player.id);
        const moved = Math.hypot(player.x - actual.x, player.y - actual.y);
        distance += moved;
        players++;
        if (moved > distanceThreshold) overThreshold++;

        const prior = priorTracked?.get(player.id);
        if (!prior) continue;
        const targetX = player.x - prior.x, targetY = player.y - prior.y;
        const targetLength = Math.hypot(targetX, targetY);
        if (!targetLength) continue;
        const actualX = actual.x - prior.x, actualY = actual.y - prior.y;
        const actualLength = Math.hypot(actualX, actualY);
        const cosine = actualLength
          ? (actualX * targetX + actualY * targetY) / (actualLength * targetLength)
          : 0;
        alignmentSum += (1 + Math.max(-1, Math.min(1, cosine))) / 2;
        alignedPlayers++;
      }
      if (players) offset = { distance, overThreshold, players };
      if (alignedPlayers) alignment = alignmentSum / alignedPlayers;
    }
    return { ...sample, keeperId: keeper?.id, result, movement, offset, alignment };
  });
}

function comparable(a, b) {
  return a.team === b.team && a.period === b.period;
}

export function pathFormation(path, frame, snapshot) {
  if (!snapshot.scene) return null;
  const second = Math.floor((frame.frame - path[0].frame) / framesPerSecond);
  const sample = path[second];
  if (!sample?.result || sample.team !== snapshot.team || sample.period !== frame.period) return null;
  const next = path[second + 1];
  const interpolate = next?.result && comparable(sample, next);
  const fraction = interpolate ? (frame.frame - sample.frame) / (next.frame - sample.frame) : 0;
  const active = new Set(snapshot.scene.defenders.map(p => p.id));
  const defenders = sample.result.defenders.filter(p => p.id !== sample.keeperId && active.has(p.id)).map(p => {
    const target = interpolate && next.result.defenders.find(q => q.id === p.id && q.id !== next.keeperId);
    return target ? { ...p, x: p.x + fraction * (target.x - p.x), y: p.y + fraction * (target.y - p.y) } : p;
  });
  return { defenders };
}

function distanceLabel(second, measurement, countLabel) {
  return measurement
    ? `${second} s · ${measurement.distance.toFixed(1)} m · ${measurement.overThreshold} of ${measurement.players} defenders ${countLabel}`
    : `${second} s · Comparison unavailable`;
}

export function drawPathChart(canvas, path, elapsed, title, { field, countLabel, alignment = false, secondsLabel = false } = {}) {
  const bars = Boolean(field);
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const left = 45, top = 12, right = width - 9, bottom = height - (secondsLabel ? 42 : 24);
  const values = path.map(p => bars ? p[field]?.distance : alignment ? p.alignment : p.result?.value);
  const min = Math.min(0, ...values.filter(Number.isFinite));
  const max = alignment ? 1 : Math.max(min + (bars ? 1 : 0.001), ...values.filter(Number.isFinite));
  const step = (right - left) / path.length;
  const x = i => left + step * (i + 0.5);
  const y = value => bottom - (bottom - top) * (value - min) / (max - min);
  ctx.font = '11px system-ui';
  ctx.fillStyle = '#b7cdd3';
  ctx.strokeStyle = '#3d535c';
  ctx.textAlign = 'right';
  const divisions = alignment ? 4 : 3;
  for (let i = 0; i <= divisions; i++) {
    const value = min + i * (max - min) / divisions;
    ctx.fillText(bars ? value.toFixed(0) : alignment ? String(value) : value.toFixed(3), left - 5, y(value) + 3);
    ctx.beginPath();
    ctx.moveTo(left, y(value));
    ctx.lineTo(right, y(value));
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  const tick = Math.max(1, Math.ceil(path.length / Math.max(1, Math.floor((right - left) / 28))));
  for (let i = 0; i < path.length; i += tick) ctx.fillText(i, x(i), bottom + 15);
  if (secondsLabel) ctx.fillText('Seconds', (left + right) / 2, height - 5);

  let previous = null;
  for (let i = 0; i <= elapsed; i++) {
    const value = values[i];
    const measurement = path[i][field];
    if (!Number.isFinite(value)) {
      if (bars) {
        ctx.fillStyle = '#586b72';
        ctx.fillRect(x(i) - step * 0.35, bottom - 2, step * 0.7, 2);
      }
      previous = null;
      continue;
    }
    if (bars) {
      const fraction = measurement.players ? measurement.overThreshold / measurement.players : 0;
      ctx.fillStyle = `hsl(${120 * (1 - fraction)} 65% 58%)`;
      ctx.fillRect(x(i) - step * 0.35, y(value) - (value === 0 ? 2 : 0), step * 0.7, Math.max(2, bottom - y(value)));
    } else {
      ctx.fillStyle = ctx.strokeStyle = '#a6ead0';
      if (previous !== null && comparable(path[i], path[i - 1])) {
        ctx.beginPath();
        ctx.moveTo(x(i - 1), y(previous));
        ctx.lineTo(x(i), y(value));
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x(i), y(value), 2, 0, Math.PI * 2);
      ctx.fill();
      previous = value;
    }
  }
  const labelAt = second => bars
    ? `${title} · ${distanceLabel(second, path[second][field], countLabel)}`
    : `${title} at ${second} s: ${Number.isFinite(values[second]) ? values[second].toFixed(3) : 'unavailable'}`;
  canvas.onpointermove = ({ offsetX }) => {
    const second = Math.floor((offsetX - left) / step);
    canvas.title = second >= 0 && second <= elapsed ? labelAt(second) : '';
  };
  const label = labelAt(elapsed);
  canvas.setAttribute('aria-label', label);
  canvas.title = label;
}
