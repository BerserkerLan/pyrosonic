import { Rng } from './rng.js';
import { flightTime } from './shells.js';

const TYPES = { peony: 3, chrysanthemum: 3, willow: 1.4, ring: 1, palm: 1.2, kamuro: 1, dahlia: 1.2, crossette: 0.8, crackle: 0.6 };
const PALETTES = [
  ['gold', 'red', 'white'],
  ['violet', 'cyan', 'silver'],
  ['magenta', 'gold', 'blue'],
  ['green', 'gold', 'white'],
  ['orange', 'purple', 'gold'],
  ['teal', 'pink', 'white'],
  ['red', 'blue', 'white'],
];

/**
 * Gentle, unsynchronised fireworks for the landing and analysis screens.
 * Events are generated a little ahead of time so their rockets rise naturally.
 */
export class AmbientDirector {
  constructor(runner, seed = Date.now() >>> 0) {
    this.runner = runner;
    this.rng = new Rng(seed);
    this.nextAt = 0;
    this.started = false;
    this.calm = false;
  }

  reset(t) {
    // First burst lands just after its rocket has had time to climb.
    this.nextAt = t + 2.45;
    this.started = true;
  }

  update(t) {
    if (!this.started) this.reset(t);
    if (this.nextAt < t - 1) this.nextAt = t + 0.6; // tab was hidden: skip, don't flood the sky
    // Generate bursts ~2.6 s ahead so rockets are already climbing.
    while (this.nextAt < t + 2.6) {
      const at = this.nextAt;
      const rng = this.rng;
      const pal = PALETTES[Math.floor(at / 11) % PALETTES.length];
      const n = rng.chance(0.18) ? 2 : 1;
      const type = rng.weighted(TYPES);
      const xs = n === 2 ? [rng.range(-0.7, -0.25), rng.range(0.25, 0.7)] : [rng.range(-0.75, 0.75)];
      for (const x of xs) {
        const y = rng.range(0.5, 0.92);
        const ev = {
          t: at,
          type,
          variant: type === 'ring' ? rng.pick(['', 'double', 'saturn']) : type === 'peony' && rng.chance(0.3) ? 'pistil' : '',
          x,
          lx: x + rng.range(-0.05, 0.05),
          y,
          z: rng.range(-1, 1),
          size: rng.range(0.55, 0.9),
          colors: [rng.pick(pal), rng.pick(pal), 'white'],
          intensity: this.calm ? 0.7 : 0.95,
          seed: rng.seed32(),
          layer: 'ambient',
        };
        if (ev.t - flightTime(ev.y) < t - 0.05) ev.y = Math.max(0.3, ev.y - 0.25);
        this.runner.spawn(ev);
      }
      this.nextAt += (this.calm ? 1.6 : 1.05) * rng.range(0.6, 1.5);
    }
  }
}
