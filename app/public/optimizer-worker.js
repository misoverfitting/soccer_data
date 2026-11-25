import { optimizeDefense } from './defensive-position-optimizer.js';

self.onmessage = ({ data: { scene, fitted } }) => {
  try {
    const direction = scene.metric === 'integrity' ? 'maximum' : 'minimum';
    self.postMessage({ result: optimizeDefense(scene, fitted, { direction })[direction] });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
