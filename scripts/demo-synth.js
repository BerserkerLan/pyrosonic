/**
 * Procedural demo track — "Skyline" (original composition, 126 BPM, A minor).
 *
 * Pure JavaScript so it runs identically in Node (tests, build script) and the
 * browser. The arrangement deliberately covers everything the show engine
 * reacts to: a quiet intro, a verse, a snare-roll build with a riser and a
 * pre-drop silence, a full drop, a breakdown, a second build, a final drop and
 * an outro with a closing chord.
 */

export const DEMO_BPM = 126;
const BEAT = 60 / DEMO_BPM;
const BAR = BEAT * 4;
const S16 = BEAT / 4;

// Section map in bars: [name, startBar, endBar)
export const DEMO_SECTIONS = [
  ['Intro', 0, 4],
  ['Verse', 4, 12],
  ['Build', 12, 20],
  ['Drop', 20, 36],
  ['Breakdown', 36, 44],
  ['Build', 44, 48],
  ['Final Drop', 48, 64],
  ['Outro', 64, 68],
];
export const DEMO_BARS = 68;

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/**
 * Trapezoidal (TPT) state-variable filter after Andrew Simper — unconditionally
 * stable for any cutoff below Nyquist, unlike the classic Chamberlin form.
 */
class SVF {
  constructor(sr) {
    this.sr = sr;
    this.ic1 = 0;
    this.ic2 = 0;
    this.low = 0;
    this.band = 0;
    this.high = 0;
    this.set(1000, 0.5);
  }
  set(cut, res = 0.5) {
    const g = Math.tan((Math.PI * Math.min(Math.max(cut, 10), this.sr * 0.45)) / this.sr);
    this.k = 2 - 2 * Math.min(0.96, Math.max(0, res));
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  process(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
    this.high = x - this.k * v1 - v2;
    return v2;
  }
}

const CHORDS = [
  // root (bass midi), voicing
  { bass: 33, notes: [57, 60, 64, 69] }, // Am
  { bass: 29, notes: [57, 60, 65, 69] }, // F
  { bass: 36, notes: [55, 60, 64, 67] }, // C
  { bass: 31, notes: [55, 59, 62, 67] }, // G
];

// 4-bar lead hook: [16th position, length in 16ths, midi]
const HOOK = [
  [[0, 2, 69], [2, 2, 72], [4, 3, 76], [7, 1, 74], [8, 2, 72], [10, 2, 69], [12, 4, 76]],
  [[0, 3, 77], [3, 1, 76], [4, 2, 72], [6, 2, 69], [8, 4, 72], [12, 2, 74], [14, 2, 72]],
  [[0, 2, 76], [2, 2, 79], [4, 2, 76], [6, 2, 72], [8, 3, 74], [11, 1, 72], [12, 4, 67]],
  [[0, 2, 71], [2, 2, 74], [4, 3, 79], [7, 1, 77], [8, 2, 76], [10, 2, 74], [12, 4, 71]],
];

export function renderDemo({ sampleRate = 44100, onProgress = () => {} } = {}) {
  const SR = sampleRate;
  const tail = 3.5;
  const total = DEMO_BARS * BAR + tail;
  const N = Math.ceil(total * SR);
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const musL = new Float32Array(N); // sidechained bus
  const musR = new Float32Array(N);
  const revL = new Float32Array(N); // reverb send
  const revR = new Float32Array(N);
  const dlyL = new Float32Array(N); // delay send
  const rnd = mulberry32(20261116);
  const noise = () => rnd() * 2 - 1;
  const idx = (t) => Math.max(0, Math.min(N - 1, Math.round(t * SR)));
  const barT = (b) => b * BAR;
  const inSec = (bar, name) => DEMO_SECTIONS.some(([n, a, b]) => n === name && bar >= a && bar < b);

  const kicks = [];

  // ---------- Instruments ----------------------------------------------------------
  const kick = (t, g = 1) => {
    kicks.push(t);
    const n0 = idx(t);
    const len = Math.round(0.42 * SR);
    let ph = 0;
    for (let i = 0; i < len && n0 + i < N; i++) {
      const tt = i / SR;
      const f = 46 + 130 * Math.exp(-tt / 0.028);
      ph += (2 * Math.PI * f) / SR;
      const amp = Math.exp(-tt / 0.22) * (tt < 0.002 ? tt / 0.002 : 1);
      let v = Math.sin(ph) * amp;
      v = Math.tanh(v * 1.6) * 0.92;
      if (i < SR * 0.004) v += noise() * 0.25 * (1 - i / (SR * 0.004));
      L[n0 + i] += v * g;
      R[n0 + i] += v * g;
    }
  };

  const clap = (t, g = 1) => {
    const n0 = idx(t);
    const len = Math.round(0.32 * SR);
    const f = new SVF(SR); f.set(1150, 0.35);
    for (let i = 0; i < len && n0 + i < N; i++) {
      const tt = i / SR;
      let env = 0;
      for (const o of [0, 0.009, 0.018]) if (tt >= o) env = Math.max(env, Math.exp(-(tt - o) / 0.007));
      if (tt >= 0.024) env = Math.max(env, 0.8 * Math.exp(-(tt - 0.024) / 0.075));
      f.process(noise() * env);
      const v = f.band * 1.6 * g;
      L[n0 + i] += v * 0.9; R[n0 + i] += v;
      revL[n0 + i] += v * 0.35; revR[n0 + i] += v * 0.35;
    }
  };

  const snare = (t, g = 1) => {
    const n0 = idx(t);
    const len = Math.round(0.2 * SR);
    const f = new SVF(SR); f.set(2300, 0.2);
    let ph = 0;
    for (let i = 0; i < len && n0 + i < N; i++) {
      const tt = i / SR;
      ph += (2 * Math.PI * (185 + 40 * Math.exp(-tt / 0.01))) / SR;
      f.process(noise());
      const v = (f.band * 0.9 * Math.exp(-tt / 0.06) + Math.sin(ph) * 0.5 * Math.exp(-tt / 0.035)) * g;
      L[n0 + i] += v; R[n0 + i] += v;
      revL[n0 + i] += v * 0.25; revR[n0 + i] += v * 0.25;
    }
  };

  const hat = (t, open = false, g = 1, pan = 0.15) => {
    const n0 = idx(t);
    const decay = open ? 0.16 : 0.032;
    const len = Math.round((open ? 0.45 : 0.09) * SR);
    const f = new SVF(SR); f.set(9000, 0.1);
    for (let i = 0; i < len && n0 + i < N; i++) {
      const tt = i / SR;
      f.process(noise());
      const v = f.high * Math.exp(-tt / decay) * g;
      L[n0 + i] += v * (1 - pan); R[n0 + i] += v * (1 + pan);
    }
  };

  const crash = (t, g = 1) => {
    const n0 = idx(t);
    const len = Math.round(2.6 * SR);
    const f = new SVF(SR); f.set(6000, 0.1);
    const ratios = [1, 1.47, 1.92, 2.61, 3.13];
    const ph = ratios.map(() => rnd());
    for (let i = 0; i < len && n0 + i < N; i++) {
      const tt = i / SR;
      let metal = 0;
      for (let k = 0; k < ratios.length; k++) {
        ph[k] += (420 * ratios[k]) / SR;
        metal += ph[k] % 1 < 0.5 ? 1 : -1;
      }
      f.process(noise() * 0.8 + metal * 0.06);
      const v = f.high * Math.exp(-tt / 0.75) * g * (tt < 0.003 ? tt / 0.003 : 1);
      L[n0 + i] += v * 0.85; R[n0 + i] += v;
      revL[n0 + i] += v * 0.3; revR[n0 + i] += v * 0.3;
    }
  };

  const sub = (t, dur, midi, g = 1) => {
    const n0 = idx(t);
    const len = Math.round(dur * SR);
    const fr = midiHz(midi);
    let ph = 0;
    for (let i = 0; i < len && n0 + i < N; i++) {
      const tt = i / SR;
      ph += (2 * Math.PI * fr) / SR;
      const env = Math.min(1, tt / 0.006) * Math.min(1, (dur - tt) / 0.03);
      const v = Math.tanh(Math.sin(ph) * 1.3 + 0.25 * Math.sin(2 * ph)) * env * g;
      musL[n0 + i] += v; musR[n0 + i] += v;
    }
  };

  /** Detuned PolyBLEP saw stack through a resonant low-pass. */
  const supersaw = (t, dur, notes, cutoff, g = 1, { attack = 0.01, release = 0.12, rev = 0.3, voices = 5, cutoffEnd = cutoff } = {}) => {
    const n0 = idx(t);
    const len = Math.round((dur + release) * SR);
    const oscs = [];
    for (const m of notes) {
      for (let v = 0; v < voices; v++) {
        const det = voices > 1 ? (v / (voices - 1) - 0.5) * 0.24 : 0; // ±12 cents
        oscs.push({ f: midiHz(m + det), ph: rnd(), pan: voices > 1 ? (v / (voices - 1)) * 2 - 1 : 0 });
      }
    }
    const fl = new SVF(SR), frt = new SVF(SR);
    const norm = 1 / Math.sqrt(oscs.length);
    for (let i = 0; i < len && n0 + i < N; i++) {
      const tt = i / SR;
      if ((i & 31) === 0) {
        const c = cutoff * Math.pow(cutoffEnd / cutoff, Math.min(1, tt / Math.max(dur, 1e-3)));
        fl.set(c, 0.25); frt.set(c, 0.25);
      }
      let sl = 0, sr = 0;
      for (const o of oscs) {
        const dt = o.f / SR;
        o.ph += dt; if (o.ph >= 1) o.ph -= 1;
        const s = 2 * o.ph - 1 - polyblep(o.ph, dt);
        sl += s * (1 - o.pan * 0.6);
        sr += s * (1 + o.pan * 0.6);
      }
      let env = Math.min(1, tt / attack);
      if (tt > dur) env *= Math.max(0, 1 - (tt - dur) / release);
      const a = fl.process(sl * norm) * env * g;
      const b = frt.process(sr * norm) * env * g;
      musL[n0 + i] += a; musR[n0 + i] += b;
      revL[n0 + i] += a * rev; revR[n0 + i] += b * rev;
    }
  };

  const pluck = (t, midi, g = 1, bright = 2600, pan = 0) => {
    const n0 = idx(t);
    const len = Math.round(0.5 * SR);
    const f = new SVF(SR);
    let ph = rnd(), ph2 = rnd();
    const fr = midiHz(midi);
    for (let i = 0; i < len && n0 + i < N; i++) {
      const tt = i / SR;
      if ((i & 15) === 0) f.set(300 + bright * Math.exp(-tt / 0.09), 0.3);
      const dt = fr / SR;
      ph += dt; if (ph >= 1) ph -= 1;
      ph2 += dt * 1.005; if (ph2 >= 1) ph2 -= 1;
      const s = (2 * ph - 1 - polyblep(ph, dt)) * 0.5 + (ph2 < 0.5 ? 0.5 : -0.5) * 0.5;
      const v = f.process(s) * Math.exp(-tt / 0.16) * Math.min(1, tt / 0.002) * g;
      L[n0 + i] += v * (1 - pan); R[n0 + i] += v * (1 + pan);
      revL[n0 + i] += v * 0.4; revR[n0 + i] += v * 0.4;
      dlyL[n0 + i] += v * 0.25;
    }
  };

  const lead = (t, dur, midi, g = 1, octaveUp = false) => {
    const n0 = idx(t);
    const rel = 0.09;
    const len = Math.round((dur + rel) * SR);
    const f = new SVF(SR);
    f.set(3800, 0.3);
    const fr = midiHz(midi);
    let p1 = rnd(), p2 = rnd(), p3 = rnd();
    for (let i = 0; i < len && n0 + i < N; i++) {
      const tt = i / SR;
      const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * tt) * Math.min(1, tt / 0.25);
      const d1 = (fr * vib) / SR, d2 = (fr * vib * 1.006) / SR, d3 = (fr * vib * 2) / SR;
      p1 += d1; if (p1 >= 1) p1 -= 1;
      p2 += d2; if (p2 >= 1) p2 -= 1;
      p3 += d3; if (p3 >= 1) p3 -= 1;
      let s = (2 * p1 - 1 - polyblep(p1, d1)) * 0.5 + (2 * p2 - 1 - polyblep(p2, d2)) * 0.4;
      if (octaveUp) s += (2 * p3 - 1 - polyblep(p3, d3)) * 0.3;
      let env = Math.min(1, tt / 0.008);
      if (tt > dur) env *= Math.max(0, 1 - (tt - dur) / rel);
      const v = f.process(s) * env * g;
      L[n0 + i] += v * 0.9; R[n0 + i] += v;
      revL[n0 + i] += v * 0.28; revR[n0 + i] += v * 0.28;
      dlyL[n0 + i] += v * 0.32;
    }
  };

