import { distributionEntropy, markovState, stateLabels, transitionMatrix } from './markov.js';

const percent = value => new Intl.NumberFormat('en', {
  style: 'percent', maximumFractionDigits: 1,
}).format(value);

export function createMarkovView(get, element) {
  let fit, pending, lastKey, roster, previousMeta;
  const mode = element('markovMode');
  const horizon = element('markovHorizon');
  const target = element('markovTarget');
  const output = element('markovOutput');

  function showFit(data) {
    const { selected, holdout, training, validation } = data;
    element('markovFit').textContent =
      `Nine training matches · ${selected.cadence / 10} s observation interval · ` +
      `${selected.priorSeconds} s prior exposure · ${selected.rateScale}× rate scaling · ` +
      `cross-validated log loss ${selected.logLoss.toFixed(3)}`;
    element('markovHoldout').textContent = `Held out ${holdout.fixture} · ${holdout.date.slice(0, 10)}`;
    element('markovTraining').textContent = training.map(match =>
      `${match.date.slice(0, 10)} · ${match.fixture}`).join(' | ');
    element('markovValidation').replaceChildren(...validation.map(result => {
      const row = document.createElement('tr');
      [`${result.seconds} s`, result.chain.count.toLocaleString('en'), result.chain.logLoss.toFixed(3),
        result.frequency.logLoss.toFixed(3), result.direct.logLoss.toFixed(3)].forEach(value => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      });
      return row;
    }));
  }

  function load(onReady) {
    if (fit || pending) return pending;
    element('markovSnapshot').textContent = 'Loading fitted transition rates…';
    pending = get('/markov-fit.json').then(data => {
      fit = data;
      target.replaceChildren(...stateLabels.map((label, index) => new Option(label, String(index))));
      target.value = '2';
      showFit(data);
      onReady();
    }).catch(() => {
      element('markovSnapshot').textContent = 'The fit could not load. Switch views and try again.';
    }).finally(() => { pending = null; });
    return pending;
  }

  function render(frame, meta) {
    if (!fit) return;
    if (meta !== previousMeta) {
      previousMeta = meta;
      roster = new Map((meta?.players ?? []).map(player => [player.id, player.team_id]));
    }
    const state = markovState(frame, meta, roster);
    const seconds = Number(horizon.value);
    const backward = mode.value === 'backward';
    const terminal = Number(target.value);
    element('markovTargetField').hidden = !backward;
    element('markovSeconds').textContent = `${seconds} s`;
    const key = [state, seconds, backward, terminal].join(':');
    if (key === lastKey) return;
    lastKey = key;
    element('markovSnapshot').textContent = state == null
      ? 'Current frame has no usable state. Select a tracked frame.'
      : `Current state · ${stateLabels[state]}`;
    const transition = transitionMatrix(fit.rates, seconds);
    const probabilities = backward ? transition.map(row => row[terminal]) : transition[state];
    if (!probabilities) {
      output.replaceChildren();
      element('markovReadout').textContent = '';
      return;
    }
    element('markovReadout').textContent = backward
      ? state == null ? 'Rows show the chance of the target from each possible starting state.'
        : `Chance of the target from the current state · ${percent(probabilities[state])}`
      : `Forecast uncertainty · ${distributionEntropy(probabilities).toFixed(2)} bits`;
    output.replaceChildren(...probabilities.map((probability, i) => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      const bar = document.createElement('meter');
      const value = document.createElement('span');
      label.textContent = stateLabels[i];
      bar.min = 0;
      bar.max = 1;
      bar.value = probability;
      bar.setAttribute('aria-label', stateLabels[i]);
      value.textContent = percent(probability);
      row.append(label, bar, value);
      return row;
    }));
  }

  return { load, render };
}
