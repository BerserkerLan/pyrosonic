import { Rng } from './rng.js';
import { buildPalette, colorForHue, pitchClassHue } from './palettes.js';
import { eventTiming, estimateCost } from './shells.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function sample(series, rate, t) {
  const n = series.length;
  if (!n) return 0;
  const x = t * rate;
  if (x <= 0) return series[0];
  if (x >= n - 1) return series[n - 1];
  const i = Math.floor(x);
  const f = x - i;
  return series[i] * (1 - f) + series[i + 1] * f;
}

/** Index of the first element with .t >= t (list sorted by t). */
function lowerBound(list, t) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function nearest(list, t, tol) {
  const i = lowerBound(list, t);
  let best = null;
  let bd = tol;
  for (const j of [i - 1, i]) {
    const o = list[j];
    if (o && Math.abs(o.t - t) <= bd) { best = o; bd = Math.abs(o.t - t); }
  }
  return best;
}

const STRUCTURE_WEIGHTS = [
  { willow: 3, kamuro: 1.2, peony: 1.5, ring: 1, dahlia: 1, horsetail: 0.6 },
  { peony: 3, dahlia: 1.5, willow: 1.5, ring: 1, chrysanthemum: 2, horsetail: 0.5 },
  { chrysanthemum: 3, peony: 2.5, dahlia: 1.5, crossette: 1, palm: 1, ring: 1, willow: 0.8 },
  { chrysanthemum: 3, peony: 2, palm: 1.5, kamuro: 1, crackle: 1.2, ring: 0.8, strobe: 0.6, dahlia: 0.8 },
  { kamuro: 2.5, chrysanthemum: 2.5, palm: 1.5, crackle: 1.6, peony: 1.2, willow: 0.8, strobe: 0.7 },
];
const BEAT_WEIGHTS = { peony: 3, dahlia: 1, crossette: 1, glitter: 1.2, chrysanthemum: 0.8 };
const SNARE_WEIGHTS = { crossette: 2, strobe: 1, crackle: 1, glitter: 0.8 };
const METALLIC = new Set(['willow', 'kamuro', 'horsetail']);

const PRIORITY = { finale: 6, accent: 5, lyric: 4.5, structure: 4, build: 3.5, ground: 3, beat: 2, snare: 2, melody: 1.5, hat: 1 };

/**
 * Turn a song analysis into a list of pyrotechnic events.
 *
 * Every aerial shell is timed so that it *bursts* on its musical moment —
 * launches are back-computed from the flight time — which is what makes the
 * show feel locked to the music.
 *
 * @param analysis   result of analyzeAudio()
 * @param opts       {intensity: 0.5..1.6, lyricCues: [{t, kind, color, word}], seed}
 */
