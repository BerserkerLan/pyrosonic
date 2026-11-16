import { decimate, smooth, clamp, percentile, pickPeaks, mean, movingAverage } from './dsp.js';
import { computeFrameFeatures, computeHarmonicFeatures, HOP } from './features.js';
import {
  onsetEnvelope,
  estimateTempo,
  trackBeats,
  refineBeats,
  completeBeatGrid,
  estimateDownbeatPhase,
  beatConfidence,
} from './beats.js';
import { detectKey, intervalChroma, detectChords, chromaChange } from './harmony.js';
import { analyzeStructure } from './structure.js';

/**
 * Flux peaks sit slightly ahead of the perceived attack because the analysis
 * window "sees" a transient before its centre reaches it. Measured on
 * synthetic click/drum tracks (see tests/analysis.test.js).
 */
export const ONSET_LATENCY = 0.006;

/**
 * Full offline analysis of a decoded track.
 * @param {{channels: Float32Array[], sampleRate: number}} input
 * @param {(stage: string, p: number) => void} onProgress
 */
export function analyzeAudio({ channels, sampleRate }, onProgress = () => {}, { debug = false } = {}) {
  const t0 = Date.now();
  const L = channels[0];
  const R = channels[1] || null;
  const duration = L.length / sampleRate;

  // ---- 1. Mono / side, decimated to ~22–24 kHz ----------------------------------------
  onProgress('prepare', 0);
  const n = L.length;
  const monoFull = new Float32Array(n);
  const sideFull = R ? new Float32Array(n) : null;
  if (R) {
    for (let i = 0; i < n; i++) {
      monoFull[i] = 0.5 * (L[i] + R[i]);
      sideFull[i] = 0.5 * (L[i] - R[i]);
    }
  } else {
    monoFull.set(L);
  }
  const factor = Math.max(1, Math.pow(2, Math.round(Math.log2(sampleRate / 22050))));
  const sr = sampleRate / factor;
  const mono = decimate(monoFull, factor);
  const side = sideFull ? decimate(sideFull, factor) : null;
  onProgress('prepare', 0.6);

  // Normalise loudness so thresholds behave the same for quiet and loud masters.
  let ss = 0;
  for (let i = 0; i < mono.length; i++) ss += mono[i] * mono[i];
  const rmsAll = Math.sqrt(ss / Math.max(1, mono.length));
  let peakAbs = 0;
  for (let i = 0; i < mono.length; i++) { const a = Math.abs(mono[i]); if (a > peakAbs) peakAbs = a; }
  const silent = rmsAll < 1e-5;
  const gain = silent ? 1 : 0.1 / rmsAll;
  if (!silent) {
    for (let i = 0; i < mono.length; i++) mono[i] *= gain;
    if (side) for (let i = 0; i < side.length; i++) side[i] *= gain;
  }
  onProgress('prepare', 1);

  // ---- 2. Spectral features -----------------------------------------------------------
  const frames = computeFrameFeatures(mono, side, sr, (p) => onProgress('spectrum', p));
  const harm = computeHarmonicFeatures(mono, sr, (p) => onProgress('harmony', p));
  const fr = frames.frameRate;
  const nF = frames.count;
  const frameTime = (i) => (i * HOP) / sr + ONSET_LATENCY;

  // ---- 3. Normalised envelopes (0..1) ------------------------------------------------
  const db = (p) => 10 * Math.log10(p + 1e-12);
  const rmsDb = new Float32Array(nF);
  for (let i = 0; i < nF; i++) rmsDb[i] = 20 * Math.log10(frames.rms[i] + 1e-9);
  const peakDb = percentile(rmsDb, 0.995);
  const silenceDb = peakDb - 48;
  const voiced = [];
  for (let i = 0; i < nF; i++) if (rmsDb[i] > silenceDb) voiced.push(rmsDb[i]);

  const normDb = (arr, range) => {
    const vals = [];
    for (let i = 0; i < nF; i++) if (rmsDb[i] > silenceDb) vals.push(arr[i]);
    const hi = vals.length ? percentile(vals, 0.985) : 0;
    const lo = Math.max(vals.length ? percentile(vals, 0.08) : hi - range, hi - range);
    const out = new Float32Array(nF);
    const span = Math.max(1e-6, hi - lo);
    for (let i = 0; i < nF; i++) out[i] = clamp((arr[i] - lo) / span, 0, 1);
    return out;
  };

  const energy = smooth(normDb(rmsDb, 36), fr * 0.12);
  // Presence: 0 in silence, 1 once the signal is clearly above the noise floor.
  const presence = new Float32Array(nF);
  for (let i = 0; i < nF; i++) presence[i] = clamp((rmsDb[i] - silenceDb - 4) / 12, 0, 1);
  const presenceS = smooth(presence, fr * 0.08);
  const bassDb = new Float32Array(nF);
  const midDb = new Float32Array(nF);
  const trebDb = new Float32Array(nF);
  for (let i = 0; i < nF; i++) {
    bassDb[i] = db(frames.eSub[i] + frames.eBass[i]);
    midDb[i] = db(frames.eLowMid[i] + frames.eMid[i]);
    trebDb[i] = db(frames.eHighMid[i] + frames.eHigh[i]);
  }
  const bass = smooth(normDb(bassDb, 34), fr * 0.06);
  const mids = smooth(normDb(midDb, 34), fr * 0.06);
  const treble = smooth(normDb(trebDb, 34), fr * 0.06);
  const brightness = new Float32Array(nF);
  for (let i = 0; i < nF; i++) {
    const c = frames.centroid[i];
    brightness[i] = c > 0 ? clamp(Math.log2(c / 250) / Math.log2(5000 / 250), 0, 1) : 0;
  }
  const brightS = smooth(brightness, fr * 0.25);
  onProgress('rhythm', 0.1);

  // ---- 4. Tempo & beats ----------------------------------------------------------------
  const env = onsetEnvelope(frames);
  const tempo = estimateTempo(env, fr);
  let beatFrames = trackBeats(env, tempo.period);
  beatFrames = refineBeats(beatFrames, env, Math.max(1, Math.round(tempo.period * 0.08)));
  const confidence = Math.max(beatConfidence(env, beatFrames), 0);
  onProgress('rhythm', 0.5);

  // Music start / end (first and last non-silent frames).
  let firstVoiced = 0;
  while (firstVoiced < nF - 1 && rmsDb[firstVoiced] <= silenceDb) firstVoiced++;
  let lastVoiced = nF - 1;
  while (lastVoiced > 0 && rmsDb[lastVoiced] <= silenceDb) lastVoiced--;
  const musicStart = silent ? 0 : frameTime(firstVoiced);
  const musicEnd = silent ? duration : Math.min(duration, frameTime(lastVoiced));

  const periodSec = tempo.period / fr;
  const trackedTimes = beatFrames.map(frameTime);
  const beatTimes = completeBeatGrid(trackedTimes, musicStart, musicEnd, periodSec)
    .map((t) => (t < 0 && t > -0.06 ? 0 : t))
    .filter((t) => t >= 0 && t < duration);
  // Beat strength from the onset envelope at (or near) each beat.
  const beatStrength = beatTimes.map((t) => {
    const f = Math.round((t - ONSET_LATENCY) * fr);
    let m = 0;
    for (let d = -2; d <= 2; d++) m = Math.max(m, env[f + d] ?? 0);
    return m;
  });
  const strengthNorm = percentile(beatStrength, 0.9) || 1;

  // ---- 5. Band onsets -----------------------------------------------------------------
  const pickBand = (arr, waitSec, delta) => {
    const sm = smooth(arr, 0.8);
    const loc = movingAverage(sm, Math.round(fr * 0.5));
    const e = new Float32Array(nF);
    for (let i = 0; i < nF; i++) e[i] = Math.max(0, sm[i] - loc[i] * 0.85);
    const nrm = percentile(e, 0.985) || 1;
    for (let i = 0; i < nF; i++) e[i] /= nrm;
    const peaks = pickPeaks(e, {
      preMax: Math.round(fr * 0.03),
      postMax: Math.round(fr * 0.03),
      preAvg: Math.round(fr * 0.1),
      postAvg: Math.round(fr * 0.07),
      delta,
      wait: Math.max(1, Math.round(fr * waitSec)),
      floor: 0.05,
    });
    return peaks
      .filter((i) => rmsDb[i] > silenceDb + 6)
      .map((i) => ({ t: frameTime(i), s: clamp(e[i], 0, 1.6) * (0.35 + 0.65 * energy[i]) }));
  };
  const snareSig = new Float32Array(nF);
  const hatSig = new Float32Array(nF);
  {
    const hiN = percentile(frames.fluxHigh, 0.98) || 1;
    const loN = percentile(frames.fluxLow, 0.98) || 1;
    for (let i = 0; i < nF; i++) {
      const hi = clamp(frames.fluxHigh[i] / hiN, 0, 2);
      const lo = clamp(frames.fluxLow[i] / loN, 0, 2);
      snareSig[i] = frames.fluxMid[i] * (0.4 + 0.6 * hi);
      hatSig[i] = frames.fluxHigh[i] * (1 - 0.35 * clamp(lo, 0, 1));
    }
  }
  const onsets = {
    kick: pickBand(frames.fluxLow, 0.1, 0.12),
    snare: pickBand(snareSig, 0.1, 0.12),
    hat: pickBand(hatSig, 0.055, 0.1),
    all: pickBand(frames.flux, 0.05, 0.08),
  };
  onProgress('rhythm', 1);

  // ---- 6. Harmony: key, beat chroma, downbeats, chords -------------------------------------
  const globalChroma = new Float64Array(12);
  for (let f = 0; f < harm.count; f++) {
    const w = Math.sqrt(harm.energy[f]);
    for (let p = 0; p < 12; p++) globalChroma[p] += harm.chroma[f * 12 + p] * w;
  }
  const key = detectKey(Array.from(globalChroma));
  const beatCh = intervalChroma(harm, beatTimes, duration);
  const chChange = chromaChange(beatCh, beatTimes.length);
  const lowAt = (t) => {
    const f = Math.round((t - ONSET_LATENCY) * fr);
    let m = 0;
    for (let d = -2; d <= 2; d++) m = Math.max(m, frames.fluxLow[f + d] ?? 0);
    return m;
  };
  const lowNorm = percentile(beatTimes.map(lowAt), 0.9) || 1;
  // Harmonic change measured over a wider window is more reliable for downbeats.
  const wideChange = beatTimes.map((_, i) => {
    if (i < 2 || i + 2 > beatTimes.length) return 0;
    let s = 0;
    for (let p = 0; p < 12; p++) {
      const before = beatCh[(i - 1) * 12 + p] + beatCh[(i - 2) * 12 + p];
      const after = beatCh[i * 12 + p] + beatCh[(i + 1) * 12 + p];
      s += before * after;
    }
    let na = 0, nb = 0;
    for (let p = 0; p < 12; p++) {
      na += (beatCh[(i - 1) * 12 + p] + beatCh[(i - 2) * 12 + p]) ** 2;
      nb += (beatCh[i * 12 + p] + beatCh[(i + 1) * 12 + p]) ** 2;
    }
    return clamp(1 - s / (Math.sqrt(na * nb) || 1), 0, 1);
  });
  const downbeatPhase = estimateDownbeatPhase(beatTimes.length, (i) =>
    1.0 * wideChange[i] + 0.25 * chChange[i] + 0.35 * clamp(lowAt(beatTimes[i]) / lowNorm, 0, 1.5) +
    0.15 * clamp(beatStrength[i] / strengthNorm, 0, 1.5));
  onProgress('harmony2', 0.5);

  // Bars & chords.
  const barTimes = [];
  for (let i = downbeatPhase; i < beatTimes.length; i += 4) barTimes.push(beatTimes[i]);
  const barCh = intervalChroma(harm, barTimes, duration);
  const chords = detectChords(barCh, barTimes.length).map((c, i) => ({ t: barTimes[i], ...c }));

  // ---- 7. Vocal / melody presence (heuristic) ------------------------------------------
  const vocalRaw = new Float32Array(nF);
  for (let i = 0; i < nF; i++) {
    const centred = clamp((frames.center[i] - 0.55) / 0.35, 0, 1);
    const tonal = clamp(1 - frames.flatVoc[i] * 2.2, 0, 1);
    const band = clamp(frames.vocBand[i] * 1.6, 0, 1);
    vocalRaw[i] = rmsDb[i] > silenceDb + 10 ? band * tonal * (0.35 + 0.65 * centred) : 0;
  }
  const vocalS = smooth(vocalRaw, fr * 0.25);
  const vNorm = percentile(vocalS, 0.95) || 1;
  const vocal = new Float32Array(nF);
  for (let i = 0; i < nF; i++) vocal[i] = clamp(vocalS[i] / vNorm, 0, 1);

  // Onset density (onsets per second, smoothed) for structure/sustain decisions.
  const density = new Float32Array(nF);
  for (const o of onsets.all) {
    const f = Math.round((o.t - ONSET_LATENCY) * fr);
    if (f >= 0 && f < nF) density[f] += 1;
  }
  const densityS = movingAverage(density, Math.round(fr * 1.0));
  for (let i = 0; i < nF; i++) densityS[i] *= fr; // → onsets/sec
  const densNorm = percentile(densityS, 0.95) || 1;
  const densityN = new Float32Array(nF);
  for (let i = 0; i < nF; i++) densityN[i] = clamp(densityS[i] / densNorm, 0, 1);

  // ---- 8. Beat-synchronous features & structure -------------------------------------------
  const B = beatTimes.length;
  const beatFeat = {
    energy: new Float32Array(B),
    minEnergy: new Float32Array(B),
    bass: new Float32Array(B),
    treble: new Float32Array(B),
    brightness: new Float32Array(B),
    density: new Float32Array(B),
    vocal: new Float32Array(B),
  };
  for (let i = 0; i < B; i++) {
    const a = Math.max(0, Math.floor((beatTimes[i] - ONSET_LATENCY) * fr));
    const b = Math.min(nF, Math.max(a + 1, Math.floor(((i + 1 < B ? beatTimes[i + 1] : musicEnd) - ONSET_LATENCY) * fr)));
    beatFeat.energy[i] = mean(energy, a, b);
    let mn = 1;
    for (let f = a; f < b; f++) if (energy[f] < mn) mn = energy[f];
    beatFeat.minEnergy[i] = mn;
    beatFeat.bass[i] = mean(bass, a, b);
    beatFeat.treble[i] = mean(treble, a, b);
    beatFeat.brightness[i] = mean(brightS, a, b);
    beatFeat.density[i] = mean(densityN, a, b);
    beatFeat.vocal[i] = mean(vocal, a, b);
  }
  onProgress('structure', 0.2);
  const structure = analyzeStructure({
    beatTimes,
    downbeatPhase,
    beatFeat,
    beatChroma: beatCh,
    duration,
    musicStart,
    musicEnd,
  });
  onProgress('structure', 1);

  // ---- 9. Melody line (pitch + salience at ~11 Hz) ------------------------------------------
  const melody = [];
  for (let f = 0; f < harm.count; f++) {
    const t = (f * (sr / harm.frameRate)) / sr; // == f / frameRate
    if (harm.salience[f] > 2.2 && harm.pitch[f] > 0) melody.push({ t, midi: harm.pitch[f], s: clamp((harm.salience[f] - 2.2) / 3, 0, 1) });
  }

  // ---- 10. Waveform overview for the UI --------------------------------------------------
  const bins = 1200;
  const peaks = new Float32Array(bins);
  const per = mono.length / bins;
  let maxPeak = 1e-9;
  for (let b = 0; b < bins; b++) {
    const a = Math.floor(b * per);
    const e = Math.min(mono.length, Math.floor((b + 1) * per));
    let m = 0;
    for (let i = a; i < e; i++) { const v = Math.abs(mono[i]); if (v > m) m = v; }
    peaks[b] = m;
    if (m > maxPeak) maxPeak = m;
  }
  for (let b = 0; b < bins; b++) peaks[b] /= maxPeak;

  // Downsampled envelopes (≈ 43 Hz) for the choreographer & HUD — small enough to clone cheaply.
  const envRate = fr / 2;
  const down = (arr) => {
    const m = Math.floor(arr.length / 2);
    const o = new Float32Array(m);
    for (let i = 0; i < m; i++) o[i] = 0.5 * (arr[2 * i] + arr[2 * i + 1]);
    return o;
  };

  const beats = beatTimes.map((t, i) => ({
    t,
    strength: clamp(beatStrength[i] / strengthNorm, 0, 1.5),
    beatInBar: (((i - downbeatPhase) % 4) + 4) % 4,
    bar: Math.floor((i - downbeatPhase) / 4),
  }));

  const result = {
    version: 3,
    duration,
    musicStart,
    musicEnd,
    silent,
    sampleRate,
    peakLevel: peakAbs,
    tempo: { bpm: tempo.bpm, period: periodSec, confidence: Math.max(confidence, 0) },
    key,
    beats,
    bars: barTimes,
    chords,
    onsets,
    sections: structure.sections,
    drops: structure.drops,
    builds: structure.builds,
    _debug: debug ? structure.debug : undefined,
    melody,
    env: {
      rate: envRate,
      energy: down(energy),
      presence: down(presenceS),
      bass: down(bass),
      mids: down(mids),
      treble: down(treble),
      brightness: down(brightS),
      vocal: down(vocal),
      density: down(densityN),
    },
    waveform: peaks,
    timing: { ms: Date.now() - t0 },
  };
  onProgress('done', 1);
  return result;
}
