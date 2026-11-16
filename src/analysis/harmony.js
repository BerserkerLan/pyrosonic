import { clamp } from './dsp.js';

export const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

// Krumhansl–Kessler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Krumhansl–Schmuckler key finding on an aggregate chroma vector. */
export function detectKey(chroma) {
  let best = { tonic: 9, mode: 'minor', score: -Infinity };
  let second = -Infinity;
  for (let mode of ['major', 'minor']) {
    const prof = mode === 'major' ? MAJOR : MINOR;
    for (let tonic = 0; tonic < 12; tonic++) {
      const rotated = new Array(12);
      for (let i = 0; i < 12; i++) rotated[(i + tonic) % 12] = prof[i];
      const s = pearson(chroma, rotated);
      if (s > best.score) { second = best.score; best = { tonic, mode, score: s }; }
      else if (s > second) second = s;
    }
  }
  const total = chroma.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { tonic: 9, mode: 'minor', name: 'Unknown', confidence: 0 };
  return {
    tonic: best.tonic,
    mode: best.mode,
    name: `${PITCH_NAMES[best.tonic]} ${best.mode}`,
    confidence: clamp((best.score - second) * 4 + best.score * 0.5, 0, 1),
  };
}

/** Average chroma frames inside each [times[i], times[i+1]) interval, L2-normalised. */
export function intervalChroma(harm, times, endTime) {
  const { chroma, frameRate, count } = harm;
  const m = times.length;
  const out = new Float32Array(m * 12);
  for (let i = 0; i < m; i++) {
    const t0 = times[i];
    const t1 = i + 1 < m ? times[i + 1] : endTime;
    let a = Math.max(0, Math.round(t0 * frameRate));
    let b = Math.min(count - 1, Math.round(t1 * frameRate));
    if (b < a) b = a;
    const acc = new Float64Array(12);
    for (let f = a; f <= b && f < count; f++) {
      for (let p = 0; p < 12; p++) acc[p] += chroma[f * 12 + p];
    }
    let norm = 0;
    for (let p = 0; p < 12; p++) norm += acc[p] * acc[p];
    norm = Math.sqrt(norm) || 1;
    for (let p = 0; p < 12; p++) out[i * 12 + p] = acc[p] / norm;
  }
  return out;
}

const TEMPLATES = (() => {
  const list = [];
  for (let root = 0; root < 12; root++) {
    for (const [quality, third] of [['maj', 4], ['min', 3]]) {
      const t = new Float32Array(12);
      t[root] = 1;
      t[(root + third) % 12] = 0.8;
      t[(root + 7) % 12] = 0.9;
      let n = 0;
      for (let i = 0; i < 12; i++) n += t[i] * t[i];
      n = Math.sqrt(n);
      for (let i = 0; i < 12; i++) t[i] /= n;
      list.push({ root, quality, t });
    }
  }
  return list;
})();

/** Triad template matching on normalised chroma vectors (one per bar). */
export function detectChords(intervalCh, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    let best = null;
    let bestS = -1;
    for (const tpl of TEMPLATES) {
      let s = 0;
      for (let p = 0; p < 12; p++) s += tpl.t[p] * intervalCh[i * 12 + p];
      if (s > bestS) { bestS = s; best = tpl; }
    }
    out.push({ root: best.root, quality: best.quality, confidence: clamp((bestS - 0.55) / 0.35, 0, 1) });
  }
  return out;
}

/** 1 − cosine similarity between adjacent intervals (harmonic change), per interval. */
export function chromaChange(intervalCh, count) {
  const out = new Float32Array(count);
  for (let i = 1; i < count; i++) {
    let s = 0;
    for (let p = 0; p < 12; p++) s += intervalCh[i * 12 + p] * intervalCh[(i - 1) * 12 + p];
    out[i] = clamp(1 - s, 0, 1);
  }
  return out;
}
