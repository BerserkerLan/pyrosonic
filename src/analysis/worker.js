import { analyzeAudio } from './analyze.js';

/** Runs the (CPU-heavy) song analysis off the main thread. */
self.onmessage = (e) => {
  const { id, channels, sampleRate } = e.data || {};
  try {
    let last = 0;
    const result = analyzeAudio({ channels, sampleRate }, (stage, p) => {
      const now = performance.now();
      if (now - last > 40 || p >= 1) {
        last = now;
        self.postMessage({ id, type: 'progress', stage, p });
      }
    });
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
