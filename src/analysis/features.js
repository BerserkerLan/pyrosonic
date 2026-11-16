import { FFT, splitRealSpectra } from './fft.js';
import { hann, bandpass, clamp } from './dsp.js';

/** Short-time analysis: ~11 ms hop for rhythm, ~93 ms hop for harmony. */
export const FRAME = 1024;
export const HOP = 256;
export const HFRAME = 4096;
export const HHOP = 2048;

const GAMMA = 100; // log compression for spectral flux

/**
 * Compute per-frame spectral features of a (decimated) mono signal.
 * `side` is the stereo side signal (L−R)/2 at the same rate, or null.
 * Frame f is centred on sample f·HOP.
 */
export function computeFrameFeatures(mono, side, sr, onProgress = () => {}) {
  const N = FRAME;
  const H = HOP;
  const half = N >> 1;
  const nb = half + 1;
  const n = mono.length;
  const nFrames = Math.max(2, Math.ceil(n / H));
  const win = hann(N);
  const fft = new FFT(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const magA = new Float64Array(nb);
  const magB = new Float64Array(nb);
  const scale = 4 / N;
  const binHz = sr / N;
  const bin = (hz) => clamp(Math.round(hz / binHz), 1, half);

  const nyq = sr / 2;
  const kLo = bin(30);
  const kTop = bin(Math.min(11000, nyq * 0.95));
  const edges = {
    sub: [bin(20), bin(60)],
    bass: [bin(60), bin(160)],
    lowmid: [bin(160), bin(400)],
    mid: [bin(400), bin(2000)],
    highmid: [bin(2000), bin(5000)],
    high: [bin(5000), kTop],
    fLow: [bin(30), bin(160)],
    fMid: [bin(160), bin(4000)],
    fHigh: [bin(5000), kTop],
    voc: [bin(300), bin(3400)],
  };

  const out = {
    frameRate: sr / H,
    count: nFrames,
    rms: new Float32Array(nFrames),
    eSub: new Float32Array(nFrames),
    eBass: new Float32Array(nFrames),
    eLowMid: new Float32Array(nFrames),
    eMid: new Float32Array(nFrames),
    eHighMid: new Float32Array(nFrames),
    eHigh: new Float32Array(nFrames),
    flux: new Float32Array(nFrames),
    fluxLow: new Float32Array(nFrames),
    fluxMid: new Float32Array(nFrames),
    fluxHigh: new Float32Array(nFrames),
    centroid: new Float32Array(nFrames),
    flatVoc: new Float32Array(nFrames),
    vocBand: new Float32Array(nFrames),
    center: new Float32Array(nFrames),
  };

  let prevLog = new Float64Array(nb);
  let curLog = new Float64Array(nb);
  let hasPrev = false;

  const fill = (buf, f) => {
    const start = f * H - half;
    if (start >= 0 && start + N <= n) {
      for (let i = 0; i < N; i++) buf[i] = mono[start + i] * win[i];
    } else {
      for (let i = 0; i < N; i++) {
        const idx = start + i;
        buf[i] = idx >= 0 && idx < n ? mono[idx] * win[i] : 0;
      }
    }
  };

  const bandSum = (p, [a, b]) => {
    let s = 0;
    for (let k = a; k <= b; k++) s += p[k];
    return s;
  };

  const pw = new Float64Array(nb);

  const processFrame = (f, mag) => {
    let tot = 0;
    let cNum = 0;
    for (let k = 0; k <= half; k++) {
      const p = mag[k] * mag[k];
      pw[k] = p;
      if (k >= kLo && k <= kTop) {
        tot += p;
        cNum += p * k * binHz;
      }
    }
    out.eSub[f] = bandSum(pw, edges.sub);
    out.eBass[f] = bandSum(pw, edges.bass);
    out.eLowMid[f] = bandSum(pw, edges.lowmid);
    out.eMid[f] = bandSum(pw, edges.mid);
    out.eHighMid[f] = bandSum(pw, edges.highmid);
    out.eHigh[f] = bandSum(pw, edges.high);
    out.centroid[f] = tot > 1e-12 ? cNum / tot : 0;

    const vs = bandSum(pw, edges.voc);
    out.vocBand[f] = tot > 1e-12 ? vs / tot : 0;
    // Spectral flatness in the vocal band (geometric / arithmetic mean).
    {
      const [a, b] = edges.voc;
      let logSum = 0;
      for (let k = a; k <= b; k++) logSum += Math.log(pw[k] + 1e-14);
      const cnt = b - a + 1;
      const am = vs / cnt;
      out.flatVoc[f] = am > 1e-13 ? clamp(Math.exp(logSum / cnt) / am, 0, 1) : 1;
    }

    for (let k = 0; k <= half; k++) curLog[k] = Math.log1p(GAMMA * mag[k]);
    if (hasPrev) {
      let fl = 0, fLow = 0, fMid = 0, fHigh = 0;
      for (let k = kLo; k <= kTop; k++) {
        // SuperFlux-style: compare with a frequency max-filtered previous frame
        const pm = Math.max(prevLog[k - 1], prevLog[k], k + 1 <= half ? prevLog[k + 1] : 0);
        const d = curLog[k] - pm;
        if (d > 0) {
          fl += d;
          if (k <= edges.fLow[1]) fLow += d;
          if (k >= edges.fMid[0] && k <= edges.fMid[1]) fMid += d;
          if (k >= edges.fHigh[0]) fHigh += d;
        }
      }
      out.flux[f] = fl / (kTop - kLo + 1);
      out.fluxLow[f] = fLow / (edges.fLow[1] - edges.fLow[0] + 1);
      out.fluxMid[f] = fMid / (edges.fMid[1] - edges.fMid[0] + 1);
      out.fluxHigh[f] = fHigh / Math.max(1, edges.fHigh[1] - edges.fHigh[0] + 1);
    }
    const t = prevLog; prevLog = curLog; curLog = t;
    hasPrev = true;
  };

  const progressEvery = Math.max(2, Math.floor(nFrames / 60) & ~1);
  for (let f = 0; f < nFrames; f += 2) {
    const f2 = f + 1 < nFrames ? f + 1 : -1;
    fill(re, f);
    if (f2 >= 0) fill(im, f2); else im.fill(0);
    fft.transform(re, im);
    splitRealSpectra(re, im, magA, magB, scale);
    processFrame(f, magA);
    if (f2 >= 0) processFrame(f2, magB);
    if (f % progressEvery === 0) onProgress(f / nFrames);
  }
  out.flux[0] = out.flux[1];
  out.fluxLow[0] = out.fluxLow[1];
  out.fluxMid[0] = out.fluxMid[1];
  out.fluxHigh[0] = out.fluxHigh[1];

  // RMS over the central 2·HOP samples of each frame.
  for (let f = 0; f < nFrames; f++) {
    const c = f * H;
    const a = Math.max(0, c - H);
    const b = Math.min(n, c + H);
    let s = 0;
    for (let i = a; i < b; i++) s += mono[i] * mono[i];
    out.rms[f] = b > a ? Math.sqrt(s / (b - a)) : 0;
  }

  // Stereo "centredness" in the vocal band — lead vocals are usually panned centre.
  if (side) {
    const bm = bandpass(mono, sr, 250, 3500);
    const bs = bandpass(side, sr, 250, 3500);
    for (let f = 0; f < nFrames; f++) {
      const c = f * H;
      const a = Math.max(0, c - H);
      const b = Math.min(n, c + H);
      let em = 0, es = 0;
      for (let i = a; i < b; i++) { em += bm[i] * bm[i]; es += bs[i] * bs[i]; }
      out.center[f] = em + es > 1e-12 ? em / (em + es) : 0.5;
    }
  } else {
    out.center.fill(0.75);
  }
  onProgress(1);
  return out;
}

/**
 * Long-window analysis for harmony: 12-bin chroma and a rough dominant pitch
 * (harmonic-sum salience) per frame.
 */
export function computeHarmonicFeatures(mono, sr, onProgress = () => {}) {
  const N = HFRAME;
  const H = HHOP;
  const half = N >> 1;
  const nb = half + 1;
  const n = mono.length;
  const nFrames = Math.max(2, Math.ceil(n / H));
  const win = hann(N);
  const fft = new FFT(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const magA = new Float64Array(nb);
  const magB = new Float64Array(nb);
  const scale = 4 / N;
  const binHz = sr / N;

  // Bin → pitch class with a cosine² weighting toward semitone centres.
  const kMin = Math.max(2, Math.round(80 / binHz));
  const kMax = Math.min(half - 1, Math.round(3500 / binHz));
  const pcOf = new Int8Array(nb).fill(-1);
  const wOf = new Float32Array(nb);
  for (let k = kMin; k <= kMax; k++) {
    const f = k * binHz;
    const midi = 69 + 12 * Math.log2(f / 440);
    const r = Math.round(midi);
    pcOf[k] = ((r % 12) + 12) % 12;
    const c = Math.cos(Math.PI * (midi - r));
    wOf[k] = c * c;
  }

  // Pitch candidates on a semitone grid (G2..C6).
  const candLo = 43;
  const candHi = 84;
  const nCand = candHi - candLo + 1;
  const candBins = [];
  for (let m = candLo; m <= candHi; m++) {
    const f0 = 440 * Math.pow(2, (m - 69) / 12);
    const hs = [];
    for (let h = 1; h <= 6; h++) {
      const k = Math.round((f0 * h) / binHz);
      if (k + 1 < half) hs.push(k);
    }
    candBins.push(hs);
  }
  const hw = [1, 0.85, 0.72, 0.61, 0.52, 0.44];

  const chroma = new Float32Array(nFrames * 12);
  const pitch = new Float32Array(nFrames);
  const salience = new Float32Array(nFrames);
  const energy = new Float32Array(nFrames);

  const fill = (buf, f) => {
    const start = f * H - half;
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      buf[i] = idx >= 0 && idx < n ? mono[idx] * win[i] : 0;
    }
  };

  const processFrame = (f, mag) => {
    let maxMag = 0;
    let e = 0;
    for (let k = kMin; k <= kMax; k++) {
      if (mag[k] > maxMag) maxMag = mag[k];
      e += mag[k] * mag[k];
    }
    energy[f] = e;
    const thr = maxMag * 0.04;
    const base = f * 12;
    for (let k = kMin; k <= kMax; k++) {
      const m = mag[k];
      if (m > thr && m > mag[k - 1] && m >= mag[k + 1]) {
        chroma[base + pcOf[k]] += wOf[k] * Math.sqrt(m);
      }
    }
    let best = -1, bestVal = 0, total = 0;
    for (let c = 0; c < nCand; c++) {
      const hs = candBins[c];
      let v = 0;
      for (let h = 0; h < hs.length; h++) {
        const k = hs[h];
        v += hw[h] * Math.max(mag[k - 1], mag[k], mag[k + 1]);
      }
      total += v;
      if (v > bestVal) { bestVal = v; best = c; }
    }
    pitch[f] = best >= 0 ? candLo + best : 0;
    salience[f] = total > 1e-12 ? (bestVal / total) * nCand : 0;
  };

  for (let f = 0; f < nFrames; f += 2) {
    const f2 = f + 1 < nFrames ? f + 1 : -1;
    fill(re, f);
    if (f2 >= 0) fill(im, f2); else im.fill(0);
    fft.transform(re, im);
    splitRealSpectra(re, im, magA, magB, scale);
    processFrame(f, magA);
    if (f2 >= 0) processFrame(f2, magB);
    if (f % 64 === 0) onProgress(f / nFrames);
  }
  onProgress(1);
  return { frameRate: sr / H, count: nFrames, chroma, pitch, salience, energy };
}
