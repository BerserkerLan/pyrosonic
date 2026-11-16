import { clamp, mean } from './dsp.js';

/**
 * Song-structure analysis: finds section boundaries with a Foote novelty
 * kernel over beat-synchronous features, augmented with energy change points,
 * then classifies each section (intro / verse / build / chorus / drop / …).
 */
export function analyzeStructure({ beatTimes, downbeatPhase, beatFeat, beatChroma, duration, musicStart, musicEnd }) {
  const B = beatTimes.length;
  if (B < 8) {
    return {
      sections: [makeSection(0, duration, 0, B, beatFeat, 2, 'Main', 0)],
      drops: [],
      builds: [],
    };
  }

  // ---- Feature matrix (beats × dims) ------------------------------------------------
  const timbreKeys = ['energy', 'bass', 'treble', 'brightness', 'density'];
  const dims = 12 + timbreKeys.length;
  const X = new Float32Array(B * dims);
  const zs = timbreKeys.map((k) => {
    const arr = beatFeat[k];
    const m = mean(arr);
    let v = 0;
    for (let i = 0; i < B; i++) v += (arr[i] - m) ** 2;
    return { m, s: Math.sqrt(v / B) || 1 };
  });
  for (let i = 0; i < B; i++) {
    for (let p = 0; p < 12; p++) X[i * dims + p] = beatChroma[i * 12 + p];
    timbreKeys.forEach((k, j) => {
      X[i * dims + 12 + j] = 0.55 * ((beatFeat[k][i] - zs[j].m) / zs[j].s);
    });
  }
  // Temporal smoothing (±2 beats).
  const Xs = new Float32Array(B * dims);
  for (let i = 0; i < B; i++) {
    for (let d = 0; d < dims; d++) {
      let s = 0, c = 0;
      for (let o = -2; o <= 2; o++) {
        const j = i + o;
        if (j < 0 || j >= B) continue;
        const w = 3 - Math.abs(o);
        s += X[j * dims + d] * w;
        c += w;
      }
      Xs[i * dims + d] = s / c;
    }
  }
  const norms = new Float32Array(B);
  for (let i = 0; i < B; i++) {
    let s = 0;
    for (let d = 0; d < dims; d++) s += Xs[i * dims + d] ** 2;
    norms[i] = Math.sqrt(s) || 1;
  }
  const sim = (i, j) => {
    let s = 0;
    const a = i * dims, b = j * dims;
    for (let d = 0; d < dims; d++) s += Xs[a + d] * Xs[b + d];
    return s / (norms[i] * norms[j]);
  };

  // ---- Checkerboard novelty -------------------------------------------------------
  const L = Math.min(16, Math.max(4, Math.floor(B / 6)));
  const g = new Float32Array(2 * L);
  for (let a = -L; a < L; a++) {
    const x = (a + 0.5) / L;
    g[a + L] = Math.exp(-0.5 * (x / 0.5) ** 2);
  }
  const novelty = new Float32Array(B);
  for (let i = 0; i < B; i++) {
    let s = 0, wsum = 0;
    for (let a = -L; a < L; a++) {
      const ia = i + a;
      if (ia < 0 || ia >= B) continue;
      const sa = a < 0 ? -1 : 1;
      for (let b = -L; b < L; b++) {
        const ib = i + b;
        if (ib < 0 || ib >= B) continue;
        const sb = b < 0 ? -1 : 1;
        const w = g[a + L] * g[b + L];
        s += sa * sb * w * sim(ia, ib);
        wsum += w;
      }
    }
    novelty[i] = wsum > 0 ? Math.max(0, s / wsum) : 0;
  }

  // ---- Bars -----------------------------------------------------------------------
  const barStarts = [];
  for (let i = downbeatPhase; i < B; i += 4) barStarts.push(i);
  const nBars = barStarts.length;
  const barRange = (k) => [barStarts[k], k + 1 < nBars ? barStarts[k + 1] : B];
  const barMean = (key, k) => {
    const [a, b] = barRange(k);
    return mean(beatFeat[key], a, b);
  };
  const barE = Array.from({ length: nBars }, (_, k) => barMean('energy', k));
  const barBass = Array.from({ length: nBars }, (_, k) => barMean('bass', k));
  const barTreble = Array.from({ length: nBars }, (_, k) => barMean('treble', k));
  const barDensity = Array.from({ length: nBars }, (_, k) => barMean('density', k));
  const avgBars = (arr, a, b) => {
    a = Math.max(0, a); b = Math.min(arr.length, b);
    if (b <= a) return arr[Math.max(0, Math.min(arr.length - 1, a))] ?? 0;
    let s = 0;
    for (let i = a; i < b; i++) s += arr[i];
    return s / (b - a);
  };

  // ---- Drops (big energy arrivals) ------------------------------------------------------
  const drops = [];
  for (let k = 1; k < nBars; k++) {
    const t = beatTimes[barStarts[k]];
    if (t < musicStart + 4 || t > musicEnd - 4) continue;
    const before = avgBars(barE, k - 2, k);
    const after = avgBars(barE, k, k + 2);
    const bassJump = avgBars(barBass, k, k + 2) - avgBars(barBass, k - 2, k);
    const jump = after - before;
    // Pre-drop silence: energy collapses in the final beat before the drop.
    const lastBeatIdx = barStarts[k] - 1;
    const gapE = lastBeatIdx >= 0 ? beatFeat.minEnergy[lastBeatIdx] : before;
    const silenceGap = gapE < 0.45 * before && after - gapE > 0.4 && after > 0.55;
    if ((jump > 0.2 && after > 0.55) || (bassJump > 0.3 && after > 0.6) || silenceGap) {
      const strength = clamp(jump * 1.4 + Math.max(0, bassJump) * 0.8 + (silenceGap ? 0.35 : 0), 0, 1.5);
      const prevDrop = drops[drops.length - 1];
      if (prevDrop && t - prevDrop.t < 6) {
        if (strength > prevDrop.strength) drops[drops.length - 1] = { t, bar: k, strength, silenceGap };
        continue;
      }
      drops.push({ t, bar: k, strength, silenceGap });
    }
  }

  // ---- Builds: a steady rise in brightness / density / energy leading into a drop -----
  const buildX = barE.map((e, k) => barTreble[k] + 0.6 * barDensity[k] + 0.3 * e);
  const builds = [];
  for (const d of drops) {
    const k = d.bar;
    let best = null;
    for (let s = k - 2; s >= Math.max(0, k - 8); s--) {
      const xs = buildX.slice(s, k);
      const m = xs.length;
      const mx = (m - 1) / 2;
      const my = xs.reduce((a, b) => a + b, 0) / m;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < m; i++) { sxy += (i - mx) * (xs[i] - my); sxx += (i - mx) ** 2; syy += (xs[i] - my) ** 2; }
      const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
      const rise = Math.max(buildX[k - 1], buildX[k - 2] ?? 0) - buildX[s];
      const score = rise * r;
      if (r > 0.6 && rise > 0.3 && (!best || score > best.score)) best = { s, score, rise };
    }
    if (best) {
      builds.push({ start: beatTimes[barStarts[best.s]], end: d.t, bars: k - best.s, strength: clamp(best.rise, 0, 1.5), bar: best.s });
    }
  }

  // ---- Boundary candidates at bar starts ------------------------------------------
  const novAtBar = barStarts.map((s) => Math.max(novelty[s] ?? 0, novelty[s - 1] ?? 0, novelty[s + 1] ?? 0));
  const nm = mean(Float32Array.from(novAtBar));
  let nv = 0;
  for (const v of novAtBar) nv += (v - nm) ** 2;
  const ns = Math.sqrt(nv / Math.max(1, nBars)) || 1;

  const cands = [];
  for (let k = 1; k < nBars; k++) {
    const t = beatTimes[barStarts[k]];
    if (t < musicStart + 2 || t > musicEnd - 2) continue;
    const z = (novAtBar[k] - nm) / ns;
    const localMax = novAtBar[k] >= (novAtBar[k - 1] ?? 0) && novAtBar[k] >= (novAtBar[k + 1] ?? 0);
    const dE = avgBars(barE, k, k + 2) - avgBars(barE, k - 2, k);
    const dB = avgBars(barBass, k, k + 2) - avgBars(barBass, k - 2, k);
    const dT = avgBars(barTreble, k, k + 2) - avgBars(barTreble, k - 2, k);
    const dD = avgBars(barDensity, k, k + 2) - avgBars(barDensity, k - 2, k);
    let strength = (localMax ? Math.max(0, z) : Math.max(0, z) * 0.4) + 4.0 * Math.abs(dE) + 1.5 * Math.abs(dB) + 1.6 * Math.abs(dT) + 1.2 * Math.abs(dD);
    const isDrop = drops.some((d) => d.bar === k);
    const isBuild = builds.some((b) => b.bar === k && b.bars >= 3);
    if (isDrop) strength += 3;
    if (isBuild) strength += 2.5;
    cands.push({ k, t, z, strength, dE, dB, dT, dD, strong: isDrop || isBuild || Math.abs(dE) > 0.28 });
  }
  cands.sort((a, b) => b.strength - a.strength);
  const maxSections = Math.max(2, Math.round((musicEnd - musicStart) / 11));
  const chosen = [];
  const threshold = 1.15;
  for (const c of cands) {
    if (chosen.length >= maxSections - 1) break;
    if (c.strength < threshold) break;
    if (chosen.some((o) => Math.abs(o.k - c.k) < (c.strong && o.strong ? 2 : 4))) continue;
    if (c.k < 2 && !c.strong) continue;
    if (nBars - c.k < 2) continue;
    chosen.push(c);
  }
  chosen.sort((a, b) => a.k - b.k);

  // ---- Build sections -------------------------------------------------------------
  const bounds = [0, ...chosen.map((c) => barStarts[c.k]), B];
  const sections = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    const start = i === 0 ? 0 : beatTimes[a];
    const end = i === bounds.length - 2 ? duration : beatTimes[b];
    sections.push(makeSection(start, end, a, b, beatFeat, 2, '', i));
  }

  // ---- Levels (0 ambient … 3 high, 4 climax), relative to the loudest section ---------
  const scores = sections.map((s) => 0.45 * s.energy + 0.15 * s.density + 0.2 * s.bass + 0.2 * s.treble);
  const minS = Math.min(...scores);
  const maxS = Math.max(...scores);
  const span = maxS - minS;
  sections.forEach((s, i) => {
    s.score = scores[i];
    if (span < 0.08) {
      // Uniform track: grade on absolute intensity instead.
      s.level = scores[i] > 0.55 ? 3 : scores[i] > 0.35 ? 2 : scores[i] > 0.18 ? 1 : 0;
    } else {
      const rel = (scores[i] - minS) / span;
      if (scores[i] >= 0.9 * maxS && rel >= 0.75) s.level = 3;
      else if (rel >= 0.45) s.level = 2;
      else if (rel >= 0.2) s.level = 1;
      else s.level = 0;
    }
    // Near-silent sections are ambient regardless of rank.
    if (s.energy < 0.12) s.level = 0;
  });

  // Climax: the last high section (or the loudest one if it clearly dominates).
  const highIdx = sections.map((s, i) => (s.level >= 3 ? i : -1)).filter((i) => i >= 0);
  if (highIdx.length) {
    let climax = highIdx[highIdx.length - 1];
    const loudest = highIdx.reduce((best, i) => (scores[i] > scores[best] ? i : best), highIdx[0]);
    if (scores[loudest] > scores[climax] * 1.12) climax = loudest;
    sections[climax].level = 4;
    sections[climax].climax = true;
  }
  const lastHigh = highIdx.length ? highIdx[highIdx.length - 1] : -1;

  // ---- Labels -------------------------------------------------------------------------
  sections.forEach((s, i) => {
    const prev = sections[i - 1];
    const startsWithDrop = drops.some((d) => Math.abs(d.t - s.start) < 0.05);
    const inBuild = builds.some((b) => s.start >= b.start - 0.05 && s.end <= b.end + 0.05);
    const bassHeavy = s.bass > 0.62;
    const allQuietAfter = sections.slice(i).every((x) => x.level <= 1);
    if (i === 0 && s.level <= 1) s.label = 'Intro';
    else if (inBuild && s.level <= 3) s.label = 'Build';
    else if (s.level >= 3) {
      if (s.climax) s.label = startsWithDrop && bassHeavy ? 'Final Drop' : 'Final Chorus';
      else s.label = startsWithDrop && bassHeavy ? 'Drop' : 'Chorus';
    } else if (i > lastHigh && lastHigh >= 0 && allQuietAfter) s.label = 'Outro';
    else if (i === sections.length - 1 && s.level <= 1) s.label = 'Outro';
    else if (s.level === 2) s.label = 'Verse';
    else if (prev && prev.level >= 3) s.label = 'Breakdown';
    else s.label = i === 0 ? 'Intro' : 'Interlude';
    if (s.label === 'Build' && s.level >= 3) s.level = 2;
  });

  // Repeated material: cluster sections by chroma/timbre similarity.
  assignClusters(sections, beatChroma, Xs, dims, norms);

  return { sections, drops, builds, novelty, debug: { cands, barE, barTreble, barDensity, barBass, barTimes: barStarts.map((b) => beatTimes[b]) } };
}

