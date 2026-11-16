import { buildEvent, createBuildTarget, resetBuildTarget } from './shells.js';

/** How far ahead of a launch we generate its particles (seconds). */
const AHEAD = 0.25;

function lowerBound(list, t, key) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (list[m][key] < t) lo = m + 1; else hi = m;
  }
  return lo;
}

/**
 * Streams choreographed events into the GPU just before they launch, keeps
 * the list of burst lights for the sky/water, and handles seeking: because
 * particles are analytic, a seek simply re-spawns whatever is in flight.
 */
export class ShowRunner {
  constructor(engine) {
    this.engine = engine;
    this.events = [];
    this.byBurst = [];
    this.next = 0;
    this.nextBurst = 0;
    this.lastT = -Infinity;
    this.target = createBuildTarget();
    this.flashes = [];
    this.active = [];
    this.reduceFlashing = false;
    this.density = 1;
    this.onBurst = null;
  }

  load(events, t = 0) {
    this.events = events;
    this.byBurst = events.slice().sort((a, b) => a.t - b.t);
    this.reset(t);
  }

  clear() {
    this.events = [];
    this.byBurst = [];
    this.next = 0;
    this.nextBurst = 0;
    this.flashes.length = 0;
    this.engine.clear();
  }

  opts() {
    return {
      stage: this.engine.stage,
      quality: this.engine.quality.density * this.density,
      reduceFlashing: this.reduceFlashing,
    };
  }

  spawn(ev) {
    resetBuildTarget(this.target);
    buildEvent(ev, this.opts(), this.target);
    this.engine.spawn(this.target);
    for (const f of this.target.flashes) this.flashes.push({ ...f });
  }

  /** Rebuild the sky for time t (used after seeking or changing settings). */
  reset(t) {
    this.engine.clear();
    this.flashes.length = 0;
    let i = 0;
    for (; i < this.events.length && this.events[i].launch <= t + AHEAD; i++) {
      if (this.events[i].end > t) this.spawn(this.events[i]);
    }
    this.next = i;
    this.nextBurst = lowerBound(this.byBurst, t, 't');
    this.lastT = t;
  }

  /** Advance to show time t. Returns the active burst lights, strongest first. */
  update(t) {
    if (t < this.lastT - 0.08 || t > this.lastT + 1.5) this.reset(t);
    const evs = this.events;
    while (this.next < evs.length && evs[this.next].launch <= t + AHEAD) {
      this.spawn(evs[this.next]);
      this.next++;
    }
    while (this.nextBurst < this.byBurst.length && this.byBurst[this.nextBurst].t <= t) {
      const ev = this.byBurst[this.nextBurst++];
      if (this.onBurst && t - ev.t < 0.25) this.onBurst(ev);
    }
    this.lastT = t;

    // Burst lights decay exponentially; keep the strongest few.
    const out = this.active;
    out.length = 0;
    let w = 0;
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      const age = t - f.t;
      if (age > f.decay * 7) continue;
      this.flashes[w++] = f;
      if (age < 0) continue;
      const i0 = f.strength * Math.exp(-age / f.decay) * Math.min(1, age / 0.03 + 0.2);
      if (i0 > 0.004) out.push({ x: f.x, y: f.y, z: f.z, r: f.r, g: f.g, b: f.b, i: i0 });
    }
    this.flashes.length = w;
    out.sort((a, b) => b.i - a.i);
    return out;
  }

  /** Events whose burst falls in (t0, t1] — used to schedule sound effects ahead of time. */
  burstsBetween(t0, t1) {
    const a = lowerBound(this.byBurst, t0 + 1e-6, 't');
    const res = [];
    for (let i = a; i < this.byBurst.length && this.byBurst[i].t <= t1; i++) res.push(this.byBurst[i]);
    return res;
  }
}
