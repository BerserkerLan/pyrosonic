/** Deterministic synthetic test signals. */
export function rng(seed = 7) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Four-on-the-floor kick with off-beat hats at a known tempo. */
export function drumLoop({ sr = 44100, bpm = 120, seconds = 30, offset = 0.25, seed = 3 } = {}) {
  const n = Math.floor(sr * seconds);
  const L = new Float32Array(n);
  const r = rng(seed);
  const beat = 60 / bpm;
  const onsets = [];
  for (let t = offset; t < seconds - 0.5; t += beat) {
    onsets.push(t);
    const n0 = Math.round(t * sr);
    let ph = 0;
    for (let i = 0; i < sr * 0.35 && n0 + i < n; i++) {
      const tt = i / sr;
      ph += (2 * Math.PI * (50 + 120 * Math.exp(-tt / 0.03))) / sr;
      L[n0 + i] += Math.sin(ph) * Math.exp(-tt / 0.2) * 0.8;
    }
    const h0 = Math.round((t + beat / 2) * sr);
    for (let i = 0; i < sr * 0.05 && h0 + i < n; i++) L[h0 + i] += (r() * 2 - 1) * Math.exp(-i / sr / 0.012) * 0.15;
  }
  for (let i = 0; i < n; i++) L[i] += (r() * 2 - 1) * 0.002;
  return { channels: [L, L.slice()], sampleRate: sr, onsets };
}

export function nearestDistance(list, t) {
  let best = Infinity;
  for (const x of list) best = Math.min(best, Math.abs(x - t));
  return best;
}
