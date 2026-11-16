/**
 * Pyrotechnic colour vocabulary. Real stars are limited by chemistry
 * (strontium red, barium green, copper blue, sodium gold…), so palettes are
 * built from this set rather than arbitrary RGB — it's a big part of what
 * makes the result read as "fireworks" rather than generic particles.
 */
export const COLORS = {
  red: { hex: '#ff2a1e', hue: 2, label: 'Strontium red' },
  orange: { hex: '#ff7a1a', hue: 24 },
  gold: { hex: '#ffb546', hue: 38 },
  yellow: { hex: '#ffe352', hue: 52 },
  lime: { hex: '#b6ff3c', hue: 86 },
  green: { hex: '#2bff6e', hue: 138 },
  teal: { hex: '#1ff2d2', hue: 170 },
  cyan: { hex: '#33c6ff', hue: 198 },
  blue: { hex: '#3a5cff', hue: 228 },
  violet: { hex: '#8a48ff', hue: 262 },
  purple: { hex: '#cc48ff', hue: 286 },
  magenta: { hex: '#ff3dce', hue: 312 },
  pink: { hex: '#ff6aa6', hue: 338 },
  white: { hex: '#f5f7ff', hue: null },
  silver: { hex: '#c9d4ff', hue: null },
};

export const CHROMATIC = Object.keys(COLORS).filter((k) => COLORS[k].hue !== null);

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

const linearCache = new Map();
/** Linear-light RGB triple for a colour key (or hex string). */
export function linearRGB(key) {
  if (linearCache.has(key)) return linearCache.get(key);
  const hex = COLORS[key]?.hex ?? key;
  const n = parseInt(hex.slice(1), 16);
  const rgb = [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
  linearCache.set(key, rgb);
  return rgb;
}

export function hexOf(key) {
  return COLORS[key]?.hex ?? key;
}

const hueDist = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Nearest chromatic firework colour for a hue in degrees. */
export function colorForHue(h) {
  h = ((h % 360) + 360) % 360;
  let best = 'red';
  let bd = 999;
  for (const k of CHROMATIC) {
    const d = hueDist(COLORS[k].hue, h);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

/**
 * Pitch class → hue around the circle of fifths, so harmonically close keys
 * and chords get neighbouring colours (C red, G orange, D yellow, A lime …).
 */
export function pitchClassHue(pc) {
  const fifths = (pc * 7) % 12;
  return fifths * 30;
}

/**
 * Section palette: 3–5 colour keys derived from the harmony (root pitch
 * class), how intense the section is and the song's mode.
 */
export function buildPalette({ root, mode, level, brightness = 0.5, rng }) {
  const base = pitchClassHue(root) + rng.range(-8, 8);
  const c = (dh) => colorForHue(base + dh);
  let keys;
  switch (level) {
    case 0:
      keys = [c(0), 'gold', c(rng.pick([-35, 35]))];
      break;
    case 1:
      keys = [c(0), c(rng.pick([-45, 45])), rng.chance(0.5) ? 'gold' : 'silver'];
      break;
    case 2:
      keys = [c(0), c(rng.pick([150, 180, 210])), rng.chance(0.6) ? 'gold' : 'silver'];
      break;
    case 3:
      keys = [c(0), c(120), c(240), 'white'];
      break;
    default:
      keys = [c(0), c(120), c(240), 'gold', 'white'];
  }
  if (mode === 'minor') {
    // Minor keys lean cooler: swap the warmest secondary colour for a cool one.
    const warm = ['orange', 'yellow', 'lime'];
    for (let i = 1; i < keys.length; i++) {
      if (warm.includes(keys[i])) { keys[i] = rng.pick(['violet', 'cyan', 'blue', 'purple']); break; }
    }
  }
  if (brightness > 0.7 && !keys.includes('silver') && !keys.includes('white')) keys.push('silver');
  // De-duplicate while keeping order.
  return [...new Set(keys)];
}

/** Colour words that lyrics can call out directly. */
export const COLOR_WORDS = {
  red: 'red', crimson: 'red', scarlet: 'red', ruby: 'red', blood: 'red', cherry: 'red', rose: 'pink', roses: 'pink',
  orange: 'orange', amber: 'orange', sunset: 'orange',
  gold: 'gold', golden: 'gold',
  yellow: 'yellow', lemon: 'yellow', sunshine: 'yellow',
  green: 'green', emerald: 'green', jade: 'green',
  teal: 'teal', turquoise: 'teal', aqua: 'teal',
  blue: 'blue', ocean: 'blue', sapphire: 'blue', navy: 'blue', azure: 'cyan', cyan: 'cyan',
  purple: 'purple', violet: 'violet', lavender: 'violet', indigo: 'violet',
  pink: 'pink', magenta: 'magenta',
  white: 'white', snow: 'white', silver: 'silver', diamond: 'white', diamonds: 'white', crystal: 'silver',
};
