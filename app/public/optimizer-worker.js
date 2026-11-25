import { optimizeDefense } from './defensive-position-optimizer.js';

function solve(scene, fitted) {
  const direction = scene.metric === 'integrity' ? 'maximum' : 'minimum';
  return optimizeDefense(scene, fitted, { direction })[direction];
}

self.onmessage = ({ data: { scene, scenes, fitted } }) => {
  try {
    if (!scenes) {
      self.postMessage({ result: solve(scene, fitted) });
      return;
    }
    const results = scenes.map((sample, index) => {
      try {
        return sample ? solve(sample, fitted) : null;
      } catch {
        return null;
      } finally {
        self.postMessage({ completed: index + 1 });
      }
    });
    self.postMessage({ results });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
