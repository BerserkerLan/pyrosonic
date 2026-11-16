import { movingAverage, smooth, std, mean, median, clamp } from './dsp.js';

/**
 * Onset-strength envelope used for tempo and beat tracking: spectral flux,
 * lightly smoothed, with the local mean removed and half-wave rectified.
 */
export function onsetEnvelope(frames) {
  const { flux, fluxLow, frameRate } = frames;
  const n = flux.length;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = flux[i] + 0.5 * fluxLow[i];
  const sm = smooth(raw, 1);
  const local = movingAverage(sm, Math.round(frameRate * 0.2));
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = Math.max(0, sm[i] - local[i]);
  const s = std(env) || 1;
  for (let i = 0; i < n; i++) env[i] /= s;
  return env;
}

/** Autocorrelation of x for lags [0, maxLag], normalised by overlap length. */
function autocorrelation(x, maxLag) {
  const n = x.length;
  const r = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) s += x[i] * x[i + lag];
    r[lag] = m > 0 ? s / m : 0;
  }
  return r;
}

const interp = (arr, x) => {
  const i = Math.floor(x);
  if (i < 0) return arr[0];
  if (i >= arr.length - 1) return arr[arr.length - 1];
  const f = x - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
};

/**
 * Global tempo estimate (BPM) with a log-Gaussian prior around 120 BPM and
 * sub-harmonic reinforcement so we lock onto the beat, not the bar or 8ths.
 */
export function estimateTempo(env, frameRate, { minBpm = 60, maxBpm = 200, prior = 120 } = {}) {
  const minLag = Math.floor((60 * frameRate) / maxBpm);
  const maxLag = Math.ceil((60 * frameRate) / minBpm);
  const r = autocorrelation(env, maxLag * 3 + 2);
  const r0 = r[0] || 1;
  for (let i = 0; i < r.length; i++) r[i] /= r0;

  let bestLag = -1;
  let bestScore = -Infinity;
  const scores = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / prior) / 0.9, 2));
    // Beat-level periodicity reinforced by the 2× and 3× multiples (bars, phrases).
    const s = r[lag] + 0.5 * interp(r, lag * 2) + 0.33 * interp(r, lag * 3);
    scores[lag] = s * w;
    if (scores[lag] > bestScore) { bestScore = scores[lag]; bestLag = lag; }
  }
  if (bestLag < 0) return { bpm: 120, period: (60 * frameRate) / 120, confidence: 0 };

  // Parabolic refinement of the lag on the raw autocorrelation.
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = scores[bestLag - 1], b = scores[bestLag], c = scores[bestLag + 1];
    const d = a - 2 * b + c;
    if (d < 0) lag = bestLag + clamp((0.5 * (a - c)) / d, -0.5, 0.5);
  }
  // Peak prominence vs. the median score is a decent periodicity confidence.
  const vals = [];
  for (let l = minLag; l <= maxLag; l++) vals.push(scores[l]);
  const med = median(vals);
  const confidence = clamp((bestScore - med) / (Math.abs(bestScore) + 1e-9), 0, 1);
  return { bpm: (60 * frameRate) / lag, period: lag, confidence };
}

/**
 * Dynamic-programming beat tracker (Ellis 2007, as in librosa.beat).
 * Returns beat frame indices.
 */
