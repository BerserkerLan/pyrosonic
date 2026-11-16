import { Rng } from './rng.js';
import { linearRGB } from './palettes.js';

/**
 * Particle layout shared with the GPU shader (24 floats per particle):
 *  0 ox  1 oy  2 oz  3 birth | 4 vx 5 vy 6 vz 7 life
 *  8 r   9 g  10 b  11 intensity | 12 r2 13 g2 14 b2 15 colourShift
 * 16 drag 17 gravityScale 18 size 19 trailSeconds | 20 flicker 21 strobeHz 22 seed 23 flags
 *
 * Motion is analytic (linear drag + gravity) so the GPU can evaluate any
 * particle at any time — pause, scrub and seek are exact and free.
 */
export const STRIDE = 24;
export const FLAG = { GLITTER: 1, NO_HEAD: 2, FLASH: 4, NO_TRAIL: 8, HOT: 16, HOLD: 32 };
export const GRAVITY = 11;
/** Particles whose trail is at least this long go to the high-segment ribbon system. */
export const LONG_TRAIL = 0.2;

export const STAGE = {
  halfWidth: 165,
  depth: 262,
  zSpread: 28,
  yMin: 42,
  yMax: 126,
  groundY: 0.8,
  shoreZ: -236,
};

export const heightOf = (y) => STAGE.yMin + (STAGE.yMax - STAGE.yMin) * y;
/** Seconds from launch to burst for a shell bursting at normalised height y. */
export const flightTime = (y) => 0.9 + heightOf(y) / 85;

/** Static description of each effect: is it shot from a mortar, how long it lives, rough particle cost. */
export const TYPE_INFO = {
  peony: { kind: 'aerial', life: 2.9, cost: 150 },
  chrysanthemum: { kind: 'aerial', life: 3.1, cost: 160 },
  dahlia: { kind: 'aerial', life: 3.2, cost: 70 },
  willow: { kind: 'aerial', life: 5.4, cost: 100 },
  kamuro: { kind: 'aerial', life: 4.8, cost: 170 },
  palm: { kind: 'aerial', life: 3.4, cost: 50 },
  ring: { kind: 'aerial', life: 2.8, cost: 110 },
  crossette: { kind: 'aerial', life: 2.4, cost: 90 },
  crackle: { kind: 'aerial', life: 2.0, cost: 330 },
  strobe: { kind: 'aerial', life: 3.8, cost: 80 },
  horsetail: { kind: 'aerial', life: 3.9, cost: 80 },
  glitter: { kind: 'aerial', life: 1.4, cost: 50 },
  heart: { kind: 'aerial', life: 3.0, cost: 110 },
  star: { kind: 'aerial', life: 3.0, cost: 110 },
  salute: { kind: 'aerial', life: 0.9, cost: 110 },
  comet: { kind: 'comet', life: 0.9, cost: 40 },
  mine: { kind: 'ground', life: 2.3, cost: 70 },
  fountain: { kind: 'ground', life: 1.6, cost: 0 },
};

/** Launch (first particle) and end (last particle dies) times for an event. */
export function eventTiming(ev) {
  const info = TYPE_INFO[ev.type] || TYPE_INFO.peony;
  if (info.kind === 'ground') {
    const dur = ev.type === 'fountain' ? ev.dur || 2 : 0;
    return { launch: ev.t, end: ev.t + dur + info.life };
  }
  const T = flightTime(ev.y);
  return { launch: ev.t - T, end: ev.t + info.life };
}

export function estimateCost(ev) {
  if (ev.type === 'fountain') return 55 * (ev.dur || 2) * 1.2;
  return (TYPE_INFO[ev.type]?.cost ?? 120) * (0.6 + 0.6 * (ev.size ?? 0.5)) + 22;
}

// ---- Physics (must match the vertex shader) ---------------------------------------------

export function posAt(ox, oy, oz, vx, vy, vz, k, gs, t, out) {
  const g = -GRAVITY * gs;
  const e = Math.exp(-k * t);
  const gk = g / k;
  const f = (1 - e) / k;
  out[0] = ox + vx * f;
  out[1] = oy + gk * t + (vy - gk) * f;
  out[2] = oz + vz * f;
  return out;
}

export function velAt(vx, vy, vz, k, gs, t, out) {
  const g = -GRAVITY * gs;
  const e = Math.exp(-k * t);
  const gk = g / k;
  out[0] = vx * e;
  out[1] = gk + (vy - gk) * e;
  out[2] = vz * e;
  return out;
}

