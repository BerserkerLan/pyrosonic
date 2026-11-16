const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Sample-accurate playback on the Web Audio clock.
 *
 * `position()` reports the song time of the sound *currently leaving the
 * speakers* (output latency compensated), which is what the visuals must
 * match — bursts land exactly when you hear the beat, even over Bluetooth.
 */
export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.master = null;
    this.music = null;
    this.sfxBus = null;
    this.playing = false;
    this.offset = 0;
    this.startCtx = 0;
    this.startOffset = 0;
    this.token = 0;
    this.volume = 0.9;
    this.muted = false;
    this.onEnded = null;
  }

  /** Must be called from a user gesture the first time (autoplay policies). */
  ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio is not supported in this browser.');
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.music = this.ctx.createGain();
      this.music.connect(this.master);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 0.5;
      this.sfxBus.connect(this.master);
      this.applyVolume();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  async decode(arrayBuffer) {
    const ctx = this.ensureContext();
    return await new Promise((resolve, reject) => {
      // Promise form is universal now, but keep callbacks for older Safari.
      const p = ctx.decodeAudioData(arrayBuffer, resolve, (e) => reject(e || new Error('decode failed')));
      if (p && typeof p.then === 'function') p.then(resolve, (e) => reject(e || new Error('decode failed')));
    });
  }

  setBuffer(buffer) {
    this.stopSource();
    this.playing = false;
    this.buffer = buffer;
    this.offset = 0;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /** Start playing from `from` seconds after `delay` seconds of silence (a pre-roll). */
  play(from = this.offset, delay = 0) {
    if (!this.buffer) return;
    const ctx = this.ensureContext();
    this.stopSource();
    const off = clamp(from, 0, Math.max(0, this.duration - 0.001));
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.music);
    const when = ctx.currentTime + Math.max(0, delay) + 0.02;
    src.start(when, off);
    this.source = src;
    this.startCtx = when;
    this.startOffset = off;
    this.playing = true;
    const token = ++this.token;
    src.onended = () => {
      if (token !== this.token || !this.playing) return;
      this.playing = false;
      this.offset = this.duration;
      this.source = null;
      this.onEnded?.();
    };
  }

  pause() {
    if (!this.playing) return;
    this.offset = clamp(this.position(), 0, this.duration);
    this.stopSource();
    this.playing = false;
  }

  seek(t) {
    const target = clamp(t, 0, this.duration);
    if (this.playing) this.play(target, 0);
    else this.offset = target;
  }

  stopSource() {
    if (this.source) {
      this.token++;
      try { this.source.stop(); } catch { /* already stopped */ }
      try { this.source.disconnect(); } catch { /* noop */ }
      this.source = null;
    }
  }

  /** Context time of the sample currently audible at the speakers. */
  audibleTime() {
    const ctx = this.ctx;
    if (!ctx) return 0;
    if (typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
        const t = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
        // Guard against stale timestamps (e.g. a suspended context).
        if (Math.abs(t - ctx.currentTime) < 0.5) return t;
      }
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  /** Song position (s) of what is heard right now. Negative during a pre-roll. */
  position() {
    if (!this.playing) return this.offset;
    return this.startOffset + (this.audibleTime() - this.startCtx);
  }

  /**
   * AudioContext time at which song time `songT` enters the audio graph.
   * Sound effects scheduled there share the music's output latency, so they
   * are heard in sync with it.
   */
  songToContextTime(songT) {
    return this.startCtx + (songT - this.startOffset);
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    this.applyVolume();
  }

  setMuted(m) {
    this.muted = m;
    this.applyVolume();
  }

  applyVolume() {
    if (!this.master) return;
    const v = this.muted ? 0 : this.volume * this.volume;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  setSfxLevel(v) {
    if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }
}
