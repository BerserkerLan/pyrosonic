import { hexOf } from '../show/palettes.js';
import { formatTime } from './dom.js';

/**
 * Seek bar that doubles as a map of the show: one coloured band per song
 * section (in that section's firework palette), the waveform, and markers
 * for drops.
 */
export class Timeline {
  constructor(root, { onSeek }) {
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.playhead = root.querySelector('.playhead');
    this.tip = root.querySelector('.tl-tip');
    this.onSeek = onSeek;
    this.data = null;
    this.duration = 1;
    this.progress = 0;
    this.dragging = false;

    const pos = (e) => {
      const r = root.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
    };
    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      root.classList.add('dragging');
      root.setPointerCapture(e.pointerId);
      this.preview(pos(e));
      this.onSeek(pos(e) * this.duration, false);
    });
    root.addEventListener('pointermove', (e) => {
      this.hover(pos(e));
      if (this.dragging) {
        this.preview(pos(e));
        this.onSeek(pos(e) * this.duration, false);
      }
    });
    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      root.classList.remove('dragging');
      this.onSeek(pos(e) * this.duration, true);
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 15 : 5;
      if (e.key === 'ArrowRight') { this.onSeek(this.progress * this.duration + step, true); e.preventDefault(); e.stopPropagation(); }
      if (e.key === 'ArrowLeft') { this.onSeek(this.progress * this.duration - step, true); e.preventDefault(); e.stopPropagation(); }
    });
    this.width = root.clientWidth || 1;
    // A GPU reset wipes accelerated 2D canvases; repaint when they come back.
    this.canvas.addEventListener('contextrestored', () => this.draw());
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(root);
  }

  /** @param data {duration, sections:[{start,end,level,label,color}], waveform: Float32Array, drops:[t]} */
  setData(data) {
    this.data = data;
    this.duration = Math.max(0.001, data.duration);
    this.root.setAttribute('aria-valuemax', String(Math.round(this.duration)));
    this.draw();
  }

  sectionAt(t) {
    if (!this.data) return null;
    return this.data.sections.find((s) => t >= s.start && t < s.end) || null;
  }

  hover(p) {
    const t = p * this.duration;
    const s = this.sectionAt(t);
    this.tip.textContent = `${formatTime(t)}${s ? ` · ${s.label}` : ''}`;
    const w = this.root.clientWidth;
    this.tip.style.left = `${Math.min(w - 50, Math.max(50, p * w))}px`;
  }

  preview(p) {
    this.setProgress(p * this.duration);
  }

  setProgress(t) {
    this.progress = Math.min(1, Math.max(0, t / this.duration));
    const w = this.width;
    this.playhead.style.transform = `translateX(${(this.progress * w).toFixed(1)}px)`;
    if (this.played) this.played.style.clipPath = `inset(0 ${((1 - this.progress) * 100).toFixed(3)}% 0 0)`;
    this.root.setAttribute('aria-valuenow', String(Math.round(this.progress * this.duration)));
    this.root.setAttribute('aria-valuetext', formatTime(this.progress * this.duration));
  }

  draw() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, this.root.clientWidth);
    const h = Math.max(1, this.root.clientHeight);
    this.width = w;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    if (!this.played) {
      this.played = document.createElement('canvas');
      this.played.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
      this.root.insertBefore(this.played, this.playhead);
    }
    this.played.width = c.width;
    this.played.height = c.height;
    this.paint(c.getContext('2d'), w, h, dpr, false);
    this.paint(this.played.getContext('2d'), w, h, dpr, true);
    this.setProgress(this.progress * this.duration);
  }

  paint(g, w, h, dpr, bright) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!this.data) return;
    const { sections, waveform, drops } = this.data;
    const D = this.duration;
    const mid = h / 2;
    // Section bands
    for (const s of sections) {
      const x0 = (s.start / D) * w + 1;
      const x1 = (s.end / D) * w - 1;
      if (x1 <= x0) continue;
      g.fillStyle = s.color;
      g.globalAlpha = bright ? 0.22 + s.level * 0.05 : 0.07 + s.level * 0.025;
      roundRect(g, x0, 3, x1 - x0, h - 6, 6);
      g.fill();
    }
    // Waveform
    const bars = Math.floor(w / 3);
    for (let i = 0; i < bars; i++) {
      const t = ((i + 0.5) / bars) * D;
      const a = Math.floor((i / bars) * waveform.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * waveform.length));
      let m = 0;
      for (let k = a; k < b && k < waveform.length; k++) m = Math.max(m, waveform[k]);
      const bh = Math.max(1.5, m * (h - 12));
      const s = this.sectionAt(t);
      g.fillStyle = bright ? '#ffffff' : s ? s.color : '#ffffff';
      g.globalAlpha = bright ? 0.92 : 0.38;
      g.fillRect(i * 3 + 0.5, mid - bh / 2, 1.6, bh);
    }
    // Drops
    g.globalAlpha = bright ? 1 : 0.75;
    g.fillStyle = '#ffffff';
    for (const t of drops) {
      const x = (t / D) * w;
      g.beginPath();
      g.moveTo(x, 1);
      g.lineTo(x + 3.5, 5);
      g.lineTo(x, 9);
      g.lineTo(x - 3.5, 5);
      g.closePath();
      g.fill();
    }
    g.globalAlpha = 1;
  }

  dispose() {
    this.ro.disconnect();
  }
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function sectionColor(palette) {
  const key = (palette || []).find((k) => k !== 'white' && k !== 'silver') || 'gold';
  return hexOf(key);
}