  const riser = (t0, t1, g = 1) => {
    const a = idx(t0), b = idx(t1);
    const f = new SVF(SR);
    let ph = 0;
    for (let i = a; i < b; i++) {
      const x = (i - a) / Math.max(1, b - a);
      if (((i - a) & 15) === 0) f.set(350 * Math.pow(9000 / 350, x), 0.55);
      f.process(noise());
      const fr = midiHz(57 + 24 * x * x);
      ph += fr / SR; if (ph >= 1) ph -= 1;
      const v = (f.band * 0.9 + (2 * ph - 1) * 0.08) * Math.pow(x, 1.6) * g;
      L[i] += v * 0.9; R[i] += v;
      revL[i] += v * 0.35; revR[i] += v * 0.35;
    }
  };

  // ---------- Arrangement ---------------------------------------------------------------
  for (let bar = 0; bar < DEMO_BARS; bar++) {
    const t = barT(bar);
    const ch = CHORDS[bar % 4];
    const intro = inSec(bar, 'Intro');
    const verse = inSec(bar, 'Verse');
    const drop1 = bar >= 20 && bar < 36;
    const drop2 = bar >= 48 && bar < 64;
    const drop = drop1 || drop2;
    const breakdown = inSec(bar, 'Breakdown');
    const build1 = bar >= 12 && bar < 20;
    const build2 = bar >= 44 && bar < 48;
    const outro = bar >= 64;
    const preDropCut = (bar === 19 || bar === 47) ? BEAT * 3.5 : BAR; // silence for last half-beat

    // Pads / chords
    if (intro || breakdown || outro) {
      const fade = outro ? Math.max(0.15, 1 - (bar - 64) / 4) : 1;
      supersaw(t, BAR - 0.02, ch.notes, intro ? 900 + bar * 250 : 1500, 0.16 * fade, { attack: 0.35, release: 0.6, rev: 0.6, voices: 3 });
    } else if (verse) {
      supersaw(t, BAR - 0.02, ch.notes, 1100, 0.11, { attack: 0.08, release: 0.3, rev: 0.45, voices: 3 });
    } else if (build1 || build2) {
      const prog = build1 ? (bar - 12) / 8 : (bar - 44) / 4;
      const step = build1 ? 1 / 8 : 1 / 4;
      for (let s = 0; s < 4; s++) {
        if (s * BEAT >= preDropCut) break;
        const len = Math.min(BEAT * 0.9, preDropCut - s * BEAT - 0.01);
        supersaw(t + s * BEAT, len, ch.notes, 600 + 5500 * (prog + (s / 4) * step), 0.12 + 0.08 * prog, { attack: 0.005, release: 0.08, rev: 0.4 });
      }
    } else if (drop) {
      // Off-beat stabs on a pumping bed.
      supersaw(t, BAR - 0.02, ch.notes.map((m) => m + 12), drop2 ? 5200 : 4200, drop2 ? 0.2 : 0.17, { attack: 0.004, release: 0.2, rev: 0.35 });
    }

    // Arp plucks (intro, verse, breakdown, outro)
    if (intro || verse || breakdown || outro) {
      const pattern = [0, 2, 1, 3, 2, 1, 3, 2];
      for (let s = 0; s < 16; s += 2) {
        const note = ch.notes[pattern[(s / 2) % pattern.length]] + 12;
        const g = (intro ? 0.12 : outro ? 0.1 * Math.max(0.2, 1 - (bar - 64) / 4) : 0.15) * (s % 4 === 0 ? 1 : 0.75);
        pluck(t + s * S16, note, g, breakdown ? 1800 : 2600, s % 4 === 0 ? -0.3 : 0.3);
      }
    }

    // Bass
    if (verse) {
      for (let e = 0; e < 8; e++) if (e % 2 === 1 || e === 0) sub(t + e * BEAT * 0.5, BEAT * 0.45, ch.bass + 12, 0.42);
    } else if (drop) {
      for (let e = 0; e < 8; e++) sub(t + e * BEAT * 0.5, BEAT * 0.48, ch.bass + (e % 2 ? 12 : 0) + 12, 0.5);
    } else if (build1 && bar < 18) {
      for (let q = 0; q < 4; q++) sub(t + q * BEAT, BEAT * 0.9, ch.bass + 12, 0.35);
    }

    // Drums
    if (verse || drop || (build1 && bar < 18)) {
      for (let q = 0; q < 4; q++) kick(t + q * BEAT, drop ? 1 : 0.85);
    }
    if (outro && bar === 64) { kick(t, 1); crash(t, 0.55); }
    if (verse) {
      for (let q = 0; q < 4; q++) hat(t + q * BEAT + BEAT / 2, false, 0.3);
      if (bar % 2 === 1) clap(t + 3 * BEAT, 0.35);
    }
    if (drop) {
      clap(t + BEAT, 0.6); clap(t + 3 * BEAT, 0.6);
      for (let q = 0; q < 4; q++) hat(t + q * BEAT + BEAT / 2, true, 0.22, -0.2);
      for (let s = 0; s < 16; s++) if (s % 2 === 1) hat(t + s * S16, false, s % 4 === 3 ? 0.2 : 0.13, 0.3);
      if (bar === 20 || bar === 28 || bar === 48 || bar === 56) crash(t, 0.6);
    }
    if (build1 || build2) {
      const local = build1 ? bar - 12 : (bar - 44) * 2;
      const div = local < 2 ? 4 : local < 4 ? 8 : local < 6 ? 16 : 32;
      const steps = div;
      for (let s = 0; s < steps; s++) {
        const tt = s * (BAR / steps);
        if (tt >= preDropCut) break;
        const prog = (local + s / steps) / 8;
        snare(t + tt, 0.18 + 0.55 * prog);
      }
      if (bar === 12 || bar === 44) crash(t, 0.4);
    }

    // Lead hook
    if (drop || breakdown) {
      const phrase = HOOK[bar % 4];
      for (const [pos, len, midi] of phrase) {
        const g = breakdown ? 0.12 : drop2 ? 0.2 : 0.17;
        if (breakdown && bar < 40) continue; // second half of the breakdown only
        lead(t + pos * S16, len * S16 * 0.92, midi, g, drop2);
      }
    }
  }
  riser(barT(12), barT(19) + BEAT * 3.5, 0.32);
  riser(barT(44), barT(47) + BEAT * 3.5, 0.34);
  // Closing chord
  supersaw(barT(64), BAR * 2, CHORDS[0].notes, 2400, 0.2, { attack: 0.01, release: 2.2, rev: 0.7 });
  sub(barT(64), BAR * 1.2, 45, 0.45);
  onProgress(0.55);

