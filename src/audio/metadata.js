import { parseBlob, TimestampFormat } from 'music-metadata';
import { fromSyncText, looksLikeLRC, parseLRC, plainLyrics } from '../lyrics/lrc.js';

/** "01 - Artist – Title_(Official).mp3" → { artist, title } */
export function parseFilename(name) {
  const base = String(name || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/_/g, ' ')
    .replace(/\s*[([](official.*?|lyrics?|audio|hq|hd|video|visuali[sz]er)[)\]]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleaned = base.replace(/^\d{1,3}\s*[-.)]\s*/, '');
  const m = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: cleaned || 'Untitled track' };
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('metadata timeout')), ms))]);

/**
 * Read title / artist / album / cover art / embedded lyrics from a file.
 * Never throws — falls back to the filename.
 */
export async function readMetadata(file) {
  const fb = parseFilename(file.name);
  try {
    const mm = await withTimeout(parseBlob(file, { duration: false, skipPostHeaders: true }), 5000);
    const c = mm.common || {};
    let cover = null;
    const pic = c.picture && c.picture[0];
    if (pic && pic.data && pic.data.length < 8_000_000) {
      cover = URL.createObjectURL(new Blob([pic.data], { type: pic.format || 'image/jpeg' }));
    }
    let lyrics = null;
    for (const l of c.lyrics || []) {
      if (l.syncText && l.syncText.length && l.timeStampFormat === TimestampFormat.milliseconds) {
        const ly = fromSyncText(l.syncText, 'embedded');
        if (ly.lines.length) { lyrics = ly; break; }
      }
      if (l.text && looksLikeLRC(l.text)) {
        const ly = parseLRC(l.text, 'embedded');
        if (ly.lines.length) { lyrics = ly; break; }
      }
      if (l.text && !lyrics) lyrics = plainLyrics(l.text, 'embedded');
    }
    return {
      title: (c.title || '').trim() || fb.title,
      artist: (c.artist || '').trim() || fb.artist,
      album: (c.album || '').trim(),
      cover,
      lyrics,
      fromTags: !!c.title,
    };
  } catch {
    return { ...fb, album: '', cover: null, lyrics: null, fromTags: false };
  }
}
