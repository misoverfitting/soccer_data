import { passInTransit, passValue, passValueFeatures } from './pass-value.js';

export function createPassValueView(get, element) {
  let fit, pending, cachedFrames, cachedMeta, cachedPassing, values, bounds;
  const canvas = element('markovPassChart');
  const output = element('markovPassValue');

  function load(onReady) {
    if (fit || pending) return pending;
    output.textContent = 'Loading passing-value fit…';
    pending = get('/pass-value-fit.json').then(data => {
      fit = data;
      element('markovPassValidation').textContent =
        `${fit.trainingCount.toLocaleString('en')} of ${fit.trainingTotal.toLocaleString('en')} training frames had usable possession and a passing target. Held-out error against the existing pass evaluator: ${fit.validation.rmse.toFixed(3)} EPV, versus ${fit.validation.baseline.toFixed(3)} for a constant training mean.`;
      onReady();
    }).catch(() => {
      output.textContent = 'Passing-value fit unavailable. Switch views and try again.';
    }).finally(() => { pending = null; });
    return pending;
  }

  function render(frames, index, meta, data) {
    if (!fit || !frames.length) return;
    if (cachedFrames !== frames || cachedMeta !== meta || cachedPassing !== data) {
      cachedFrames = frames;
      cachedMeta = meta;
      cachedPassing = data;
      const roster = new Map(meta.players.map(player => [player.id, player]));
      values = frames.map(frame => passInTransit(data?.passes, frame) ? null
        : passValue(fit, passValueFeatures(frame, meta, roster)));
      const numeric = values.filter(Number.isFinite);
      bounds = [Math.min(-0.005, ...numeric), Math.max(0.005, ...numeric)];
    }
    const value = values[index];
    const label = value == null ? 'Unavailable during transit or without tracked possession'
      : `${value >= 0 ? '+' : ''}${value.toFixed(3)} EPV`;
    output.textContent = label;
    canvas.setAttribute('aria-label', `Passing advantage by clip time. Current value: ${label}.`);
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const left = 45, right = width - 12, top = 13, bottom = height - 24;
    const duration = Math.max(1, frames.at(-1).frame - frames[0].frame);
    const x = frame => left + (frame - frames[0].frame) * (right - left) / duration;
    const y = number => bottom - (number - bounds[0]) / (bounds[1] - bounds[0]) * (bottom - top);
    ctx.font = '11px system-ui';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#b7cdd3';
    for (const number of [bounds[0], 0, bounds[1]]) {
      ctx.strokeStyle = number === 0 ? '#718990' : '#34474f';
      ctx.beginPath();
      ctx.moveTo(left, y(number));
      ctx.lineTo(right, y(number));
      ctx.stroke();
      ctx.fillText(number.toFixed(3), left - 5, y(number) + 3);
    }
    ctx.textAlign = 'left';
    ctx.fillText('0 s', left, height - 6);
    ctx.textAlign = 'right';
    ctx.fillText(`${(duration / 10).toFixed(1)} s`, right, height - 6);
    ctx.strokeStyle = '#a6ead0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let contiguous = false;
    for (let i = 0; i <= index; i++) {
      if (values[i] == null) { contiguous = false; continue; }
      const xy = [x(frames[i].frame), y(values[i])];
      if (contiguous && frames[i].frame === frames[i - 1].frame + 1) ctx.lineTo(...xy);
      else ctx.moveTo(...xy);
      contiguous = true;
    }
    ctx.stroke();
    const cursor = x(frames[index].frame);
    ctx.strokeStyle = '#e7c47b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cursor, top);
    ctx.lineTo(cursor, bottom);
    ctx.stroke();
    if (value != null) {
      ctx.fillStyle = '#ffdc90';
      ctx.beginPath();
      ctx.arc(cursor, y(value), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return { load, render };
}