  // ---------- Sidechain pumping on the music bus ---------------------------------------
  kicks.sort((a, b) => a - b);
  let k = 0;
  for (let i = 0; i < N; i++) {
    const tt = i / SR;
    while (k + 1 < kicks.length && kicks[k + 1] <= tt) k++;
    let duck = 1;
    if (kicks.length && kicks[k] <= tt) duck = 1 - 0.72 * Math.exp(-(tt - kicks[k]) / 0.1);
    L[i] += musL[i] * duck;
    R[i] += musR[i] * duck;
  }
  onProgress(0.65);

  // ---------- Ping-pong delay (dotted 8th) -------------------------------------------
  {
    const d = Math.round(S16 * 3 * SR);
    const bufL = new Float32Array(N), bufR = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const inL = dlyL[i] + (i >= d ? bufR[i - d] * 0.4 : 0);
      const inR = i >= d ? bufL[i - d] : 0;
      bufL[i] = inL;
      bufR[i] = inR;
      if (i >= d) { L[i] += bufL[i - d] * 0.3; R[i] += bufR[i - d] * 0.3; }
    }
  }
  onProgress(0.75);

  // ---------- Freeverb-style reverb --------------------------------------------------
  {
    const scale = SR / 44100;
    const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((x) => Math.round(x * scale));
    const apT = [556, 441, 341, 225].map((x) => Math.round(x * scale));
    const spread = Math.round(23 * scale);
    const run = (input, offset) => {
      const out = new Float32Array(N);
      const combs = combT.map((len) => ({ buf: new Float32Array(len + offset), i: 0, store: 0 }));
      const aps = apT.map((len) => ({ buf: new Float32Array(len + offset), i: 0 }));
      const fb = 0.86, damp = 0.25;
      for (let n = 0; n < N; n++) {
        const x = input[n] * 0.015;
        let acc = 0;
        for (const c of combs) {
          const y = c.buf[c.i];
          c.store = y * (1 - damp) + c.store * damp;
          c.buf[c.i] = x + c.store * fb;
          if (++c.i >= c.buf.length) c.i = 0;
          acc += y;
        }
        for (const a of aps) {
          const b = a.buf[a.i];
          a.buf[a.i] = acc + b * 0.5;
          acc = b - acc;
          if (++a.i >= a.buf.length) a.i = 0;
        }
        out[n] = acc;
      }
      return out;
    };
    const wl = run(revL, 0);
    onProgress(0.86);
    const wr = run(revR, spread);
    for (let i = 0; i < N; i++) { L[i] += wl[i] * 2.4; R[i] += wr[i] * 2.4; }
  }
  onProgress(0.95);

  // ---------- Master: gentle saturation, normalise to −1 dBFS ---------------------
  let peak = 0;
  for (let i = 0; i < N; i++) {
    L[i] = Math.tanh(L[i] * 0.9);
    R[i] = Math.tanh(R[i] * 0.9);
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const g = peak > 0 ? 0.891 / peak : 1;
  // Fade the last 0.5 s to avoid a click.
  const fadeN = Math.round(0.5 * SR);
  for (let i = 0; i < N; i++) {
    const f = i > N - fadeN ? (N - i) / fadeN : 1;
    L[i] *= g * f; R[i] *= g * f;
  }
  onProgress(1);

  return {
    sampleRate: SR,
    channels: [L, R],
    meta: {
      bpm: DEMO_BPM,
      beat: BEAT,
      bar: BAR,
      sections: DEMO_SECTIONS.map(([name, a, b]) => ({ name, start: a * BAR, end: b * BAR })),
      drops: [20 * BAR, 48 * BAR],
      duration: N / SR,
    },
  };
}

/** Encode Float32 stereo as a 16-bit PCM WAV file (Uint8Array). */
export function encodeWav(channels, sampleRate) {
  const nCh = channels.length;
  const n = channels[0].length;
  const bytes = 44 + n * nCh * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, bytes - 8, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * 2, true);
  v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}
