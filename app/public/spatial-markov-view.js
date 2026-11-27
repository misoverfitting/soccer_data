import { radius80, recentVelocity, rectangleProbability, spatialEntities, spatialForecast } from './spatial-markov.js';

const percent = value => Math.round(value * 100) + '%';
const metres = value => value.toFixed(1) + ' m';

export function spatialTarget(index, length, width) {
  const column = index % 3, row = Math.floor(index / 3);
  const xMin = -length / 2 + column * length / 3;
  const yMax = width / 2 - row * width / 3;
  return { xMin, xMax: xMin + length / 3, yMin: yMax - width / 3, yMax };
}

export function createSpatialMarkovView(get, element) {
  let fit, pending, previousMeta, previousFrame, roster, entities, forecasts, rectangle, focus;
  const snapshot = element('markovSpatialSnapshot');
  const entity = element('markovEntity');
  const target = element('markovSpatialTarget');

  function load(onReady) {
    if (fit || pending) return pending;
    snapshot.textContent = 'Loading the spatial model…';
    pending = get('/spatial-markov-fit.json').then(data => {
      fit = data;
      element('markovSpatialFit').textContent =
        `Fitted on nine matches. Held out ${fit.holdout.fixture} (${fit.holdout.date.slice(0, 10)}).`;
      element('markovSpatialValidation').replaceChildren(...fit.validation.flatMap(row =>
        ['player', 'ball'].map(kind => {
          const score = row[kind];
          const values = [`${row.seconds} s`, kind === 'ball' ? 'Ball' : 'Outfield',
            metres(score.rmse), metres(score.persistence), metres(score.constantVelocity), percent(score.coverage80)];
          const tr = document.createElement('tr');
          for (const value of values) {
            const td = document.createElement('td');
            td.textContent = value;
            tr.append(td);
          }
          return tr;
        })));
      onReady();
    }).catch(() => {
      snapshot.textContent = 'The spatial fit could not load. Switch views and try again.';
    }).finally(() => { pending = null; });
    return pending;
  }

  function render(frames, index, meta, seconds, backward) {
    forecasts = null;
    rectangle = null;
    if (!fit) return;
    const frame = frames[index];
    if (meta !== previousMeta) {
      previousMeta = meta;
      previousFrame = null;
      roster = new Map((meta?.players ?? []).map(player => [player.id, player]));
    }
    if (frame !== previousFrame || !entities) {
      previousFrame = frame;
      const next = spatialEntities(frame, roster);
      if (next.map(point => point.id).join() !== entities?.map(point => point.id).join()) {
        const selected = entity.value;
        entity.replaceChildren(...next.map(point => new Option(point.name, point.id)));
        if (next.some(point => point.id === selected)) entity.value = selected;
      }
      entities = next;
    }
    element('markovSpatialTargetField').hidden = !backward;
    snapshot.textContent = frame
      ? `${entities.filter(point => point.kind === 'player').length} tracked outfield players · ${entities.some(point => point.kind === 'ball') ? 'ball tracked' : 'ball unavailable'}`
      : 'Choose a tracking frame.';
    const output = element('markovSpatialReadout');
    if (!entities.length) {
      output.textContent = 'No usable positions at this frame.';
      return;
    }
    const history = new Map(Object.values(fit.parameters).map(({ lookback }) => {
      const prior = frames[index - lookback];
      const points = prior?.period === frame.period && prior.frame === frame.frame - lookback
        ? spatialEntities(prior, roster) : [];
      return [lookback, new Map(points.map(point => [point.id, point]))];
    }));
    forecasts = entities.map(point => {
      const parameters = fit.parameters[point.kind];
      const prior = history.get(parameters.lookback).get(point.id);
      const velocity = recentVelocity(point, prior, parameters.lookback / 10);
      return { point, ...spatialForecast(point, velocity, seconds, parameters), hasVelocity: Boolean(prior) };
    });
    focus = forecasts.find(item => item.point.id === entity.value) ?? forecasts[0];
    if (backward) {
      rectangle = spatialTarget(Number(target.value), meta.pitch_length, meta.pitch_width);
      output.textContent = `${focus.point.name} · ${percent(rectangleProbability(focus, rectangle))} chance of being in the shaded area at ${seconds} s`;
    } else {
      output.textContent = `${focus.point.name} · mean (${focus.x.toFixed(1)}, ${focus.y.toFixed(1)}) m · 80% radius ${metres(radius80(focus.variance))}`;
    }
    if (!focus.hasVelocity) output.textContent += ' · No recent velocity for this frame';
  }

  function paint(ctx, px, scale, length, width, playerColour) {
    if (!forecasts) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(...px(-length / 2, width / 2), length * scale, width * scale);
    ctx.clip();
    if (rectangle) {
      const { xMin, xMax, yMin, yMax } = rectangle;
      const origin = px(xMin, yMax);
      ctx.fillStyle = '#e8cd7435';
      ctx.strokeStyle = '#e8cd74';
      ctx.fillRect(...origin, (xMax - xMin) * scale, (yMax - yMin) * scale);
      ctx.strokeRect(...origin, (xMax - xMin) * scale, (yMax - yMin) * scale);
    }
    for (const forecast of forecasts) {
      const { point, x, y, variance } = forecast;
      const [cx, cy] = px(x, y);
      const selected = forecast === focus;
      const colour = selected ? '#ffdc90' : point.kind === 'ball' ? '#e1ecee' : playerColour(point.team);
      ctx.globalAlpha = selected ? 1 : 0.65;
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(...px(point.x, point.y));
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.setLineDash([]);
      if (selected && variance > 0) {
        ctx.beginPath();
        ctx.arc(cx, cy, radius80(variance) * scale, 0, Math.PI * 2);
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, selected ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  return { load, render, paint };
}
