import { load as loadYaml } from 'js-yaml';
import { parseLRC, plainLyrics, finalize } from './lrc.js';

/**
 * LRCLIB (https://lrclib.net) — a free, open database of time-synced lyrics.
 * Only the track title, artist and duration are sent; never the audio.
 */
const API = 'https://lrclib.net/api';

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/feat\.?.*$/, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function similarity(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(A.size, B.size);
}

async function getJSON(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Lyrics service responded ${res.status}`);
  return res.json();
}

/** Parse LRCLIB's word-synced "lyricsfile" (YAML) into our lyrics model. */
export function parseLyricsfile(yamlText) {
  const doc = loadYaml(yamlText);
  const lines = Array.isArray(doc?.lines) ? doc.lines : [];
  const entries = [];
  for (const l of lines) {
    const t = Number(l?.start_ms) / 1000;
    if (!Number.isFinite(t)) continue;
    const text = String(l.text ?? '').replace(/\s+/g, ' ').trim();
    const words = (Array.isArray(l.words) ? l.words : [])
      .map((w) => ({ t: Number(w?.start_ms) / 1000, text: String(w?.text ?? ''), end: Number.isFinite(Number(w?.end_ms)) ? Number(w.end_ms) / 1000 : undefined }))
      .filter((w) => Number.isFinite(w.t) && w.text.trim());
    const end = Number.isFinite(Number(l.end_ms)) ? Number(l.end_ms) / 1000 : undefined;
    entries.push({ t, end, text, words });
  }
  entries.sort((a, b) => a.t - b.t);
  return finalize(entries, 'lrclib');
}

function toLyrics(rec) {
  if (rec.lyricsfile && rec.hasWordSync) {
    try {
      const ly = parseLyricsfile(rec.lyricsfile);
      if (ly.lines.length) return ly;
    } catch {
      /* fall back to LRC */
    }
  }
  if (rec.syncedLyrics) {
    const ly = parseLRC(rec.syncedLyrics, 'lrclib');
    if (ly.lines.length) return ly;
  }
  if (rec.plainLyrics) return plainLyrics(rec.plainLyrics, 'lrclib');
  return null;
}

/**
 * Find the best-matching lyrics for a track.
 * @returns {Promise<{lyrics, match: {title, artist, album}} | {instrumental: true} | null>}
 */
export async function findLyrics({ title, artist, duration }, { signal } = {}) {
  if (!title || !title.trim()) return null;
  const params = new URLSearchParams({ track_name: title.trim() });
  if (artist && artist.trim()) params.set('artist_name', artist.trim());
  let list = await getJSON(`${API}/search?${params}`, signal);
  if ((!Array.isArray(list) || !list.length) && artist) {
    list = await getJSON(`${API}/search?q=${encodeURIComponent(`${artist} ${title}`)}`, signal);
  }
  if (!Array.isArray(list) || !list.length) return null;

  let best = null;
  let bestScore = -Infinity;
  let instrumentalHit = false;
  for (const r of list) {
    const d = Number.isFinite(r.duration) && duration ? Math.abs(r.duration - duration) : 4;
    if (d > 10) continue;
    const nameScore = similarity(r.trackName || r.name, title) * 6 + (artist ? similarity(r.artistName, artist) * 4 : 1);
    if (nameScore < 3) continue;
    if (r.instrumental) {
      if (d < 3) instrumentalHit = true;
      continue;
    }
    const s = nameScore - d * 1.2 + (r.syncedLyrics ? 8 : 0) + (r.hasWordSync ? 5 : 0);
    if (s > bestScore) { bestScore = s; best = r; }
  }
  if (!best) return instrumentalHit ? { instrumental: true } : null;
  const lyrics = toLyrics(best);
  if (!lyrics) return null;
  return { lyrics, match: { title: best.trackName, artist: best.artistName, album: best.albumName } };
}
