import { entityMarginal, jointSnapshot, latentMean, nextCellProbability, sampleJointFrame } from './joint-markov.js';
import { spatialTarget } from './spatial-markov-view.js';
import { focusLabel, spatialEntities } from './spatial-markov.js';
import { passInTransit } from './pass-value.js';

const percent = value => new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 }).format(value);

export function createJointMarkovView(get, element) {
  let fit, pending, previousMeta, previousFrame, previousEarlier, roster, snapshot, mean;
  let selectedId, heatmap, nextFrame, target;
  let ballPhase, flightHeatmap;
  let stopFrames, stopMeta, stopPassing, stops;
  const entity = element('markovJointEntity');
  const status = element('markovJointStatus');
  const readout = element('markovJointReadout');
  const scenario = element('markovJointScenario');
  const showSamples = element('markovJointShowSamples');

  function load(onReady) {
    if (fit || pending) return pending;
    status.textContent = 'Loading the fitted joint model…';
    pending = get('/joint-markov-fit.json').then(data => {
      const score = data.validation;
      element('markovJointFit').textContent =
        `${data.trainingCount.toLocaleString('en')} complete training transitions across nine matches.`;
      element('markovJointHoldout').textContent =
        `Held out ${data.holdout.fixture}. Scored ${score.complete.toLocaleString('en')} of ${score.eligible.toLocaleString('en')} one-second windows with a complete formation and ball.`;
      element('markovJointRmse').textContent =
        `2D position RMSE · outfield ${score.playerRmse.toFixed(2)} m vs ${score.playerPersistence.toFixed(2)} m staying put · ball ${score.ballRmse.toFixed(2)} m vs ${score.ballPersistence.toFixed(2)} m staying put.`;
      element('markovJointScore').textContent =
        `Joint Gaussian log loss per coordinate · ${score.loss.toFixed(3)} vs ${score.diagonalLoss.toFixed(3)} with the same forecast means and independent noise. Lower is better.`;
      fit = data;
      onReady();
    }).catch(() => {
      status.textContent = 'The joint fit could not load. Switch views and try again.';
    }).finally(() => { pending = null; });
    return pending;
  }

  function render(frames, index, meta, backward, phase = { mode: 'joint' }) {
    ballPhase = phase;
    flightHeatmap = null;
    if (phase.mode === 'pass') {
      const p = phase.success;
      const peak = { x: Math.floor(phase.next.x), y: Math.floor(phase.next.y), p };
      flightHeatmap = { cells: [peak], peak };
    }
    const frame = frames[index], earlier = frames[index - 10];
    if (meta !== previousMeta || frame !== previousFrame || earlier !== previousEarlier) {
      if (meta !== previousMeta) roster = new Map((meta?.players ?? []).map(player => [player.id, player]));
      previousMeta = meta;
      previousFrame = frame;
      previousEarlier = earlier;
      snapshot = frame && earlier?.period === frame.period && earlier.frame === frame.frame - 10
        ? jointSnapshot(spatialEntities(frame, roster), spatialEntities(earlier, roster), meta, frame.period) : null;
      mean = null;
      heatmap = null;
      const selected = entity.value;
      const tracked = spatialEntities(frame, roster).sort((a, b) =>
        Number(b.kind === 'ball') - Number(a.kind === 'ball') || a.name.localeCompare(b.name));
      const ids = tracked.map(point => point.id);
      const options = Array.from(entity.options);
      if (ids.join() !== options.map(option => option.value).join()) {
        entity.replaceChildren(...tracked.map(point => new Option(focusLabel(point), point.id)));
        if (ids.includes(selected)) entity.value = selected;
      }
      entity.disabled = !tracked.length;
    }
    element('markovJointTargetField').hidden = !backward;
    element('markovJointScenarioField').hidden = !showSamples.checked;
    scenario.disabled = !fit || !snapshot;
    if (!fit) return;
    if (!snapshot) {
      status.textContent = phase.mode === 'pass' ? 'Pass in transit · projected from the recorded release.'
        : 'Focus is available now. Forecasts start once a full tracked frame has one second of history.';
      selectedId = entity.value;
      target = backward && meta ? spatialTarget(Number(element('markovJointTarget').value), meta.pitch_length, meta.pitch_width) : null;
      readout.textContent = phase.mode === 'pass' && selectedId === 'ball' ? flightReadout(phase) : '';
      element('markovJointLegend').hidden = true;
      return;
    }
    mean ??= latentMean(fit, snapshot);
    const focusIndex = Math.max(0, snapshot.points.findIndex(point => point.id === entity.value));
    const focus = snapshot.points[focusIndex];
    const { pitch_length: length, pitch_width: width } = meta;
    target = backward ? spatialTarget(Number(element('markovJointTarget').value), length, width) : null;
    if (!heatmap || selectedId !== focus.id) {
      selectedId = focus.id;
      const marginal = entityMarginal(fit, snapshot, mean, focusIndex);
      const radiusX = 7 * Math.sqrt(marginal.varianceX) + 0.5;
      const radiusY = 7 * Math.sqrt(marginal.varianceY) + 0.5;
      const cells = [];
      let onPitch = 0, peak;
      for (let x = Math.ceil(Math.max(-length / 2 - 0.5, marginal.x - radiusX)); x + 0.5 < length / 2 && x <= marginal.x + radiusX; x++) {
        for (let y = Math.ceil(Math.max(-width / 2 - 0.5, marginal.y - radiusY)); y + 0.5 < width / 2 && y <= marginal.y + radiusY; y++) {
          const cell = { x, y, p: nextCellProbability(marginal, x, y) };
          cells.push(cell);
          onPitch += cell.p;
          if (!peak || cell.p > peak.p) peak = cell;
        }
      }
      heatmap = { cells, peak, onPitch };
    }
    const seed = (frame.frame * 2654435761 + Number(scenario.value) * 1597334677) >>> 0;
    nextFrame = sampleJointFrame(fit, snapshot, mean, seed);
    const sampled = nextFrame[focusIndex];
    element('markovJointScenarioNumber').textContent = scenario.value;
    status.textContent = `Complete snapshot · 20 outfield players and the ball · ${focus.name} in cell (${focus.cell.x}, ${focus.cell.y})`;
    if (focus.kind === 'ball' && phase.mode !== 'joint') {
      readout.textContent = phase.mode === 'pass' ? flightReadout(phase)
        : 'Ball forecast unavailable without possession or a usable tracked pass release.';
      return;
    }
    readout.textContent = target
      ? `${percent(heatmap.cells.reduce((mass, { x, y, p }) =>
        x + 0.5 >= target.xMin && x + 0.5 < target.xMax && y + 0.5 >= target.yMin && y + 0.5 < target.yMax
          ? mass + p : mass, 0))} chance that ${focus.name} is in the target after 1 s.`
      : `In this sampled frame, ${focus.name} moves to (${sampled.x}, ${sampled.y}) at (${sampled.vx}, ${sampled.vy}) m/s.`;
    readout.textContent += ` Off-pitch probability ${percent(Math.min(1, Math.max(0, 1 - heatmap.onPitch)))}.`;
  }

  function flightReadout(phase) {
    const source = phase.annotationTarget ? 'recorded intended receiver' : 'top modeled option';
    return `Pass toward ${phase.receiver} (${source}) · ${percent(phase.success)} modeled completion · projected +1 s cell (${Math.floor(phase.next.x)}, ${Math.floor(phase.next.y)}).`;
  }

  function playbackStops(frames, meta, passes) {
    if (!fit) return [];
    if (frames === stopFrames && meta === stopMeta && passes === stopPassing) return stops;
    stopFrames = frames;
    stopMeta = meta;
    stopPassing = passes;
    const players = new Map(meta.players.map(player => [player.id, player]));
    const first = frames[0].frame;
    stops = frames.flatMap((frame, index) => {
      const pass = passInTransit(passes, frame);
      if (pass?.release === frame.frame && index < frames.length - 1) return [{ index }];
      if (pass) return [];
      const before = frames[index - 10], after = frames[index + 10];
      if ((frame.frame - first) % 10 !== 0 || before?.period !== frame.period || after?.period !== frame.period
        || before.frame !== frame.frame - 10 || after.frame !== frame.frame + 10) return [];
      return jointSnapshot(spatialEntities(frame, players), spatialEntities(before, players), meta, frame.period)
        ? [{ index }] : [];
    });
    return stops;
  }

  function projection() {
    if (!snapshot && !flightHeatmap) return null;
    const isBall = selectedId === 'ball';
    const displayed = isBall && ballPhase.mode !== 'joint' ? flightHeatmap : snapshot ? heatmap : null;
    return { snapshot, heatmap: displayed, nextFrame: snapshot ? nextFrame : [], target, selectedId, ballPhase };
  }

  function paint(ctx, px, scale, length, width, teamColour, layer, opacity = 1) {
    const peak = layer?.heatmap?.peak?.p;
    element('markovJointLegend').hidden = !peak || !opacity;
    if (peak && opacity) {
      element('markovJointLegendMid').textContent = percent(peak / 2);
      element('markovJointLegendMax').textContent = percent(peak);
    }
    if (!layer || !opacity) return;
    const { snapshot, heatmap, nextFrame, target, selectedId, ballPhase } = layer;
    ctx.save();
    ctx.beginPath();
    ctx.rect(...px(-length / 2, width / 2), length * scale, width * scale);
    ctx.clip();
    for (const { x, y, p } of heatmap?.cells ?? []) {
      if (p < heatmap.peak.p / 300 || !p) continue;
      const relative = p / heatmap.peak.p;
      ctx.fillStyle = `hsl(${120 * relative} 85% 53%)`;
      ctx.globalAlpha = opacity * (0.30 + 0.55 * Math.sqrt(relative));
      ctx.fillRect(...px(x, y + 1), scale, scale);
    }
    ctx.globalAlpha = opacity;
    if (target) {
      ctx.strokeStyle = '#90ead0';
      ctx.strokeRect(...px(target.xMin, target.yMax), (target.xMax - target.xMin) * scale, (target.yMax - target.yMin) * scale);
    }
    if (ballPhase.mode === 'pass') {
      const { release, target: receiver, next } = ballPhase;
      ctx.strokeStyle = '#9cf0cb';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(...px(release.x, release.y));
      ctx.lineTo(...px(receiver.x, receiver.y));
      ctx.stroke();
      ctx.setLineDash([]);
      if (showSamples.checked) {
        const [x, y] = px(next.x, next.y);
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
      }
    }
    for (const [i, result] of (showSamples.checked ? nextFrame : []).entries()) {
      if (i === 0 && ballPhase.mode !== 'joint') continue;
      const start = snapshot.points[i];
      const [x, y] = px(result.x + 0.5, result.y + 0.5);
      const selected = start.id === selectedId;
      ctx.strokeStyle = selected ? '#ffdc90' : i === 0 ? '#fff' : teamColour(start.team);
      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(...px(start.x, start.y));
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
    }
    ctx.restore();
  }

  return { load, render, paint, projection, playbackStops };
}
