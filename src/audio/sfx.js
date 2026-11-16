/**
 * Synthesised pyrotechnic sounds (boom, crackle, whistle), scheduled on the
 * audio clock so they hit exactly with the bursts — and therefore the beat.
 */
export class PyroSfx {
  constructor(player) {
    this.player = player;
    this.buffers = null;
    this.enabled = false;
    this.scheduledUntil = -Infinity;
    this.nodes = new Set();
  }

  init() {
    if (this.buffers || !this.player.ctx) return;
    const ctx = this.player.ctx;
    const sr = ctx.sampleRate;
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const make = (dur, fn) => {
      const n = Math.floor(dur * sr);
      const buf = ctx.createBuffer(2, n, sr);
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      fn(L, R, n);
      return buf;
    };
    // Low "thoom": filtered noise + sub thump.
    const boom = (variant) =>
      make(1.6, (L, R, n) => {
        let lp1 = 0, lp2 = 0, ph = 0;
        const cut = 0.035 + variant * 0.012;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const env = Math.min(1, t / 0.004) * Math.exp(-t / (0.32 + variant * 0.08));
          const x = rnd() * 2 - 1;
          lp1 += cut * (x - lp1);
          lp2 += cut * (lp1 - lp2);
          ph += (2 * Math.PI * (48 + 30 * Math.exp(-t / 0.05))) / sr;
          const thump = Math.sin(ph) * Math.exp(-t / 0.18);
          const v = (lp2 * 9 + thump * 0.9) * env;
          L[i] = v;
          R[i] = v * 0.96;
        }
      });
    const crackle = () =>
      make(1.1, (L, R) => {
        const pops = 260;
        for (let p = 0; p < pops; p++) {
          const t0 = Math.pow(rnd(), 0.8) * 0.95;
          const start = Math.floor(t0 * sr);
          const len = Math.floor((0.002 + rnd() * 0.004) * sr);
          const amp = 0.25 + rnd() * 0.55;
          const pan = rnd();
          for (let i = 0; i < len && start + i < L.length; i++) {
            const v = (rnd() * 2 - 1) * amp * (1 - i / len);
            L[start + i] += v * (1 - pan * 0.6);
            R[start + i] += v * (0.4 + pan * 0.6);
          }
        }
      });
    const whistle = () =>
      make(1.4, (L, R, n) => {
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const f = 1100 + 1500 * (t / 1.4);
          ph += (2 * Math.PI * f) / sr;
          const env = Math.min(1, t / 0.08) * Math.min(1, (1.4 - t) / 0.12) * 0.16;
          const v = (Math.sin(ph) + 0.15 * (rnd() * 2 - 1)) * env;
          L[i] = v;
          R[i] = v;
        }
      });
    this.buffers = { boom: [boom(0), boom(1), boom(2)], crackle: [crackle(), crackle()], whistle: [whistle()] };
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this.init();
    if (!on) this.stopAll();
  }

  stopAll() {
    for (const n of this.nodes) {
      try { n.stop(); } catch { /* noop */ }
    }
    this.nodes.clear();
    this.scheduledUntil = -Infinity;
  }

  play(kind, when, gain = 1, rate = 1) {
    const ctx = this.player.ctx;
    if (!ctx || !this.buffers) return;
    const list = this.buffers[kind];
    const buf = list[Math.floor(Math.random() * list.length)];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.player.sfxBus);
    src.start(Math.max(ctx.currentTime, when));
    this.nodes.add(src);
    src.onended = () => {
      this.nodes.delete(src);
      try { g.disconnect(); } catch { /* noop */ }
    };
  }

  /** Schedule sounds for bursts in (songNow, songNow + lookahead]. */
  schedule(runner, songNow, lookahead = 0.25) {
    if (!this.enabled || !this.player.playing) return;
    const from = Math.max(this.scheduledUntil, songNow);
    const to = songNow + lookahead;
    if (to <= from) return;
    for (const ev of runner.burstsBetween(from, to)) {
      const when = this.player.songToContextTime(ev.t);
      const size = ev.size ?? 0.5;
      if (ev.type === 'fountain') continue;
      if (ev.type === 'comet') {
        if (ev.layer === 'build') this.play('whistle', when - 1.2, 0.25, 0.9 + size * 0.3);
        continue;
      }
      if (ev.type === 'glitter') { this.play('crackle', when, 0.18, 1.3); continue; }
      const big = ev.type === 'salute' || ev.layer === 'finale' || ev.layer === 'accent';
      this.play('boom', when, big ? 1 : 0.35 + size * 0.45, 1.25 - size * 0.4);
      if (ev.type === 'crackle' || ev.type === 'kamuro') this.play('crackle', when + 0.75, 0.5);
    }
    this.scheduledUntil = to;
  }
}
