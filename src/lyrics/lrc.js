/**
 * Lyrics model used across the app:
 *   { source, synced, wordSynced, lines: [{ t, end, text, words: [{ t, end, text }] }], plain }
 */

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

const toSeconds = (m, s, frac) => {
  let f = 0;
  if (frac) f = Number(frac) / Math.pow(10, frac.length);
  return Number(m) * 60 + Number(s) + f;
};

export function looksLikeLRC(text) {
  return /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text || '');
}

/** Parse LRC, including repeated time tags, [offset:], and enhanced <mm:ss.xx> word tags. */
export function parseLRC(text, source = 'file') {
  let offset = 0;
  const entries = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const off = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
    if (off) { offset = Number(off[1]) / 1000; continue; }
    if (/^\[[a-z]+:.*\]$/i.test(line) && !/^\[\d/.test(line)) continue; // metadata tag
    const times = [];
    TIME_TAG.lastIndex = 0;
    let m;
    let lastIndex = 0;
    while ((m = TIME_TAG.exec(line)) && m.index === lastIndex) {
      times.push(toSeconds(m[1], m[2], m[3]));
      lastIndex = TIME_TAG.lastIndex;
    }
    if (!times.length) continue;
    const body = line.slice(lastIndex);
    // Enhanced word timing.
    const words = [];
    WORD_TAG.lastIndex = 0;
    const tags = [...body.matchAll(WORD_TAG)];
    if (tags.length) {
      for (let i = 0; i < tags.length; i++) {
        const tg = tags[i];
        const start = tg.index + tg[0].length;
        const stop = i + 1 < tags.length ? tags[i + 1].index : body.length;
        const w = body.slice(start, stop);
        if (w.trim()) words.push({ t: toSeconds(tg[1], tg[2], tg[3]), text: w });
      }
    }
    const plain = body.replace(WORD_TAG, '').replace(/\s+/g, ' ').trim();
    for (const t of times) entries.push({ t, text: plain, words: words.map((w) => ({ ...w })) });
  }
  // [offset:+n] means lyrics should appear n ms *earlier*.
  for (const e of entries) {
    e.t = Math.max(0, e.t - offset);
    for (const w of e.words) w.t = Math.max(0, w.t - offset);
  }
  entries.sort((a, b) => a.t - b.t);
  return finalize(entries, source);
}

/** Fill in line/word end times and drop empty spacer lines. */
export function finalize(entries, source) {
  const lines = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const next = entries[i + 1];
    const end = e.end ?? (next ? Math.min(next.t, e.t + 12) : e.t + 6);
    if (!e.text) continue;
    const words = (e.words || []).filter((w) => w.text && w.text.trim());
    for (let j = 0; j < words.length; j++) {
      words[j].end = words[j].end ?? (words[j + 1] ? words[j + 1].t : Math.max(words[j].t + 0.3, end));
    }
    lines.push({ t: e.t, end: Math.max(end, e.t + 0.5), text: e.text, words });
  }
  return {
    source,
    synced: lines.length > 0,
    wordSynced: lines.length > 0 && lines.filter((l) => l.words.length).length / lines.length > 0.6,
    lines,
    plain: lines.map((l) => l.text).join('\n'),
  };
}

/** Lyrics without timing (still useful for mood/colour words, not for sync). */
export function plainLyrics(text, source) {
  return { source, synced: false, wordSynced: false, lines: [], plain: String(text || '').trim() };
}

/** Lyrics from an ID3 SYLT frame (music-metadata `syncText`, timestamps in ms). */
export function fromSyncText(syncText, source = 'embedded') {
  const entries = syncText
    .filter((s) => typeof s.timestamp === 'number')
    .map((s) => ({ t: s.timestamp / 1000, text: String(s.text || '').replace(/\s+/g, ' ').trim(), words: [] }))
    .sort((a, b) => a.t - b.t);
  return finalize(entries, source);
}
