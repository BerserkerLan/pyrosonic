/** Small, allocation-conscious DSP helpers shared by the analysers. */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Low-pass + downsample by an integer factor using a Blackman-windowed sinc.
 * Output sample j corresponds to input sample j·factor.
 */
export function decimate(input, factor) {
  if (factor <= 1) return Float32Array.from(input);
  const taps = factor * 12 + 1;
  const half = (taps - 1) >> 1;
  const fc = 0.45 / factor; // cycles per input sample
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const m = i - half;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;

  const n = input.length;
  const outLen = Math.floor((n - 1) / factor) + 1;
  const out = new Float32Array(outLen);
  for (let j = 0; j < outLen; j++) {
    const c = j * factor;
    let acc = 0;
    const lo = c - half;
    if (lo >= 0 && c + half < n) {
      for (let i = 0; i < taps; i++) acc += h[i] * input[lo + i];
    } else {
      for (let i = 0; i < taps; i++) {
        const idx = lo + i;
        if (idx >= 0 && idx < n) acc += h[i] * input[idx];
      }
    }
    out[j] = acc;
  }
  return out;
}

/** Centred moving average with window 2r+1 (edges use the available samples). */
export function movingAverage(arr, r) {
  const n = arr.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  r = Math.max(0, Math.round(r));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + arr[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - r);
    const b = Math.min(n - 1, i + r);
    out[i] = (prefix[b + 1] - prefix[a]) / (b - a + 1);
  }
  return out;
}

/** Approximately Gaussian smoothing via three passes of a box filter. */
export function smooth(arr, r) {
  if (r < 1) return Float32Array.from(arr);
  const rr = Math.max(1, Math.round(r / 1.7));
  return movingAverage(movingAverage(movingAverage(arr, rr), rr), rr);
}

/** Running maximum over a centred window of 2r+1 (monotonic deque, O(n)). */
export function movingMax(arr, r) {
  const n = arr.length;
  const out = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0, tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + r);
    while (next <= hi) {
      while (tail > head && arr[dq[tail - 1]] <= arr[next]) tail--;
      dq[tail++] = next++;
    }
    while (dq[head] < i - r) head++;
    out[i] = arr[dq[head]];
  }
  return out;
}

export function percentile(arr, p) {
  const n = arr.length;
  if (n === 0) return 0;
  const copy = Float64Array.from(arr).sort();
  const idx = clamp((n - 1) * p, 0, n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return copy[lo] + (copy[hi] - copy[lo]) * (idx - lo);
}

/** Map values so the lo/hi percentiles land on 0/1, clamped. */
export function normalizeRobust(arr, lo = 0.05, hi = 0.98) {
  const a = percentile(arr, lo);
  const b = percentile(arr, hi);
  const out = new Float32Array(arr.length);
  const span = b - a > 1e-9 ? b - a : 1;
  for (let i = 0; i < arr.length; i++) out[i] = clamp((arr[i] - a) / span, 0, 1);
  return out;
}

export function mean(arr, start = 0, end = arr.length) {
  start = Math.max(0, start | 0);
  end = Math.min(arr.length, end | 0);
  if (end <= start) return 0;
  let s = 0;
  for (let i = start; i < end; i++) s += arr[i];
  return s / (end - start);
}

export function std(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < n; i++) s += (arr[i] - m) * (arr[i] - m);
  return Math.sqrt(s / (n - 1));
}

export function median(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** RBJ biquad band-pass (constant 0 dB peak gain), applied in place-free form. */
export function bandpass(input, sampleRate, lowHz, highHz) {
  const out = new Float32Array(input.length);
  // Cascade a 2nd-order high-pass and low-pass.
  const hp = biquadCoeffs('highpass', lowHz, sampleRate, Math.SQRT1_2);
  const lp = biquadCoeffs('lowpass', highHz, sampleRate, Math.SQRT1_2);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let u1 = 0, u2 = 0, z1 = 0, z2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = hp.b0 * x + hp.b1 * x1 + hp.b2 * x2 - hp.a1 * y1 - hp.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    const z = lp.b0 * y + lp.b1 * u1 + lp.b2 * u2 - lp.a1 * z1 - lp.a2 * z2;
    u2 = u1; u1 = y; z2 = z1; z1 = z;
    out[i] = z;
  }
  return out;
}

export function biquadCoeffs(type, freq, sampleRate, q) {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.49)) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  if (type === 'lowpass') {
    b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2;
  } else if (type === 'highpass') {
    b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2;
  } else if (type === 'bandpass') {
    b0 = alpha; b1 = 0; b2 = -alpha;
  } else {
    throw new Error(`Unknown biquad type ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Peak picking in the style of librosa.util.peak_pick.
 * A frame i is a peak if it is the max of [i-preMax, i+postMax], exceeds the
 * mean of [i-preAvg, i+postAvg] by delta, and is at least `wait` frames after
 * the previous peak.
 */
export function pickPeaks(env, { preMax, postMax, preAvg, postAvg, delta, wait, floor = 0 }) {
  const n = env.length;
  const peaks = [];
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = env[i];
    if (v <= floor) continue;
    let isMax = true;
    const a = Math.max(0, i - preMax);
    const b = Math.min(n - 1, i + postMax);
    for (let j = a; j <= b; j++) {
      if (env[j] > v || (env[j] === v && j < i)) { isMax = false; break; }
    }
    if (!isMax) continue;
    const c = Math.max(0, i - preAvg);
    const d = Math.min(n - 1, i + postAvg);
    const avg = (prefix[d + 1] - prefix[c]) / (d - c + 1);
    if (v < avg + delta) continue;
    if (i - last < wait) continue;
    peaks.push(i);
    last = i;
  }
  return peaks;
}

/** Linear interpolation lookup into a frame-rate series at time t (seconds). */
export function sampleSeries(series, frameRate, t) {
  const n = series.length;
  if (n === 0) return 0;
  const x = t * frameRate;
  if (x <= 0) return series[0];
  if (x >= n - 1) return series[n - 1];
  const i = Math.floor(x);
  const f = x - i;
  return series[i] * (1 - f) + series[i + 1] * f;
}

/** Mean of a frame-rate series over [t0, t1). */
export function seriesMean(series, frameRate, t0, t1) {
  const a = Math.max(0, Math.floor(t0 * frameRate));
  const b = Math.min(series.length, Math.max(a + 1, Math.ceil(t1 * frameRate)));
  return mean(series, a, b);
}
