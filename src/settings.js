const KEY = 'pyrosonic:settings:v1';

export const DEFAULTS = {
  intensity: 1,
  quality: 'auto',
  crowd: true,
  motion: true,
  reduceFlashing: false,
  sfx: false,
  captions: true,
  lyricsOnline: true,
  offsetMs: 0,
  volume: 0.85,
  muted: false,
};

export function loadSettings() {
  const s = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const k of Object.keys(DEFAULTS)) {
        if (saved && typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
      }
    }
  } catch {
    /* storage unavailable (private mode etc.) — use defaults */
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    s.motion = false;
  }
  return s;
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