export function choreograph(analysis, opts = {}) {
  const A = analysis;
  const intensity = clamp(opts.intensity ?? 1, 0.4, 1.8);
  const seed = opts.seed ?? 1;
  const rng = new Rng(seed);
  const cues = (opts.lyricCues || []).slice().sort((a, b) => a.t - b.t);
  const env = A.env;
  const E = (t) => sample(env.energy, env.rate, t);
  const BASS = (t) => sample(env.bass, env.rate, t);
  const TREB = (t) => sample(env.treble, env.rate, t);
  const BRIGHT = (t) => sample(env.brightness, env.rate, t);
  const DENS = (t) => sample(env.density, env.rate, t);
  const VOC = (t) => sample(env.vocal, env.rate, t);
  const PRES = env.presence ? (t) => sample(env.presence, env.rate, t) : (t) => (E(t) > 0.03 ? 1 : 0);
  const period = clamp(A.tempo.period || 0.5, 0.25, 1.5);
  const bpm = 60 / period;
  const fast = bpm > 150;
  const beatConf = A.tempo.confidence ?? 0.5;
  const kicks = A.onsets.kick;
  const snares = A.onsets.snare;
  const hats = A.onsets.hat;
  const allOnsets = A.onsets.all;
  const melody = A.melody || [];
  const events = [];

  const add = (ev) => {
    if (!(ev.t >= 0) || ev.t > A.duration + 0.5) return null;
    ev.seed = rng.seed32();
    ev.z = ev.z ?? rng.range(-1, 1);
    ev.intensity = ev.intensity ?? clamp(0.85 + 0.35 * E(ev.t), 0.7, 1.25);
    if (ev.lx === undefined) ev.lx = clamp(ev.x + rng.range(-0.06, 0.06), -1, 1);
    events.push(ev);
    return ev;
  };

  // ---- Palettes, consistent per repeated section ------------------------------------------
  const clusterPalette = new Map();
  const palettes = A.sections.map((s, i) => {
    const chord = A.chords.find((c) => c.t >= s.start - 0.05);
    const root = chord && chord.confidence > 0.3 ? chord.root : A.key.tonic;
    if (clusterPalette.has(s.cluster) && !s.climax) return clusterPalette.get(s.cluster).slice();
    const pal = buildPalette({ root, mode: A.key.mode, level: s.level, brightness: s.brightness, rng: new Rng(seed + i * 7919) });
    clusterPalette.set(s.cluster, pal);
    return pal.slice();
  });
  for (let i = 1; i < palettes.length; i++) {
    if (palettes[i][0] === palettes[i - 1][0] && A.sections[i].cluster !== A.sections[i - 1].cluster && palettes[i].length > 1) {
      palettes[i] = [palettes[i][1], palettes[i][0], ...palettes[i].slice(2)];
    }
  }

  // ---- Lyric colour overrides (a line that sings "red" paints the sky red) ---------------
  const colorWindows = cues.filter((c) => c.kind === 'color').map((c) => ({ start: c.lineStart ?? c.t, end: c.lineEnd ?? c.t + 4, color: c.color }));
  const lyricColorAt = (t) => {
    for (const w of colorWindows) if (t >= w.start && t <= w.end) return w.color;
    return null;
  };

  // Chord colour for a bar.
  const chordColorAt = (t) => {
    const i = lowerBound(A.chords, t + 0.05) - 1;
    const c = A.chords[Math.max(0, i)];
    return c && c.confidence > 0.45 ? colorForHue(pitchClassHue(c.root)) : null;
  };

  const sectionAt = (t) => {
    for (const s of A.sections) if (t >= s.start && t < s.end) return s;
    return A.sections[A.sections.length - 1];
  };

  const inBuild = (t) => A.builds.some((b) => t >= b.start && t < b.end);

  // Pre-drop blackouts: the silent moment right before a drop stays dark.
  const blackouts = [];
  for (const d of A.drops) {
    if (!d.silenceGap) continue;
    // Find the quiet stretch inside the last ~beat before the drop.
    const floor = Math.min(0.32, E(d.t + period) * 0.45);
    let end = -1;
    for (let s = d.t - 0.02; s > d.t - period * 1.25; s -= 0.01) {
      if (E(s) < floor) { end = s; break; }
    }
    if (end < 0) continue;
    let start = end;
    while (start > d.t - period * 2 && E(start - 0.01) < floor) start -= 0.01;
    // Smoothing smears the drop's attack backwards; treat everything up to it as dark.
    if (end - start > 0.06 || d.t - start > 0.12) blackouts.push({ start: start - 0.02, end: d.t - 0.03 });
  }
  const inBlackout = (t) => blackouts.some((b) => t > b.start && t < b.end);

  // ---- Main pass: walk every beat of every section --------------------------------------------
  let prevType = null;
  const lastByLayer = {};
  const canFire = (layer, t, gap) => {
    const last = lastByLayer[layer] ?? -1e9;
    if (t - last < gap) return false;
    lastByLayer[layer] = t;
    return true;
  };

  A.sections.forEach((sec, si) => {
    const pal = palettes[si];
    const level = sec.level;
    const secBeats = A.beats.filter((b) => b.t >= sec.start - 0.02 && b.t < sec.end - 0.02);
    let barInSec = -1;
    let phrase = 0;
    const isDropStart = A.drops.some((d) => Math.abs(d.t - sec.start) < 0.08 && d.strength > 0.45);
    const quietEverywhere = PRES((sec.start + sec.end) / 2) < 0.2 && sec.energy < 0.03;
    if (quietEverywhere) return;

    secBeats.forEach((b, bi) => {
      const t0 = b.t;
      if (PRES(t0) < 0.5 || inBlackout(t0)) return;
      const isDown = b.beatInBar === 0;
      if (isDown) barInSec++;
      const barIdx = Math.max(0, barInSec);
      phrase = Math.floor(barIdx / 4);
      const kick = nearest(kicks, t0, 0.07);
      const tHit = kick ? kick.t : t0;
      const ctx = { sustain: 1 - DENS(t0), bright: BRIGHT(t0), bass: BASS(t0), prev: prevType };
      const building = inBuild(t0);
      const chordCol = chordColorAt(t0);
      const lyricCol = lyricColorAt(t0);
      const primary = lyricCol || (chordCol && rng.chance(0.45) ? chordCol : pal[barIdx % 2 === 0 ? 0 : Math.min(1, pal.length - 1)]);
      const secondary = pal.find((c) => c !== primary) || pal[0];
      const accent = pal[pal.length - 1];

      // -- Structure layer: downbeats ---------------------------------------------------
      const every = level === 0 ? (bpm > 110 ? 4 : 2) : level === 1 && bpm > 140 ? 2 : 1;
      if (isDown && barIdx % every === 0 && !(bi === 0 && isDropStart)) {
        let n = [1, 1, 1, 3, 3][level];
        if (level === 2 && rng.chance(0.35 * intensity)) n = 2;
        if (level === 4 && rng.chance(0.4 * intensity)) n = 5;
        if (intensity < 0.75 && n > 1) n = n === 5 ? 3 : 1;
        if (building) n = 1;
        const slots = n === 1 ? [[0], [-0.45], [0.45], [-0.22], [0.22]][(barIdx + phrase) % 5] : n === 2 ? [[-0.5, 0.5], [-0.7, 0.7], [-0.32, 0.32]][phrase % 3] : n === 3 ? [[-0.62, 0, 0.62], [-0.78, 0, 0.78], [-0.4, 0, 0.4]][phrase % 3] : [-0.8, -0.4, 0, 0.4, 0.8];
        const type = pickType(rng, STRUCTURE_WEIGHTS[Math.min(4, level)], ctx);
        prevType = type;
        const variant = variantFor(type, rng);
        const fan = n >= 3;
        slots.forEach((x, k) => {
          const centre = 1 - Math.abs(x);
          add({
            t: tHit,
            type,
            variant,
            x,
            lx: fan ? x * 0.45 : undefined,
            y: clamp([0.82, 0.74, 0.7, 0.66, 0.7][level] + centre * 0.18 + rng.range(-0.05, 0.05), 0.35, 0.98),
            z: fan ? 0 : undefined,
            size: clamp([0.82, 0.68, 0.7, 0.78, 0.86][level] + rng.range(-0.08, 0.08) + (fan && x === 0 ? 0.08 : 0), 0.3, 1),
            colors: colorsFor(type, k % 2 ? secondary : primary, k % 2 ? primary : secondary, accent),
            layer: 'structure',
          });
        });
      }

      // -- Phrase accents (start of each 4-bar phrase) ------------------------------------------
      if (isDown && barIdx > 0 && barIdx % 4 === 0 && level >= 1 && !building) {
        const third = secBeats[bi + 2];
        const t = third && third.t - t0 < period * 2.6 ? third.t : tHit + period * 2;
        if (level <= 2) {
          const type = rng.pick(['ring', 'palm', 'dahlia']);
          add({ t, type, variant: type === 'ring' ? rng.pick(['double', 'saturn', '']) : '', x: rng.pick([-0.25, 0, 0.25]), y: 0.62, size: 0.6, colors: [secondary, primary, accent], layer: 'accent' });
        } else {
          add({ t, type: 'palm', x: -0.55, y: 0.55, size: 0.65, colors: ['gold', primary], layer: 'accent' });
          add({ t, type: 'palm', x: 0.55, y: 0.55, size: 0.65, colors: ['gold', primary], layer: 'accent' });
          if (intensity >= 1) add({ t, type: 'ring', variant: 'saturn', x: 0, y: 0.8, size: 0.75, colors: [secondary, primary], layer: 'accent' });
        }
      }

      if (building) return; // builds are handled by their own riser choreography

      // -- Beat layer ---------------------------------------------------------------------------
      if (!isDown && level >= 2) {
        const want = level >= 4 && !fast ? true : b.beatInBar === 2;
        if (want && (beatConf > 0.25 || kick)) {
          const side = (b.bar + b.beatInBar) % 2 ? 1 : -1;
          const sweep = [-0.7, -0.25, 0.25, 0.7][b.beatInBar];
          const type = pickType(rng, level >= 3 ? { ...BEAT_WEIGHTS, chrysanthemum: 1.4, crackle: 0.6 } : BEAT_WEIGHTS, ctx);
          const xs = level >= 4 && intensity >= 0.9 ? [sweep, -sweep] : [level >= 3 && phrase % 2 ? sweep : side * rng.range(0.35, 0.6)];
          xs.forEach((x) =>
            add({ t: tHit, type, variant: variantFor(type, rng), x, y: rng.range(0.38, 0.6), size: rng.range(0.32, 0.5), colors: colorsFor(type, secondary, primary, accent), layer: 'beat' }),
          );
        }
      }

      // -- Ground layer: mines on kicks ------------------------------------------------------
      if (level >= 3 && kick && kick.s > 0.35) {
        const allow = level >= 4 ? true : isDown || b.beatInBar === 2;
        if (allow && canFire('mine', tHit, period * 0.9) && rng.chance(0.75 * intensity)) {
          const x = [-0.75, 0.75, -0.35, 0.35, 0][(b.bar * 4 + b.beatInBar) % 5];
          add({ t: tHit, type: 'mine', x, y: 0, z: rng.range(-0.3, 0.3), size: rng.range(0.4, 0.7), colors: [primary, accent], layer: 'ground' });
        }
      }

      // -- Fountains at phrase starts (L3) / throughout (L4) --------------------------------
      if (isDown && level >= 3 && (barIdx % 4 === 0 || (level >= 4 && barIdx % 2 === 0))) {
        const dur = Math.min(sec.end - tHit, period * 4 * (level >= 4 ? 2 : 2)) - 0.1;
        if (dur > 1) {
          const xs = level >= 4 ? [-0.86, -0.43, 0, 0.43, 0.86] : [-0.6, 0, 0.6];
          xs.forEach((x) => add({ t: tHit, type: 'fountain', x, y: 0, z: 0, dur, size: level >= 4 ? 0.8 : 0.55, colors: [rng.chance(0.5) ? 'gold' : 'white'], layer: 'ground' }));
        }
      }
    });
  });

  // ---- Snare layer: crisp crossettes / strobes on the backbeat --------------------------------
  const snareEvent = (t, sec, pair) => {
    const pal = palettes[A.sections.indexOf(sec)];
    const type = pickType(rng, SNARE_WEIGHTS, { sustain: 0, bright: BRIGHT(t), bass: 0, prev: null });
    const x = rng.range(0.4, 0.75);
    const col = pal.includes('white') ? 'white' : pal.includes('silver') ? 'silver' : pal[pal.length - 1];
    const near = nearest(A.beats, t, 0.12);
    const side = (near ? near.bar : 0) % 2 ? 1 : -1;
    (pair ? [-x, x] : [side * x]).forEach((xx) =>
      add({ t, type, x: xx, y: rng.range(0.3, 0.48), size: rng.range(0.3, 0.42), colors: [col, pal[0]], layer: 'snare' }));
  };
  for (const b of A.beats) {
    if (b.beatInBar !== 1 && b.beatInBar !== 3) continue;
    const sec = sectionAt(b.t);
    if (sec.level < 2 || inBuild(b.t) || inBlackout(b.t) || PRES(b.t) < 0.6) continue;
    if (sec.level === 2 && b.beatInBar !== 3) continue;
    const sn = nearest(snares, b.t, 0.07);
    if (!sn || sn.s < 0.5) continue;
    if (!canFire('snare', sn.t, period * 0.8)) continue;
    snareEvent(sn.t, sec, sec.level >= 4 || (sec.level >= 3 && intensity > 1.1));
  }
  // Big off-beat hits (syncopated claps, rim shots) in the most intense sections.
  for (const sn of snares) {
    const sec = sectionAt(sn.t);
    if (sec.level < 4 || sn.s < 1.15 || inBuild(sn.t) || inBlackout(sn.t)) continue;
    if (nearest(A.beats, sn.t, 0.1)) continue;
    if (!canFire('offbeat', sn.t, period * 1.5)) continue;
    snareEvent(sn.t, sec, false);
  }

  // ---- Hi-hat sparkle layer ----------------------------------------------------------------
  for (const h of hats) {
    const sec = sectionAt(h.t);
    if (sec.level < 3 || inBuild(h.t) || inBlackout(h.t) || TREB(h.t) < 0.45 || h.s < 0.3) continue;
    const gap = sec.level >= 4 ? 0.26 : 0.48;
    if (!canFire('hat', h.t, gap / intensity)) continue;
    const pal = palettes[A.sections.indexOf(sec)];
    add({ t: h.t, type: 'glitter', x: rng.range(-0.92, 0.92), y: rng.range(0.1, 0.3), size: rng.range(0.05, 0.18), colors: [rng.chance(0.5) ? 'gold' : 'white', pal[0]], layer: 'hat', z: rng.range(-1, 1) });
  }

  // ---- Melody / vocal layer for calmer sections ------------------------------------------------
  {
    let phase = rng.range(0, 6);
    // Judge onset strength against its neighbourhood so quiet passages still count.
    const localMax = (i) => {
      let m = 1e-6;
      const t = allOnsets[i].t;
      for (let j = i; j >= 0 && allOnsets[j].t > t - 3; j--) m = Math.max(m, allOnsets[j].s);
      for (let j = i; j < allOnsets.length && allOnsets[j].t < t + 3; j++) m = Math.max(m, allOnsets[j].s);
      return m;
    };
    for (let oi = 0; oi < allOnsets.length; oi++) {
      const o = allOnsets[oi];
      const sec = sectionAt(o.t);
      if (sec.level > 2 || inBuild(o.t) || VOC(o.t) < 0.45 || PRES(o.t) < 0.6) continue;
      if (o.s / localMax(oi) < 0.35) continue;
      const gap = sec.level <= 1 ? 0.75 : 0.55;
      if (!canFire('melody', o.t, gap / intensity)) continue;
      // Skip if a bigger event is bursting right now.
      const clash = events.some((e) => (e.layer === 'structure' || e.layer === 'accent') && Math.abs(e.t - o.t) < 0.3);
      if (clash) continue;
      const m = nearest(melody, o.t, 0.15);
      const midi = m ? m.midi : 60;
      phase += 0.55;
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      add({
        t: o.t,
        type: rng.chance(0.7) ? 'comet' : 'glitter',
        variant: rng.chance(0.35) ? 'pop' : '',
        x: Math.sin(phase) * 0.72,
        y: clamp((midi - 48) / 34, 0.18, 0.9),
        size: 0.35,
        colors: [colorForHue(pitchClassHue(pc)), 'white'],
        layer: 'melody',
      });
    }
  }

  // ---- Builds: rising comets that accelerate into the drop ---------------------------------
  for (const bld of A.builds) {
    const len = bld.end - bld.start;
    if (len < period * 4) continue;
    const pal = palettes[A.sections.indexOf(sectionAt(bld.end + 0.1))] || ['gold', 'white'];
    const grid = A.beats.filter((b) => b.t >= bld.start - 0.02 && b.t < bld.end - 0.02);
    let i = 0;
    let lastT = -1e9;
    grid.forEach((b, gi) => {
      const next = grid[gi + 1] ? grid[gi + 1].t : bld.end;
      const span = next - b.t;
      const p = (b.t - bld.start) / len;
      const subdiv = p < 0.5 ? 1 : p < 0.78 ? 2 : 4;
      for (let j = 0; j < subdiv; j++) {
        const t = b.t + (span * j) / subdiv;
        if (t - lastT < 1 / (8 * intensity) || inBlackout(t) || PRES(t) < 0.5) continue;
        const pp = (t - bld.start) / len;
        const spread = 0.85 - 0.45 * pp;
        add({
          t,
          type: 'comet',
          variant: pp > 0.6 ? 'pop' : '',
          x: Math.sin(i * 1.1) * spread,
          y: 0.22 + 0.62 * pp,
          size: 0.35 + 0.3 * pp,
          colors: [i % 3 === 2 ? 'white' : pal[i % 2 === 0 ? 0 : Math.min(1, pal.length - 1)], 'white'],
          layer: 'build',
        });
        lastT = t;
        i++;
      }
    });
  }

  // ---- Drops: salute + fan + mines --------------------------------------------------------------
  for (const d of A.drops) {
    const sec = sectionAt(d.t + 0.05);
    const pal = palettes[A.sections.indexOf(sec)];
    const big = d.strength > 0.8 || d.silenceGap;
    const xs = big ? [-0.82, -0.41, 0, 0.41, 0.82] : [-0.6, 0, 0.6];
    const type = big ? 'chrysanthemum' : 'peony';
    if (big) add({ t: d.t, type: 'salute', x: 0, lx: 0, y: 0.84, z: 0, size: 0.9, colors: ['white'], layer: 'accent' });
    xs.forEach((x, k) =>
      add({ t: d.t, type, variant: 'pistil', x, lx: x * 0.4, y: 0.62 + (1 - Math.abs(x)) * 0.28, z: 0, size: 0.9, colors: [pal[k % pal.length], pal[(k + 1) % pal.length], 'white'], layer: 'accent' }),
    );
    const mines = big ? [-0.86, -0.52, -0.17, 0.17, 0.52, 0.86] : [-0.5, 0.5];
    mines.forEach((x, k) => add({ t: d.t, type: 'mine', x, y: 0, z: 0, size: 0.8, colors: [pal[k % pal.length], 'white'], layer: 'accent' }));
  }

  // ---- Finale: barrage at the end of the climax ---------------------------------------------------
  const climax = A.sections.find((s) => s.climax);
  let finaleEnd = null;
  if (climax) {
    const barLen = period * 4;
    const fStart = Math.max(climax.start, climax.end - barLen * 2);
    const pal = palettes[A.sections.indexOf(climax)];
    let i = 0;
    const grid = A.beats.filter((b) => b.t >= fStart - 0.02 && b.t < climax.end - 0.05);
    grid.forEach((b, gi) => {
      const next = grid[gi + 1] ? grid[gi + 1].t : b.t + period;
      for (const tt of [b.t, b.t + (next - b.t) / 2]) {
        if (tt >= climax.end - 0.05 || PRES(tt) < 0.6) continue;
        const type = rng.pick(['peony', 'chrysanthemum', 'crackle', 'kamuro', 'peony']);
        const x = ((i * 0.618) % 1) * 1.8 - 0.9;
        add({ t: tt, type, x, y: rng.range(0.45, 0.92), size: rng.range(0.55, 0.85), colors: colorsFor(type, pal[i % pal.length], pal[(i + 1) % pal.length], 'white'), layer: 'finale' });
        i++;
      }
    });
    // Final crown on the closing downbeat if the music is still loud there; otherwise on the last strong onset.
    const closing = nearest(A.beats, climax.end, period * 0.6);
    let tEnd = closing ? closing.t : climax.end;
    if (E(tEnd) < 0.15) {
      const strong = allOnsets.filter((o) => o.t > climax.end - 4 && o.t < climax.end + 1 && o.s > 0.4);
      if (strong.length) tEnd = strong[strong.length - 1].t;
    }
    if (tEnd <= A.musicEnd + 0.1) {
      finaleEnd = tEnd;
      [-0.5, 0, 0.5].forEach((x) => add({ t: tEnd, type: 'kamuro', x, lx: x * 0.4, y: 0.82 + (x === 0 ? 0.12 : 0), z: 0, size: 1, colors: ['gold'], layer: 'finale' }));
      add({ t: tEnd, type: 'salute', x: -0.25, y: 0.7, z: 0, size: 0.8, colors: ['white'], layer: 'finale' });
      add({ t: tEnd, type: 'salute', x: 0.25, y: 0.7, z: 0, size: 0.8, colors: ['white'], layer: 'finale' });
      add({ t: tEnd, type: 'crackle', x: 0, y: 0.6, z: 0, size: 0.9, colors: ['gold'], layer: 'finale' });
    }
  }

  // ---- Farewell: a last golden willow on the final musical moment ------------------------------
  {
    const lastSec = A.sections[A.sections.length - 1];
    if (!climax || lastSec !== climax) {
      const tail = A.beats.filter((b) => b.beatInBar === 0 && b.t < A.musicEnd - 0.5 && PRES(b.t) > 0.6);
      const lastDown = tail[tail.length - 1];
      if (lastDown && (!finaleEnd || lastDown.t - finaleEnd > 4)) {
        add({ t: lastDown.t, type: 'willow', x: 0, y: 0.92, z: 0, size: 1, colors: ['gold'], layer: 'finale' });
        add({ t: lastDown.t + period * 2, type: 'kamuro', x: -0.45, y: 0.8, z: 0, size: 0.8, colors: ['gold'], layer: 'finale' });
        add({ t: lastDown.t + period * 2, type: 'kamuro', x: 0.45, y: 0.8, z: 0, size: 0.8, colors: ['gold'], layer: 'finale' });
      }
    }
  }

  // ---- Lyric cues ---------------------------------------------------------------------------------
  let lastCue = -1e9;
  for (const c of cues) {
    if (c.kind === 'color' || c.t - lastCue < 1.4 || c.t > A.duration || inBlackout(c.t)) continue;
    const sec = sectionAt(c.t);
    const pal = palettes[A.sections.indexOf(sec)];
    const x = rng.pick([-0.3, 0, 0.3]);
    const base = { t: c.t, x, y: rng.range(0.66, 0.82), size: 0.7, layer: 'lyric', word: c.word };
    switch (c.kind) {
      case 'heart': add({ ...base, type: 'heart', colors: [rng.pick(['pink', 'red', 'magenta'])] }); break;
      case 'star': add({ ...base, type: 'star', colors: [rng.pick(['gold', 'white', 'yellow'])] }); break;
      case 'fire': add({ ...base, type: 'crackle', colors: [rng.pick(['red', 'orange'])] }); add({ ...base, x: -x || 0.4, type: 'peony', colors: ['orange', 'red'] }); break;
      case 'gold': add({ ...base, type: 'kamuro', colors: ['gold'], size: 0.85 }); break;
      case 'rain': add({ ...base, type: 'willow', colors: ['silver', 'blue'], variant: 'tipped' }); break;
      case 'sky': add({ ...base, type: 'chrysanthemum', y: 0.97, size: 0.95, colors: [pal[0], 'white'] }); break;
      case 'night': add({ ...base, type: 'strobe', colors: ['white'] }); add({ ...base, x: -x || -0.4, type: 'peony', colors: ['violet', 'blue'] }); break;
      case 'boom': add({ ...base, type: 'salute', y: 0.75, colors: ['white'] }); add({ ...base, type: 'chrysanthemum', y: 0.85, size: 0.9, colors: [pal[0], pal[1] || 'white'] }); break;
      case 'dance': [-0.5, 0.5].forEach((xx) => add({ ...base, x: xx, type: 'crossette', colors: [pal[0], 'white'] })); break;
      case 'rainbow':
        ['red', 'orange', 'yellow', 'green', 'blue', 'violet'].forEach((col, k) => add({ ...base, t: c.t + k * 0.09, x: -0.75 + k * 0.3, y: 0.7 + Math.sin((k / 5) * Math.PI) * 0.2, type: 'peony', variant: 'mono', size: 0.5, colors: [col] }));
        break;
      case 'ring': add({ ...base, type: 'ring', variant: 'double', colors: [pal[0], pal[1] || 'gold'] }); break;
      default: add({ ...base, type: 'peony', colors: [pal[0]] });
    }
    lastCue = c.t;
  }

  // ---- Clean-up: blackout windows, near-duplicates, particle budget -------------------------------
  let list = events.filter((e) => !(inBlackout(e.t) && e.layer !== 'accent' && e.layer !== 'finale'));
  // Merge exact duplicates (same type, ~same time and place).
  list.sort((a, b) => a.t - b.t);
  const dedup = [];
  for (const e of list) {
    const dup = dedup.slice(-12).some((o) => o.type === e.type && Math.abs(o.t - e.t) < 0.05 && Math.abs(o.x - e.x) < 0.12);
    if (!dup) dedup.push(e);
  }
  list = dedup;

  // Particle budget: keep the sky readable and the GPU happy.
  const budget = 11000 * clamp(intensity, 0.8, 1.3);
  const binW = 0.25;
  const nBins = Math.ceil((A.duration + 12) / binW) + 1;
  const load = new Float32Array(nBins);
  const byPriority = list.slice().sort((a, b) => (PRIORITY[b.layer] ?? 1) - (PRIORITY[a.layer] ?? 1) || a.t - b.t);
  const keep = new Set();
  for (const e of byPriority) {
    const { end } = eventTiming(e);
    const a = Math.max(0, Math.floor(e.t / binW));
    const b = Math.min(nBins - 1, Math.ceil(end / binW));
    const cost = estimateCost(e);
    let peak = 0;
    for (let i = a; i <= b; i++) if (load[i] > peak) peak = load[i];
    const pr = PRIORITY[e.layer] ?? 1;
    const limit = pr >= 5 ? budget * 1.6 : pr >= 4 ? budget * 1.2 : budget;
    if (peak + cost > limit) continue;
    for (let i = a; i <= b; i++) load[i] += cost;
    keep.add(e);
  }
  list = list.filter((e) => keep.has(e));

  // Final ordering by launch time, with precomputed timing for the runner.
  for (const e of list) {
    const { launch, end } = eventTiming(e);
    e.launch = launch;
    e.end = end;
  }
  list.sort((a, b) => a.launch - b.launch || a.t - b.t);

  const byType = {};
  const byLayer = {};
  for (const e of list) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    byLayer[e.layer] = (byLayer[e.layer] || 0) + 1;
  }
  let peakPerSec = 0;
  const byTime = list.map((e) => e.t).sort((a, b) => a - b);
  for (let i = 0, j = 0; i < byTime.length; i++) {
    while (byTime[j] < byTime[i] - 1) j++;
    peakPerSec = Math.max(peakPerSec, i - j + 1);
  }

  return {
    events: list,
    palettes,
    blackouts,
    stats: { total: list.length, byType, byLayer, peakPerSec, aerial: list.filter((e) => e.type !== 'mine' && e.type !== 'fountain').length },
  };
}