export function trackBeats(env, period, { tightness = 100 } = {}) {
  const n = env.length;
  if (n < period * 2) return [];
  // Local score: onset envelope smoothed by a narrow Gaussian.
  const sigma = period / 32;
  const rad = Math.max(1, Math.ceil(sigma * 3));
  const kern = [];
  for (let i = -rad; i <= rad; i++) kern.push(Math.exp(-0.5 * (i / Math.max(sigma, 0.5)) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -rad; j <= rad; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < n) s += env[idx] * kern[j + rad];
    }
    local[i] = s;
  }
  let localMax = 0;
  for (let i = 0; i < n; i++) if (local[i] > localMax) localMax = local[i];

  const wStart = Math.round(-2 * period);
  const wEnd = -Math.round(period / 2);
  const wLen = wEnd - wStart + 1;
  const txwt = new Float64Array(wLen);
  for (let i = 0; i < wLen; i++) {
    const off = -(wStart + i);
    txwt[i] = -tightness * Math.pow(Math.log(off / period), 2);
  }

  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  let firstBeat = true;
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let bestJ = -1;
    for (let w = 0; w < wLen; w++) {
      const j = i + wStart + w;
      const v = j >= 0 ? cum[j] + txwt[w] : txwt[w];
      if (v > best) { best = v; bestJ = j; }
    }
    cum[i] = local[i] + best;
    if (firstBeat && local[i] < 0.01 * localMax) {
      back[i] = -1;
    } else {
      back[i] = bestJ >= 0 ? bestJ : -1;
      firstBeat = false;
    }
  }

  // Last beat: the final local max of the cumulative score that's above half the median local-max.
  const maxima = [];
  for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(cum[i]);
  const med = median(maxima);
  let last = -1;
  for (let i = n - 2; i >= 1; i--) {
    if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1] && cum[i] * 2 > med) { last = i; break; }
  }
  if (last < 0) return [];
  const beats = [last];
  while (back[beats[beats.length - 1]] >= 0) {
    const prev = back[beats[beats.length - 1]];
    if (prev >= beats[beats.length - 1]) break;
    beats.push(prev);
  }
  beats.reverse();

  // Trim weak leading/trailing beats (silence or fade-in/out).
  const vals = beats.map((b) => local[b]);
  const sm = vals.map((_, i) => {
    let s = 0, c = 0;
    for (let j = -2; j <= 2; j++) {
      const k = i + j;
      if (k >= 0 && k < vals.length) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (j + 3)) / 6);
        s += vals[k] * w;
        c += w;
      }
    }
    return c ? s / c : 0;
  });
  const rmsVal = Math.sqrt(sm.reduce((a, v) => a + v * v, 0) / Math.max(1, sm.length));
  const thr = 0.5 * rmsVal;
  let a = 0, b = beats.length - 1;
  while (a < beats.length && sm[a] <= thr) a++;
  while (b > a && sm[b] <= thr) b--;
  return beats.slice(a, b + 1);
}

/**
 * Snap each beat to the strongest onset within ±radius frames so burst
 * timing follows the actual transient rather than the idealised grid.
 */
export function refineBeats(beatFrames, env, radius) {
  return beatFrames.map((b) => {
    let best = b;
    let bestVal = env[b] ?? 0;
    for (let d = -radius; d <= radius; d++) {
      const i = b + d;
      if (i < 0 || i >= env.length) continue;
      // Slight preference for the original position.
      const v = env[i] * (1 - 0.08 * Math.abs(d) / Math.max(1, radius));
      if (v > bestVal * 1.15) { best = i; bestVal = v; }
    }
    return best;
  });
}

/**
 * Fill gaps in the beat sequence and extend it to cover [start, end] so later
 * stages always have a continuous grid (e.g. through breakdowns with no drums).
 */
export function completeBeatGrid(beatTimes, startTime, endTime, period) {
  if (!beatTimes.length) {
    const out = [];
    for (let t = startTime; t <= endTime; t += period) out.push(t);
    return out;
  }
  const out = [];
  // Extend backwards.
  let t = beatTimes[0] - period;
  const pre = [];
  while (t >= startTime - period * 0.25) { pre.push(t); t -= period; }
  pre.reverse();
  out.push(...pre.filter((x) => x >= -0.06));
  for (let i = 0; i < beatTimes.length; i++) {
    out.push(beatTimes[i]);
    if (i + 1 < beatTimes.length) {
      const gap = beatTimes[i + 1] - beatTimes[i];
      const k = Math.round(gap / period);
      if (k >= 2) {
        for (let j = 1; j < k; j++) out.push(beatTimes[i] + (gap * j) / k);
      }
    }
  }
  t = beatTimes[beatTimes.length - 1] + period;
  while (t <= endTime + period * 0.25) { out.push(t); t += period; }
  return out;
}

/**
 * Pick the bar phase (which beat of every 4 is the downbeat) by scoring
 * harmonic change and low-frequency onsets on each candidate phase.
 */
export function estimateDownbeatPhase(beatCount, scoreAt) {
  if (beatCount < 8) return 0;
  const sums = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < beatCount; i++) {
    sums[i % 4] += scoreAt(i);
    counts[i % 4]++;
  }
  let best = 0;
  let bestV = -Infinity;
  for (let p = 0; p < 4; p++) {
    const v = counts[p] ? sums[p] / counts[p] : 0;
    if (v > bestV) { bestV = v; best = p; }
  }
  return best;
}

/** Ratio of onset strength on beats vs. overall — a proxy for how "beaty" the track is. */
export function beatConfidence(env, beatFrames) {
  if (beatFrames.length < 8) return 0;
  const onBeats = mean(Float32Array.from(beatFrames.map((b) => env[b] ?? 0)));
  const overall = mean(env) || 1e-9;
  return clamp((onBeats / overall - 1.2) / 1.6, 0, 1);
}