function makeSection(start, end, beatA, beatB, beatFeat, level, label, index) {
  const avg = (k) => mean(beatFeat[k], beatA, Math.max(beatA + 1, beatB));
  const half = Math.max(beatA + 1, Math.floor((beatA + beatB) / 2));
  return {
    index,
    start,
    end,
    beatStart: beatA,
    beatEnd: beatB,
    energy: avg('energy'),
    bass: avg('bass'),
    treble: avg('treble'),
    brightness: avg('brightness'),
    density: avg('density'),
    vocal: avg('vocal'),
    slope: mean(beatFeat.energy, half, beatB) - mean(beatFeat.energy, beatA, half),
    level,
    label,
    climax: false,
    cluster: index,
  };
}

function assignClusters(sections, beatChroma, Xs, dims, norms) {
  const vecs = sections.map((s) => {
    const v = new Float32Array(dims);
    const a = s.beatStart, b = Math.max(s.beatStart + 1, s.beatEnd);
    for (let i = a; i < b; i++) for (let d = 0; d < dims; d++) v[d] += Xs[i * dims + d] / norms[i];
    let n = 0;
    for (let d = 0; d < dims; d++) n += v[d] * v[d];
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < dims; d++) v[d] /= n;
    return v;
  });
  const reps = [];
  sections.forEach((s, i) => {
    let found = -1;
    for (const r of reps) {
      let sim = 0;
      for (let d = 0; d < dims; d++) sim += vecs[i][d] * vecs[r][d];
      if (sim > 0.9 && Math.abs(sections[r].level - s.level) <= 1) { found = sections[r].cluster; break; }
    }
    if (found >= 0) s.cluster = found;
    else { s.cluster = i; reps.push(i); }
  });
}
