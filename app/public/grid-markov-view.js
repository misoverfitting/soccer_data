import { gridState, gridTransition } from './grid-markov.js';
import { spatialTarget } from './spatial-markov-view.js';
import { spatialEntities } from './spatial-markov.js';

const percent = value => new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 }).format(value);

export function createGridMarkovView(get, element) {
  let fit, pending, previousMeta, roster, previousFrame, points = [], distribution;
  const entity = element('markovGridEntity');
  const status = element('markovGridStatus');
  const readout = element('markovGridReadout');

  function load(onReady) {
    if (fit || pending) return pending;
    status.textContent = 'Loading the fitted grid model…';
    pending = get('/grid-markov-fit.json').then(data => {
      fit = data;
      element('markovGridFit').textContent = `Nine training matches. Held out ${data.holdout.fixture}.`;
      element('markovGridValidation').replaceChildren(...['player', 'ball'].map(kind => {
        const model = data.models[kind], score = data.validation[kind];
        const row = document.createElement('tr');
        const values = [kind === 'ball' ? 'Ball' : 'Outfield', score.count.toLocaleString('en'),
          score.logLoss.toFixed(3), score.baselineLoss.toFixed(3)];
        for (const value of values) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        element(kind === 'ball' ? 'markovGridBallSettings' : 'markovGridPlayerSettings').textContent =
          `${model.bin} m/s velocity bins · ${model.alpha} prior counts · ${model.zonePrior ? 'pitch-zone conditioning' : 'pooled across the pitch'}`;
        return row;
      }));
      onReady();
    }).catch(() => {
      status.textContent = 'The grid fit could not load. Switch views and try again.';
    }).finally(() => { pending = null; });
    return pending;
  }

  function render(frames, index, meta, backward) {
    distribution = null;
    if (!fit) return;
    const frame = frames[index];
    if (meta !== previousMeta) {
      previousMeta = meta;
      previousFrame = null;
      roster = new Map((meta?.players ?? []).map(player => [player.id, player]));
    }
    if (frame !== previousFrame) {
      previousFrame = frame;
      const next = spatialEntities(frame, roster);
      if (next.map(point => point.id).join() !== points.map(point => point.id).join()) {
        const selected = entity.value;
        entity.replaceChildren(...next.map(point => new Option(point.name, point.id)));
        if (next.some(point => point.id === selected)) entity.value = selected;
      }
      points = next;
    }
    element('markovGridTargetField').hidden = !backward;
    const point = points.find(candidate => candidate.id === entity.value);
    const before = frames[index - 10];
    const earlier = frame && before?.period === frame.period && before.frame === frame.frame - 10
      ? spatialEntities(before, roster).find(candidate => candidate.id === point?.id) : null;
    if (!point || !earlier) {
      status.textContent = point ? 'Select a frame at least one second into the clip with both positions tracked.'
        : 'No tracked outfield player or ball at this frame.';
      readout.textContent = '';
      return;
    }
    const { pitch_length: length, pitch_width: width } = meta;
    const state = gridState(point, earlier, length, width);
    const probability = gridTransition(fit.models[point.kind], state);
    const target = backward ? spatialTarget(Number(element('markovGridTarget').value), length, width) : null;
    const cells = [];
    let onPitch = 0, inTarget = 0, peak;
    for (let x = Math.ceil(-length / 2 - 0.5); x + 0.5 < length / 2; x++) {
      for (let y = Math.ceil(-width / 2 - 0.5); y + 0.5 < width / 2; y++) {
        const p = probability(x - state.x, y - state.y);
        const cell = { x, y, p };
        cells.push(cell);
        onPitch += p;
        if (!peak || p > peak.p) peak = cell;
        if (target && x + 0.5 >= target.xMin && x + 0.5 < target.xMax
          && y + 0.5 >= target.yMin && y + 0.5 < target.yMax) inTarget += p;
      }
    }
    distribution = { cells, peak, state, target };
    status.textContent = `${point.name} · cell (${state.x}, ${state.y}) · velocity (${state.vx}, ${state.vy}) m/s`;
    readout.textContent = backward
      ? `${percent(inTarget)} chance of being in the shaded region after 1 s.`
      : `Most likely on-pitch cell (${peak.x}, ${peak.y}) · ${percent(peak.p)} · next velocity (${peak.x - state.x}, ${peak.y - state.y}) m/s.`;
    readout.textContent += ` Off-pitch probability ${percent(Math.max(0, 1 - onPitch))}.`;
  }

  function paint(ctx, px, scale, length, width) {
    if (!distribution) return;
    const { cells, peak, state, target } = distribution;
    ctx.save();
    ctx.beginPath();
    ctx.rect(...px(-length / 2, width / 2), length * scale, width * scale);
    ctx.clip();
    ctx.fillStyle = '#ffbc62';
    for (const { x, y, p } of cells) {
      if (p < peak.p / 300) continue;
      ctx.globalAlpha = 0.8 * Math.sqrt(p / peak.p);
      // Fill the entire meter cell, using its upper-left corner on the canvas.
      ctx.fillRect(...px(x, y + 1), scale, scale);
    }
    ctx.globalAlpha = 1;
    if (target) {
      ctx.fillStyle = '#8edac32b';
      ctx.strokeStyle = '#8edac3';
      ctx.fillRect(...px(target.xMin, target.yMax), (target.xMax - target.xMin) * scale, (target.yMax - target.yMin) * scale);
      ctx.strokeRect(...px(target.xMin, target.yMax), (target.xMax - target.xMin) * scale, (target.yMax - target.yMin) * scale);
    }
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(...px(state.x, state.y + 1), scale, scale);
    ctx.restore();
  }

  return { load, render, paint };
}
