import { escapeHtml } from './dom.js';

/**
 * Karaoke-style captions: the current line, with word-by-word highlighting
 * when word timing is available, and a faint preview of the next line.
 * Words that triggered a firework cue get a gradient shimmer.
 */
export class LyricsView {
  constructor(root) {
    this.root = root;
    this.lyrics = null;
    this.cueWords = new Set();
    this.lineIdx = -2;
    this.wordIdx = -2;
    this.enabled = true;
    this.lineEls = null;
  }

  set(lyrics, cues = []) {
    this.lyrics = lyrics && lyrics.synced && lyrics.lines.length ? lyrics : null;
    this.cueWords = new Set(cues.map((c) => `${c.t.toFixed(2)}`));
    this.lineIdx = -2;
    this.wordIdx = -2;
    this.root.innerHTML = '';
  }

  setEnabled(on) {
    this.enabled = on;
    this.root.style.opacity = on ? '1' : '0';
  }

  findLine(t) {
    const lines = this.lyrics.lines;
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (lines[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    if (ans >= 0 && t > lines[ans].end + 0.4) return -1;
    return ans;
  }

  update(t) {
    if (!this.lyrics || !this.enabled) return;
    const lead = 0.12; // show a line a touch before it's sung
    const idx = this.findLine(t + lead);
    if (idx !== this.lineIdx) {
      this.lineIdx = idx;
      this.wordIdx = -2;
      this.render(idx);
    }
    if (idx >= 0 && this.lineEls) {
      const line = this.lyrics.lines[idx];
      if (line.words.length) {
        let w = -1;
        for (let i = 0; i < line.words.length; i++) if (line.words[i].t <= t + 0.02) w = i;
        if (w !== this.wordIdx) {
          this.wordIdx = w;
          this.lineEls.forEach((el, i) => {
            el.classList.toggle('sung', i < w);
            el.classList.toggle('now', i === w);
          });
        }
      }
    }
  }

  render(idx) {
    const root = this.root;
    root.classList.add('swap');
    const lines = this.lyrics.lines;
    const build = () => {
      root.innerHTML = '';
      this.lineEls = null;
      if (idx < 0) {
        // Instrumental gap: preview the next line if it's close.
        root.classList.remove('swap');
        return;
      }
      const line = lines[idx];
      const cur = document.createElement('div');
      cur.className = 'line';
      if (line.words.length) {
        this.lineEls = line.words.map((w) => {
          const s = document.createElement('span');
          s.className = 'w' + (this.cueWords.has(w.t.toFixed(2)) ? ' cue' : '');
          s.textContent = w.text.endsWith(' ') ? w.text : w.text + (/[-–]$/.test(w.text) ? '' : ' ');
          cur.appendChild(s);
          return s;
        });
      } else {
        cur.innerHTML = escapeHtml(line.text);
      }
      root.appendChild(cur);
      this.wordIdx = -2; // re-apply highlighting to the fresh elements
      const nxt = lines[idx + 1];
      if (nxt && nxt.t - line.end < 4) {
        const n = document.createElement('div');
        n.className = 'line next';
        n.textContent = nxt.text;
        root.appendChild(n);
      }
      requestAnimationFrame(() => root.classList.remove('swap'));
    };
    clearTimeout(this.swapTimer);
    this.swapTimer = setTimeout(build, root.childElementCount ? 140 : 0);
  }

  clear() {
    clearTimeout(this.swapTimer);
    this.lyrics = null;
    this.root.innerHTML = '';
  }
}