function pickType(rng, base, ctx) {
  const w = { ...base };
  const bump = (k, f, add = 0) => { if (k in w || add) w[k] = (w[k] || 0) * f + add; };
  if (ctx.sustain > 0.65) { bump('willow', 2, 0.1); bump('kamuro', 1.6); bump('horsetail', 1.4); bump('ring', 1.3); }
  if (ctx.bright > 0.65) { bump('crackle', 1.6, 0.05); bump('strobe', 1.5); bump('crossette', 1.5); }
  if (ctx.bass > 0.7) { bump('peony', 1.3); bump('chrysanthemum', 1.3); bump('palm', 1.2); }
  if (ctx.prev && w[ctx.prev]) w[ctx.prev] *= 0.45;
  return rng.weighted(w);
}

function variantFor(type, rng) {
  switch (type) {
    case 'peony':
    case 'chrysanthemum':
      return rng.chance(0.28) ? 'pistil' : '';
    case 'ring':
      return rng.pick(['', 'double', 'saturn']);
    case 'willow':
      return rng.chance(0.35) ? 'tipped' : '';
    default:
      return '';
  }
}

function colorsFor(type, a, b, accent) {
  if (METALLIC.has(type)) {
    const metal = a === 'silver' || a === 'white' ? 'silver' : 'gold';
    return [metal, a, b];
  }
  if (type === 'strobe') return ['white', a];
  if (type === 'crackle') return [a === 'white' || a === 'silver' ? 'gold' : a, 'gold'];
  return [a, b, accent];
}