/** Initial velocity that carries a body from `from` to `to` in T seconds. */
export function solveVelocity(from, to, T, k, gs, out) {
  const g = -GRAVITY * gs;
  const gk = g / k;
  const f = (1 - Math.exp(-k * T)) / k;
  out[0] = (to[0] - from[0]) / f;
  out[1] = (to[1] - from[1] - gk * T) / f + gk;
  out[2] = (to[2] - from[2]) / f;
  return out;
}

// ---- Particle writer ------------------------------------------------------------------------

class Writer {
  constructor(cap = 2048) {
    this.data = new Float32Array(cap * STRIDE);
    this.count = 0;
  }
  push(p) {
    if ((this.count + 1) * STRIDE > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const d = this.data;
    const o = this.count * STRIDE;
    d[o] = p.ox; d[o + 1] = p.oy; d[o + 2] = p.oz; d[o + 3] = p.birth;
    d[o + 4] = p.vx; d[o + 5] = p.vy; d[o + 6] = p.vz; d[o + 7] = p.life;
    d[o + 8] = p.r; d[o + 9] = p.g; d[o + 10] = p.b; d[o + 11] = p.inten;
    d[o + 12] = p.r2; d[o + 13] = p.g2; d[o + 14] = p.b2; d[o + 15] = p.shift;
    d[o + 16] = Math.max(0.05, p.drag); d[o + 17] = p.grav; d[o + 18] = p.size; d[o + 19] = p.trail;
    d[o + 20] = p.flicker; d[o + 21] = p.strobe; d[o + 22] = p.seed; d[o + 23] = p.flags;
    this.count++;
  }
  reset() {
    this.count = 0;
  }
  view() {
    return this.data.subarray(0, this.count * STRIDE);
  }
}

const EMBER = linearRGB('#ff5a14');
const WHITE = linearRGB('white');
const ROCKET = linearRGB('#ffd9a0');
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function newParticle() {
  return {
    ox: 0, oy: 0, oz: 0, birth: 0, vx: 0, vy: 0, vz: 0, life: 1,
    r: 1, g: 1, b: 1, inten: 1, r2: 1, g2: 1, b2: 1, shift: -1,
    drag: 1, grav: 1, size: 1, trail: 0, flicker: 0, strobe: 0, seed: 0, flags: 0,
  };
}

// ---- Direction helpers ----------------------------------------------------------------------

function randomRotation(rng) {
  const u1 = rng.next(), u2 = rng.next(), u3 = rng.next();
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  const x = a * Math.sin(2 * Math.PI * u2), y = a * Math.cos(2 * Math.PI * u2);
  const z = b * Math.sin(2 * Math.PI * u3), w = b * Math.cos(2 * Math.PI * u3);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** Evenly spread unit vectors (Fibonacci sphere, randomly rotated, lightly jittered). */
function sphereDirs(n, rng, jitter = 0.07) {
  const out = new Float32Array(n * 3);
  const m = randomRotation(rng);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    let x = r * Math.cos(th) + rng.range(-jitter, jitter);
    let yy = y + rng.range(-jitter, jitter);
    let z = r * Math.sin(th) + rng.range(-jitter, jitter);
    const l = Math.hypot(x, yy, z) || 1;
    x /= l; yy /= l; z /= l;
    out[i * 3] = m[0] * x + m[1] * yy + m[2] * z;
    out[i * 3 + 1] = m[3] * x + m[4] * yy + m[5] * z;
    out[i * 3 + 2] = m[6] * x + m[7] * yy + m[8] * z;
  }
  return out;
}

/** Orthonormal basis (u, v) perpendicular to n. */
function basis(n) {
  const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
  const lu = Math.hypot(u[0], u[1], u[2]) || 1;
  u = [u[0] / lu, u[1] / lu, u[2] / lu];
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return [u, v];
}

/** A plane roughly facing the camera (which looks down −z), with some tilt. */
function facingPlane(rng, tilt = 0.4) {
  const n = [rng.range(-tilt, tilt), rng.range(-tilt, tilt), 1];
  const l = Math.hypot(n[0], n[1], n[2]);
  const nn = [n[0] / l, n[1] / l, n[2] / l];
  // Keep "up" close to world up so shapes (hearts, stars) read upright.
  const upRaw = [0, 1, 0];
  const d = upRaw[0] * nn[0] + upRaw[1] * nn[1] + upRaw[2] * nn[2];
  let v = [upRaw[0] - d * nn[0], upRaw[1] - d * nn[1], upRaw[2] - d * nn[2]];
  const lv = Math.hypot(v[0], v[1], v[2]) || 1;
  v = [v[0] / lv, v[1] / lv, v[2] / lv];
  const u = [v[1] * nn[2] - v[2] * nn[1], v[2] * nn[0] - v[0] * nn[2], v[0] * nn[1] - v[1] * nn[0]];
  return { n: nn, u, v };
}

function coneDir(axis, halfAngle, rng) {
  const [u, v] = basis(axis);
  const a = rng.range(0, 2 * Math.PI);
  const r = Math.tan(halfAngle) * Math.sqrt(rng.next());
  const d = [axis[0] + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * r, axis[1] + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * r, axis[2] + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * r];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

// ---- Builder ------------------------------------------------------------------------------------

/**
 * Generate every particle for one show event (rocket, burst, children, crackle…),
 * plus the light flashes it casts on the sky. Deterministic per ev.seed.
 *
 * @param ev     choreographed event {t, type, x, y, z, lx, size, colors, intensity, seed, dur, variant}
 * @param opts   {stage: {halfWidth, scale}, quality: 0.35..1, reduceFlashing: bool}
 * @param out    {trails: Writer, sparks: Writer, flashes: []} (from createBuildTarget)
 */
export function buildEvent(ev, opts, out) {
  const rng = new Rng(ev.seed || 1);
  const stageW = opts.stage?.halfWidth ?? STAGE.halfWidth;
  const scale = opts.stage?.scale ?? 1;
  const q = Math.max(0.3, Math.min(1, opts.quality ?? 1));
  const calm = !!opts.reduceFlashing;
  const P = newParticle();
  const tmp = [0, 0, 0];
  const tmp2 = [0, 0, 0];
  const colors = (ev.colors && ev.colors.length ? ev.colors : ['gold']).map(linearRGB);
  const c0 = colors[0];
  const c1 = colors[1] || colors[0];
  const c2 = colors[2] || c1;
  const inten = ev.intensity ?? 1;
  const size = Math.max(0, Math.min(1, ev.size ?? 0.5));
  const R = (18 + 32 * size) * scale; // asymptotic burst radius (world units)
  const count = (base) => Math.max(6, Math.round(base * q * (0.65 + 0.55 * size)));

  const emit = () => {
    const long = P.trail >= LONG_TRAIL && !(P.flags & FLAG.NO_TRAIL);
    (long ? out.trails : out.sparks).push(P);
  };
  const setColor = (c, cEnd = null, shift = -1) => {
    P.r = c[0]; P.g = c[1]; P.b = c[2];
    const e = cEnd || c;
    P.r2 = e[0]; P.g2 = e[1]; P.b2 = e[2];
    P.shift = cEnd ? shift : -1;
  };
  const reset = () => {
    P.vx = P.vy = P.vz = 0;
    P.flicker = 0; P.strobe = 0; P.flags = 0; P.trail = 0; P.grav = 1; P.drag = 1; P.size = 1; P.inten = 1;
    P.seed = rng.next();
  };

  // World positions.
  const info = TYPE_INFO[ev.type] || TYPE_INFO.peony;
  const bx = ev.x * stageW;
  // Flight time always uses the base height (it fixes the launch time); on tall
  // screens the burst point is lifted and the shell simply climbs faster.
  const yScale = opts.stage?.yScale ?? 1;
  const by = STAGE.yMin + (heightOf(ev.y ?? 0.6) - STAGE.yMin) * yScale;
  const bz = -STAGE.depth + (ev.z ?? 0) * STAGE.zSpread;
  const burst = [bx, by, bz];
  const lx = (ev.lx ?? ev.x) * stageW * 0.96;
  const launchPos = [lx, STAGE.groundY, STAGE.shoreZ - 8 + (ev.z ?? 0) * 6];
  const t = ev.t;

  const addFlash = (pos, color, strength, decay = 0.55) => {
    out.flashes.push({ t, x: pos[0], y: pos[1], z: pos[2], r: color[0], g: color[1], b: color[2], strength: calm ? strength * 0.45 : strength, decay });
  };

  const burstFlash = (sizeMul = 0.34, intensity = 1.5, life = 0.14, col = mix3(WHITE, c0, 0.35)) => {
    reset();
    P.ox = burst[0]; P.oy = burst[1]; P.oz = burst[2]; P.birth = t; P.life = life;
    setColor(col);
    P.inten = calm ? intensity * 0.35 : intensity;
    P.size = R * sizeMul;
    P.flags = FLAG.FLASH | FLAG.NO_TRAIL;
    emit();
  };

  // ---- Rocket (mortar shell rising) -----------------------------------------------------
  let inherit = [0, 0, 0];
  const rocket = ({ comet = false, color = ROCKET, sizeMul = 1, trail = 0.32, life = null, bright = 1.3 } = {}) => {
    const T = flightTime(ev.y ?? 0.6);
    const tl = t - T;
    const k = 0.35, gs = 1.8;
    const v = solveVelocity(launchPos, burst, T, k, gs, [0, 0, 0]);
    reset();
    P.ox = launchPos[0]; P.oy = launchPos[1]; P.oz = launchPos[2]; P.birth = tl;
    P.vx = v[0]; P.vy = v[1]; P.vz = v[2]; P.life = life ?? (comet ? T + 0.35 : T);
    setColor(color, comet ? mix3(color, EMBER, 0.5) : null, 0.85);
    P.inten = bright * inten; P.drag = k; P.grav = gs; P.size = 0.85 * sizeMul * Math.max(0.75, scale);
    P.trail = trail; P.flicker = 0.25; P.flags = FLAG.GLITTER | (comet ? 0 : FLAG.HOLD);
    emit();
    // Sparks shed along the way.
    const n = Math.round((comet ? 26 : 14) * q);
    for (let i = 0; i < n; i++) {
      const tb = (T - 0.08) * ((i + rng.next()) / n);
      posAt(launchPos[0], launchPos[1], launchPos[2], v[0], v[1], v[2], k, gs, tb, tmp);
      velAt(v[0], v[1], v[2], k, gs, tb, tmp2);
      reset();
      P.ox = tmp[0]; P.oy = tmp[1]; P.oz = tmp[2]; P.birth = tl + tb;
      P.vx = tmp2[0] * 0.08 + rng.range(-3, 3); P.vy = tmp2[1] * 0.08 + rng.range(-1, 2.5); P.vz = tmp2[2] * 0.08 + rng.range(-3, 3);
      P.life = rng.range(0.3, 0.65);
      setColor(comet ? color : ROCKET, EMBER, 0.3);
      P.inten = 1.1 * inten; P.drag = 2.4; P.grav = 0.9; P.size = 0.36 * Math.max(0.75, scale);
      P.trail = 0.05; P.flicker = 0.6; P.flags = FLAG.GLITTER;
      emit();
    }
    velAt(v[0], v[1], v[2], k, gs, T, tmp2);
    inherit = [tmp2[0] * 0.25, tmp2[1] * 0.25, tmp2[2] * 0.25];
    return T;
  };

  /** Spherical burst of stars. */
  const sphere = ({ n, radius = R, drag = 2.6, gs = 1, life = [1.5, 2.4], trail = 0.1, starSize = 1, flicker = 0.12, glitter = false, cols = [c0], ember = true, shiftAt = 0.72, intensity = 1.25, strobe = 0, noTrail = false, origin = burst, birth = t, inh = inherit }) => {
    const dirs = sphereDirs(n, rng);
    const v0 = radius * drag;
    for (let i = 0; i < n; i++) {
      reset();
      const sp = v0 * rng.range(0.92, 1.04);
      P.ox = origin[0]; P.oy = origin[1]; P.oz = origin[2]; P.birth = birth;
      P.vx = dirs[i * 3] * sp + inh[0]; P.vy = dirs[i * 3 + 1] * sp + inh[1]; P.vz = dirs[i * 3 + 2] * sp + inh[2];
      P.life = rng.range(life[0], life[1]);
      const c = cols[i % cols.length];
      setColor(c, ember ? mix3(c, EMBER, 0.65) : null, shiftAt);
      P.inten = intensity * inten; P.drag = drag; P.grav = gs; P.size = starSize * Math.max(0.7, scale);
      P.trail = trail; P.flicker = flicker; P.strobe = strobe;
      P.flags = (glitter ? FLAG.GLITTER : 0) | (noTrail ? FLAG.NO_TRAIL : 0);
      emit();
    }
  };

  /** Stars along a closed planar outline (ring, heart, star shape). */
  const outline = (points, { drag = 2.5, life = [1.9, 2.5], cols = [c0], radius = R, trail = 0.1, starSize = 1.05, plane = facingPlane(rng, 0.35), intensity = 1.3 }) => {
    const v0 = radius * drag;
    const { u, v } = plane;
    for (let i = 0; i < points.length; i++) {
      const [px, py] = points[i];
      reset();
      P.ox = burst[0]; P.oy = burst[1]; P.oz = burst[2]; P.birth = t;
      const s = v0 * rng.range(0.985, 1.015);
      P.vx = (u[0] * px + v[0] * py) * s + inherit[0];
      P.vy = (u[1] * px + v[1] * py) * s + inherit[1];
      P.vz = (u[2] * px + v[2] * py) * s + inherit[2];
      P.life = rng.range(life[0], life[1]);
      const c = cols[i % cols.length];
      setColor(c, mix3(c, EMBER, 0.6), 0.75);
      P.inten = intensity * inten; P.drag = drag; P.grav = 0.7; P.size = starSize * Math.max(0.7, scale);
      P.trail = trail; P.flicker = 0.1;
      emit();
    }
  };

  const crackleAt = (pos, tStart, n, spread = 1.4) => {
    for (let j = 0; j < n; j++) {
      reset();
      P.ox = pos[0] + rng.range(-spread, spread) * scale;
      P.oy = pos[1] + rng.range(-spread, spread) * scale;
      P.oz = pos[2] + rng.range(-spread, spread) * scale;
      P.birth = tStart + rng.range(0, 0.22);
      P.vx = rng.range(-2, 2); P.vy = rng.range(-2, 1); P.vz = rng.range(-2, 2);
      P.life = rng.range(0.045, 0.1);
      setColor(mix3(WHITE, linearRGB('gold'), 0.25));
      P.inten = calm ? 1.2 : 3.2; P.drag = 3; P.grav = 0.5; P.size = 1.25 * Math.max(0.7, scale);
      P.flags = FLAG.NO_TRAIL | FLAG.HOT;
      emit();
    }
  };

  // ---- Effects ------------------------------------------------------------------------------
  switch (ev.type) {
    case 'peony': {
      rocket();
      burstFlash();
      const twoTone = colors.length > 1 && ev.variant !== 'mono';
      sphere({ n: count(130), cols: twoTone ? [c0, c1] : [c0], trail: 0.11 });
      if (ev.variant === 'pistil') sphere({ n: count(45), radius: R * 0.42, cols: [c2], life: [1.0, 1.6], trail: 0.06, starSize: 0.8 });
      addFlash(burst, c0, 0.55 + size * 0.7);
      break;
    }
    case 'chrysanthemum': {
      rocket();
      burstFlash();
      sphere({ n: count(140), cols: colors.length > 1 ? [c0, c1] : [c0], trail: 0.5, glitter: true, drag: 2.35, life: [1.8, 2.6], starSize: 0.9, flicker: 0.2, intensity: 1.15 });
      if (ev.variant === 'pistil') sphere({ n: count(40), radius: R * 0.4, cols: [c2], life: [1.0, 1.5], trail: 0.07, starSize: 0.85 });
      addFlash(burst, c0, 0.6 + size * 0.7);
      break;
    }
    case 'dahlia': {
      rocket();
      burstFlash(0.45, 2);
      sphere({ n: count(48), cols: [c0, c1], trail: 0.3, drag: 1.9, life: [2.1, 2.8], starSize: 1.7, flicker: 0.08, intensity: 1.4 });
      addFlash(burst, c0, 0.5 + size * 0.6);
      break;
    }
    case 'willow': {
      rocket();
      burstFlash(0.4, 1.7, 0.15, mix3(WHITE, linearRGB('gold'), 0.5));
      const gold = linearRGB(ev.colors?.includes('silver') ? 'silver' : 'gold');
      const tipColor = colors.find((c) => c !== linearRGB('gold')) || gold;
      sphere({ n: count(78), cols: [gold], trail: 1.35, glitter: true, drag: 3.5, gs: 1.95, life: [3.8, 5.0], starSize: 0.72, flicker: 0.4, shiftAt: 0.45, intensity: 1.05, radius: R * 1.05 });
      if (ev.variant === 'tipped') sphere({ n: count(24), cols: [tipColor], trail: 0.12, drag: 2.6, life: [1.2, 1.7], starSize: 1.1, radius: R * 0.85 });
      addFlash(burst, gold, 0.45 + size * 0.5, 1.4);
      break;
    }
    case 'kamuro': {
      rocket();
      burstFlash(0.55, 2.2, 0.18, mix3(WHITE, linearRGB('gold'), 0.4));
      const k1 = linearRGB(ev.colors?.includes('silver') ? 'silver' : 'gold');
      sphere({ n: count(150), cols: [k1], trail: 1.0, glitter: true, drag: 3.1, gs: 1.35, life: [3.2, 4.4], starSize: 0.85, flicker: 0.55, shiftAt: 0.55, intensity: 1.3, radius: R * 1.12 });
      addFlash(burst, k1, 0.8 + size * 0.7, 1.2);
      break;
    }
    case 'palm': {
      rocket({ sizeMul: 1.5, trail: 0.55, bright: 1.6 });
      burstFlash(0.4, 2.0);
      const arms = Math.max(6, Math.round(rng.range(7, 10) * Math.max(0.8, q)));
      const az0 = rng.range(0, Math.PI * 2);
      for (let i = 0; i < arms; i++) {
        const az = az0 + (i / arms) * Math.PI * 2 + rng.range(-0.15, 0.15);
        const el = rng.range(0.25, 1.05);
        const d = [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)];
        const sp = R * 1.55 * 1.5 * rng.range(0.9, 1.06);
        reset();
        P.ox = burst[0]; P.oy = burst[1]; P.oz = burst[2]; P.birth = t;
        P.vx = d[0] * sp + inherit[0]; P.vy = d[1] * sp + inherit[1]; P.vz = d[2] * sp + inherit[2];
        P.life = rng.range(2.3, 3.0);
        setColor(c0, mix3(c0, EMBER, 0.7), 0.5);
        P.inten = 1.7 * inten; P.drag = 1.5; P.grav = 1.7; P.size = 2.1 * Math.max(0.7, scale);
        P.trail = 0.8; P.flicker = 0.25; P.flags = FLAG.GLITTER;
        emit();
      }
      addFlash(burst, c0, 0.6 + size * 0.6);
      break;
    }
    case 'ring': {
      rocket();
      burstFlash(0.4, 2);
      const n = count(64);
      const pts = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push([Math.cos(a), Math.sin(a)]); }
      outline(pts, { cols: [c0], plane: facingPlane(rng, 0.55) });
      if (ev.variant === 'double') outline(pts, { cols: [c1], radius: R * 0.62, plane: facingPlane(rng, 0.55) });
      if (ev.variant === 'saturn') sphere({ n: count(42), radius: R * 0.38, cols: [c1], life: [1.2, 1.8], trail: 0.08, starSize: 0.9 });
      addFlash(burst, c0, 0.5 + size * 0.6);
      break;
    }
    case 'heart':
    case 'star': {
      rocket();
      burstFlash(0.4, 2);
      const n = count(ev.type === 'heart' ? 84 : 80);
      const pts = [];
      if (ev.type === 'heart') {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const hx = 16 * Math.sin(a) ** 3;
          const hy = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
          pts.push([hx / 17, (hy + 2.5) / 17]);
        }
      } else {
        const verts = [];
        for (let i = 0; i < 10; i++) {
          const a = Math.PI / 2 + (i / 10) * Math.PI * 2;
          const r = i % 2 === 0 ? 1 : 0.42;
          verts.push([Math.cos(a) * r, Math.sin(a) * r]);
        }
        for (let i = 0; i < n; i++) {
          const f = (i / n) * 10;
          const s = Math.floor(f);
          const fr = f - s;
          const a = verts[s % 10], b = verts[(s + 1) % 10];
          pts.push([a[0] + (b[0] - a[0]) * fr, a[1] + (b[1] - a[1]) * fr]);
        }
      }
      outline(pts, { cols: [c0], plane: facingPlane(rng, 0.12), drag: 2.4, radius: R * 1.1, life: [2.2, 2.7] });
      addFlash(burst, c0, 0.6 + size * 0.6);
      break;
    }
    case 'crossette': {
      rocket();
      burstFlash(0.35, 1.8);
      const n = count(12);
      const dirs = sphereDirs(n, rng, 0.12);
      const drag = 1.8;
      const v0 = R * drag * 0.62;
      for (let i = 0; i < n; i++) {
        const ts = rng.range(0.5, 0.68);
        reset();
        P.ox = burst[0]; P.oy = burst[1]; P.oz = burst[2]; P.birth = t;
        P.vx = dirs[i * 3] * v0 + inherit[0]; P.vy = dirs[i * 3 + 1] * v0 + inherit[1]; P.vz = dirs[i * 3 + 2] * v0 + inherit[2];
        P.life = ts;
        setColor(c0);
        P.inten = 1.5 * inten; P.drag = drag; P.grav = 1; P.size = 1.15 * Math.max(0.7, scale); P.trail = 0.28; P.flicker = 0.1;
        emit();
        const vx = P.vx, vy = P.vy, vz = P.vz;
        posAt(burst[0], burst[1], burst[2], vx, vy, vz, drag, 1, ts, tmp);
        velAt(vx, vy, vz, drag, 1, ts, tmp2);
        const sp = Math.hypot(tmp2[0], tmp2[1], tmp2[2]) || 1;
        const axis = [tmp2[0] / sp, tmp2[1] / sp, tmp2[2] / sp];
        const [u, v] = basis(axis);
        const rot = rng.range(0, Math.PI / 2);
        const pos = [tmp[0], tmp[1], tmp[2]];
        for (let j = 0; j < 4; j++) {
          const a = rot + (j * Math.PI) / 2;
          const d = [u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)];
          const cs = R * 0.95 * 2.8 * 0.55;
          reset();
          P.ox = pos[0]; P.oy = pos[1]; P.oz = pos[2]; P.birth = t + ts;
          P.vx = tmp2[0] * 0.3 + d[0] * cs; P.vy = tmp2[1] * 0.3 + d[1] * cs; P.vz = tmp2[2] * 0.3 + d[2] * cs;
          P.life = rng.range(0.8, 1.25);
          setColor(j % 2 ? c1 : c0, EMBER, 0.7);
          P.inten = 1.4 * inten; P.drag = 2.8; P.grav = 1; P.size = 0.85 * Math.max(0.7, scale); P.trail = 0.16; P.flicker = 0.15;
          emit();
        }
        // Tiny pop at the split point.
        reset();
        P.ox = pos[0]; P.oy = pos[1]; P.oz = pos[2]; P.birth = t + ts; P.life = 0.07;
        setColor(WHITE); P.inten = calm ? 0.8 : 1.6; P.size = 1.8 * scale; P.flags = FLAG.FLASH | FLAG.NO_TRAIL;
        emit();
      }
      addFlash(burst, c0, 0.45 + size * 0.5);
      break;
    }
    case 'crackle': {
      rocket();
      burstFlash(0.4, 2);
      const n = count(64);
      const dirs = sphereDirs(n, rng);
      const drag = 2.5;
      const v0 = R * drag * 0.85;
      const col = ev.colors?.length ? c0 : linearRGB('gold');
      for (let i = 0; i < n; i++) {
        const L = rng.range(0.7, 1.15);
        reset();
        P.ox = burst[0]; P.oy = burst[1]; P.oz = burst[2]; P.birth = t;
        const sp = v0 * rng.range(0.9, 1.05);
        P.vx = dirs[i * 3] * sp + inherit[0]; P.vy = dirs[i * 3 + 1] * sp + inherit[1]; P.vz = dirs[i * 3 + 2] * sp + inherit[2];
        P.life = L;
        setColor(col, mix3(col, WHITE, 0.4), 0.6);
        P.inten = 1.2 * inten; P.drag = drag; P.grav = 1; P.size = 0.8 * Math.max(0.7, scale); P.trail = 0.1; P.flicker = 0.35; P.flags = FLAG.GLITTER;
        emit();
        posAt(burst[0], burst[1], burst[2], P.vx, P.vy, P.vz, drag, 1, L, tmp);
        crackleAt([tmp[0], tmp[1], tmp[2]], t + L, Math.max(2, Math.round(4 * q)));
      }
      addFlash(burst, col, 0.5 + size * 0.5);
      break;
    }
    case 'strobe': {
      rocket();
      burstFlash(0.35, 1.6);
      const col = ev.colors?.includes('white') || ev.colors?.includes('silver') ? linearRGB('white') : c0;
      sphere({ n: count(56), cols: [col], drag: 3.0, gs: 0.55, life: [2.7, 3.6], noTrail: true, starSize: 1.05, intensity: calm ? 0.9 : 2.0, strobe: calm ? 0 : rng.range(7, 11), ember: false, radius: R * 0.95 });
      addFlash(burst, col, 0.4 + size * 0.4);
      break;
    }
    case 'horsetail': {
      rocket();
      burstFlash(0.35, 1.6);
      const n = count(54);
      const col = linearRGB(ev.colors?.includes('silver') ? 'silver' : 'gold');
      for (let i = 0; i < n; i++) {
        const a = rng.range(0, Math.PI * 2);
        const spread = rng.range(0.15, 0.85);
        const d = [Math.cos(a) * spread, -rng.range(0.1, 0.6), Math.sin(a) * spread];
        const sp = R * rng.range(0.7, 1.1);
        reset();
        P.ox = burst[0]; P.oy = burst[1]; P.oz = burst[2]; P.birth = t;
        P.vx = d[0] * sp; P.vy = d[1] * sp + 6; P.vz = d[2] * sp;
        P.life = rng.range(2.8, 3.7);
        setColor(col, EMBER, 0.6);
        P.inten = 1.15 * inten; P.drag = 1.2; P.grav = 2.0; P.size = 0.8 * Math.max(0.7, scale);
        P.trail = 0.95; P.flicker = 0.45; P.flags = FLAG.GLITTER;
        emit();
      }
      addFlash(burst, col, 0.45 + size * 0.4, 1.0);
      break;
    }
    case 'glitter': {
      rocket({ sizeMul: 0.75, trail: 0.22 });
      burstFlash(0.3, 1.5, 0.12);
      sphere({ n: count(36), radius: R * 0.55, cols: [c0, linearRGB('white')], drag: 3.4, life: [0.6, 1.1], starSize: 0.6, trail: 0.06, glitter: true, flicker: 0.65, intensity: 1.35 });
      addFlash(burst, c0, 0.25 + size * 0.3);
      break;
    }
    case 'salute': {
      rocket({ bright: 1.6 });
      burstFlash(1.05, calm ? 1.6 : 4.2, 0.22, WHITE);
      sphere({ n: count(90), radius: R * 0.9, cols: [WHITE], drag: 6, life: [0.15, 0.4], starSize: 0.75, noTrail: true, intensity: calm ? 1.2 : 3, ember: false });
      addFlash(burst, WHITE, 2.2, 0.4);
      break;
    }
    case 'comet': {
      // A single bright star with a long glittering tail that fades at the target.
      const col = c0;
      rocket({ comet: true, color: col, sizeMul: 1.35, trail: 0.6, bright: 1.8 });
      if (ev.variant === 'pop') crackleAt(burst, t, Math.round(10 * q), 2.2);
      break;
    }
    case 'mine': {
      const base = [ev.x * stageW, STAGE.groundY, STAGE.shoreZ - 4 + (ev.z ?? 0) * 5];
      const n = count(52);
      const axis = [rng.range(-0.12, 0.12), 1, rng.range(-0.08, 0.08)];
      const al = Math.hypot(axis[0], axis[1], axis[2]);
      axis[0] /= al; axis[1] /= al; axis[2] /= al;
      for (let i = 0; i < n; i++) {
        const d = coneDir(axis, rng.range(0.15, 0.42), rng);
        const sp = rng.range(55, 85) * (0.75 + 0.35 * size) * scale;
        reset();
        P.ox = base[0]; P.oy = base[1]; P.oz = base[2]; P.birth = t + rng.range(0, 0.03);
        P.vx = d[0] * sp; P.vy = d[1] * sp; P.vz = d[2] * sp;
        P.life = rng.range(1.3, 2.0);
        const c = i % 3 === 0 ? c1 : c0;
        setColor(c, mix3(c, EMBER, 0.6), 0.7);
        P.inten = 1.35 * inten; P.drag = 1.45; P.grav = 1.05; P.size = 0.9 * Math.max(0.7, scale);
        P.trail = 0.34; P.flicker = 0.2; P.flags = FLAG.GLITTER;
        emit();
      }
      reset();
      P.ox = base[0]; P.oy = base[1] + 2; P.oz = base[2]; P.birth = t; P.life = 0.14;
      setColor(mix3(WHITE, c0, 0.4)); P.inten = calm ? 0.7 : 1.4; P.size = 6 * scale; P.flags = FLAG.FLASH | FLAG.NO_TRAIL;
      emit();
      out.flashes.push({ t, x: base[0], y: base[1] + 6, z: base[2], r: c0[0], g: c0[1], b: c0[2], strength: calm ? 0.2 : 0.45, decay: 0.5 });
      break;
    }
    case 'fountain': {
      const base = [ev.x * stageW, STAGE.groundY, STAGE.shoreZ - 3 + (ev.z ?? 0) * 4];
      const dur = Math.max(0.3, ev.dur || 2);
      const rate = 52 * q * (0.7 + 0.5 * size);
      const n = Math.round(rate * dur);
      const col = ev.colors?.length ? c0 : linearRGB('gold');
      const hot = linearRGB('white');
      for (let i = 0; i < n; i++) {
        const tb = t + (i + rng.next()) / rate;
        const age = tb - t;
        const env = Math.min(1, age / 0.35, (dur - age) / 0.35 + 0.15);
        const d = coneDir([0, 1, 0], 0.13, rng);
        const sp = rng.range(32, 44) * (0.75 + 0.4 * size) * Math.max(0.6, scale) * (0.7 + 0.3 * env);
        reset();
        P.ox = base[0] + rng.range(-0.4, 0.4); P.oy = base[1]; P.oz = base[2]; P.birth = tb;
        P.vx = d[0] * sp; P.vy = d[1] * sp; P.vz = d[2] * sp;
        P.life = rng.range(0.85, 1.35);
        setColor(rng.chance(0.25) ? hot : col, EMBER, 0.55);
        P.inten = 1.25 * inten * Math.max(0.3, env); P.drag = 1.1; P.grav = 1.75; P.size = 0.48 * Math.max(0.7, scale);
        P.trail = 0.08; P.flicker = 0.5; P.flags = FLAG.GLITTER;
        emit();
      }
      break;
    }
    default:
      rocket();
      burstFlash();
      sphere({ n: count(120) });
      addFlash(burst, c0, 0.6);
  }
  return info;
}

export function createBuildTarget() {
  return { trails: new Writer(4096), sparks: new Writer(8192), flashes: [] };
}

export function resetBuildTarget(out) {
  out.trails.reset();
  out.sparks.reset();
  out.flashes.length = 0;
}
