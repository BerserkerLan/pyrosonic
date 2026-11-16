import { COLOR_WORDS } from '../show/palettes.js';

/**
 * Words that call for a specific firework. Deliberately avoids very common
 * words ("up", "light", "fall") so lyric moments stay special.
 */
const KINDS = {
  heart: ['love', 'loved', 'lover', 'lovers', 'loving', 'heart', 'hearts', 'heartbeat', 'kiss', 'kisses', 'darling', 'sweetheart', 'valentine'],
  star: ['star', 'stars', 'starlight', 'starry', 'galaxy', 'galaxies', 'constellation', 'constellations', 'comet', 'cosmic', 'supernova'],
  fire: ['fire', 'fires', 'burn', 'burning', 'burns', 'flame', 'flames', 'blaze', 'blazing', 'ignite', 'ignites', 'inferno', 'spark', 'sparks', 'sparkle', 'sparkles'],
  gold: ['gold', 'golden', 'sunshine', 'sunlight', 'shine', 'shining', 'glitter', 'glittering', 'glow', 'glowing'],
  rain: ['rain', 'raining', 'rains', 'tears', 'teardrops', 'crying', 'ocean', 'oceans', 'waves', 'drowning', 'waterfall'],
  sky: ['sky', 'skies', 'flying', 'heaven', 'heavens', 'higher', 'rising', 'clouds', 'skyline'],
  night: ['night', 'tonight', 'midnight', 'darkness', 'moon', 'moonlight', 'shadows'],
  boom: ['boom', 'bang', 'explode', 'exploding', 'explosion', 'firework', 'fireworks', 'dynamite', 'bomb', 'thunder', 'lightning', 'kaboom', 'blast'],
  dance: ['dance', 'dancing', 'party', 'jump', 'jumping', 'groove'],
  rainbow: ['rainbow', 'rainbows', 'colours', 'colors', 'colourful', 'colorful', 'kaleidoscope'],
  ring: ['forever', 'eternal', 'eternity', 'circle', 'infinity'],
};

const WORD_TO_KIND = new Map();
for (const [kind, words] of Object.entries(KINDS)) for (const w of words) WORD_TO_KIND.set(w, kind);

const clean = (w) => w.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z']/g, '').replace(/'s$/, '');

/**
 * Extract timed cues from synced lyrics.
 * @returns {Array<{t, word, kind, color?, lineStart, lineEnd}>}
 */
export function lyricCues(lyrics) {
  if (!lyrics || !lyrics.synced) return [];
  const cues = [];
  for (const line of lyrics.lines) {
    const tokens = line.words.length
      ? line.words.map((w) => ({ text: w.text, t: w.t }))
      : estimateWordTimes(line);
    const seen = new Set();
    for (const tok of tokens) {
      const w = clean(tok.text);
      if (!w || seen.has(w)) continue;
      // Firework keywords win over plain colour words ("golden" → a gold kamuro).
      const kind = WORD_TO_KIND.get(w);
      if (kind) {
        seen.add(w);
        cues.push({ t: tok.t, word: w, kind, lineStart: line.t, lineEnd: line.end });
        continue;
      }
      const color = COLOR_WORDS[w];
      if (color) {
        seen.add(w);
        cues.push({ t: tok.t, word: w, kind: 'color', color, lineStart: line.t, lineEnd: line.end });
      }
    }
  }
  return cues.sort((a, b) => a.t - b.t);
}

/** Without word timing, spread words across the line proportionally to their length. */
function estimateWordTimes(line) {
  const parts = line.text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((a, p) => a + p.length + 1, 0) || 1;
  const span = Math.max(0.5, (line.end - line.t) * 0.85);
  let acc = 0;
  return parts.map((p) => {
    const t = line.t + (acc / total) * span;
    acc += p.length + 1;
    return { text: p, t };
  });
}
