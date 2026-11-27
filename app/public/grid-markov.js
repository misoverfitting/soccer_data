export const cellKey = (x, y) => `${x},${y}`;
export const gridCell = ({ x, y }) => ({ x: Math.floor(x), y: Math.floor(y) });

export function gridState(point, earlier, length, width) {
  const { x, y } = gridCell(point), prior = gridCell(earlier);
  const third = (cell, extent) => cell + 0.5 < -extent / 6 ? 0 : cell + 0.5 < extent / 6 ? 1 : 2;
  return { x, y, vx: x - prior.x, vy: y - prior.y, zone: 3 * third(y, width) + third(x, length) };
}

export const velocityKey = ({ vx, vy }, bin) =>
  cellKey(Math.round(vx / bin), Math.round(vy / bin));

export function gridTransition(model, state) {
  const key = velocityKey(state, model.bin);
  const velocity = model.velocity[key];
  const local = model.local?.[`${state.zone}:${key}`];
  const prior = model.global;
  const tailScale = model.tailScale;
  const tailRatio = Math.exp(-1 / tailScale);
  const tailConstant = ((1 - tailRatio) / (1 + tailRatio)) ** 2;
  const velocityWeight = (velocity?.n ?? 0) / ((velocity?.n ?? 0) + model.alpha);
  const localWeight = local ? local.n / (local.n + model.zonePrior) : 0;
  return (dx, dy) => {
    const next = cellKey(dx, dy);
    const tail = tailConstant * Math.exp(-(Math.abs(dx) + Math.abs(dy)) / tailScale);
    const global = ((prior.outcomes[next] ?? 0) + tail) / (prior.n + 1);
    const conditional = (1 - velocityWeight) * global + (velocity ? (velocity.outcomes[next] ?? 0) /
      (velocity.n + model.alpha) : 0);
    return (1 - localWeight) * conditional + (local ? (local.outcomes[next] ?? 0) / (local.n + model.zonePrior) : 0);
  };
}
