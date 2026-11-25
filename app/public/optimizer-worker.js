import { optimizeDefense } from './defensive-position-optimizer.js';

self.onmessage = ({ data: { scene, fitted } }) => {
  try {
    const direction = scene.metric === 'danger' ? 'minimum' : 'maximum';
    self.postMessage({ result: optimizeDefense(scene, fitted, { direction })[direction] });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
