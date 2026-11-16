import { Engine } from './render/engine.js';
import { ShowRunner } from './show/runner.js';
import { AmbientDirector } from './show/ambient.js';
import { choreograph } from './show/choreographer.js';
import { hashString } from './show/rng.js';
import { AudioPlayer } from './audio/player.js';
import { PyroSfx } from './audio/sfx.js';
import { readMetadata, parseFilename } from './audio/metadata.js';
import { findLyrics } from './lyrics/lrclib.js';
import { parseLRC, looksLikeLRC } from './lyrics/lrc.js';
import { lyricCues } from './lyrics/keywords.js';
import { Timeline, sectionColor } from './ui/timeline.js';
import { LyricsView } from './ui/lyrics-view.js';
import { $, $$, formatTime, toast, setSwitch, setSegmented, escapeHtml } from './ui/dom.js';
import { ICONS } from './ui/icons.js';
import { loadSettings, saveSettings } from './settings.js';

const PREROLL = 2.4;
const MAX_FILE_BYTES = 400 * 1024 * 1024;
const MAX_DURATION = 30 * 60;
const AUDIO_EXT = /\.(mp3|wav|wave|flac|ogg|oga|opus|m4a|m4b|aac|mp4|webm|aif|aiff|caf)$/i;

const STEP_FOR_STAGE = {
  prepare: 'rhythm',
  spectrum: 'rhythm',
  harmony: 'rhythm',
  rhythm: 'rhythm',
  harmony2: 'harmony',
  structure: 'structure',
  done: 'structure',
};
const STAGE_RANGE = {
  prepare: [0.1, 0.14],
  spectrum: [0.14, 0.58],
  harmony: [0.58, 0.7],
  rhythm: [0.7, 0.8],
  harmony2: [0.8, 0.84],
  structure: [0.84, 0.9],
  done: [0.9, 0.9],
};

function pickInitialQuality() {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const small = Math.min(window.screen?.width || 1920, window.screen?.height || 1080) < 700;
  const cores = navigator.hardwareConcurrency || 4;
  if (coarse && small) return 'low';
  if (coarse || cores <= 4) return 'medium';
  return 'high';
}

export class App {
  constructor() {
    this.settings = loadSettings();
    this.view = null;
    this.prepared = null;
    this.jobId = 0;
    this.worker = null;
    this.clock = { valid: false, visual: 0 };
    this.tail = false;
    this.lastFrame = performance.now();
    this.uiTimer = 0;
    this.pinnedHidden = false;
    this.beatIdx = 0;
    this.sectionIdx = -1;
    this.lastTimeText = '';
    this.perf = { ema: 1 / 60, slowFor: 0, level: null, locked: false };
    this.coverUrl = null;
    this.wakeLock = null;

    const canvas = $('#stage');
    const initialQuality = this.settings.quality === 'auto' ? pickInitialQuality() : this.settings.quality;
    try {
      this.engine = new Engine(canvas, { quality: initialQuality, reducedMotion: !this.settings.motion });
    } catch (err) {
      console.error(err);
      this.fatal('Your browser could not start WebGL', 'Pyrosonic draws its fireworks with WebGL 2. Try a recent version of Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.');
      return;
    }
    this.perf.level = initialQuality;
    this.engine.setCrowd(this.settings.crowd);
    this.engine.setReducedFlashing(this.settings.reduceFlashing);
    this.gfxResume = false;
    this.engine.onContextLost = () => this.onGraphicsLost();
    this.engine.onContextRestored = () => this.onGraphicsRestored();

    this.runner = new ShowRunner(this.engine);
    this.runner.reduceFlashing = this.settings.reduceFlashing;
    this.runner.onBurst = (ev) => this.onBurst(ev);
    this.ambient = new AmbientDirector(this.runner);
    this.ambientT0 = performance.now() / 1000;

    this.player = new AudioPlayer();
    this.player.setVolume(this.settings.volume);
    this.player.setMuted(this.settings.muted);
    this.player.onEnded = () => this.onAudioEnded();
    this.sfx = new PyroSfx(this.player);

    this.timeline = new Timeline($('#timeline'), { onSeek: (t, commit) => this.seek(t, commit) });
    this.lyricsView = new LyricsView($('#lyrics'));
    this.lyricsView.setEnabled(this.settings.captions);

    this.bindUI();
    this.applySettingsToUI();
    this.setView('home');
    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => this.onVisibility());
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  fatal(title, msg) {
    const el = document.createElement('div');
    el.className = 'fatal';
    el.innerHTML = `<div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(msg)}</p></div>`;
    document.body.appendChild(el);
  }

  // ---- Views -------------------------------------------------------------------------------

  setView(name) {
    if (this.view === name) return;
    const prevName = this.view;
    const prev = prevName ? $(`#view-${prevName}`) : null;
    const next = $(`#view-${name}`);
    this.view = name;
    document.body.dataset.view = name;
    if (prev) {
      prev.classList.add('leaving');
      setTimeout(() => {
        if (this.view !== prevName) {
          prev.classList.add('hidden');
          prev.classList.remove('leaving');
        }
      }, 560);
    }
    next.classList.remove('hidden', 'leaving');
    next.classList.add('entering');
    requestAnimationFrame(() => requestAnimationFrame(() => next.classList.remove('entering')));
    $('#scrim').classList.toggle('off', name === 'show');
    // The crowd frames the show; on the landing screens it would only peek out under the UI.
    this.engine.setCrowd((name === 'show' || name === 'end') && this.settings.crowd);
    $('#btn-how').classList.toggle('hidden', name === 'show');
    if (name !== 'show') {
      this.pinnedHidden = false;
      document.body.classList.remove('ui-hidden', 'cursor-hidden');
      this.closeSettings();
    }
  }

  // ---- UI wiring ---------------------------------------------------------------------------

  bindUI() {
    const fileInput = $('#file-input');
    const lrcInput = $('#lrc-input');
    const dz = $('#dropzone');
    dz.addEventListener('click', () => fileInput.click());
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (f) this.handleFile(f);
    });
    lrcInput.addEventListener('change', async () => {
      const f = lrcInput.files && lrcInput.files[0];
      lrcInput.value = '';
      if (f) this.loadLyricsFile(f);
    });
    $('#btn-demo').addEventListener('click', () => this.playDemo());
    $('#brand').addEventListener('click', () => this.goHome());

    // How-it-works dialog
    const dlg = $('#dlg-how');
    $('#dlg-close').innerHTML = ICONS.close;
    $('#btn-how').addEventListener('click', () => dlg.showModal());
    $('#dlg-close').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });

    // Analysis card
    $('#an-cancel').addEventListener('click', () => {
      this.cancelAnalysis();
      this.goHome();
    });
    $('#an-start').addEventListener('click', () => this.startShow());
    $('#an-load-lrc').addEventListener('click', () => lrcInput.click());

    // Show controls
    $('#btn-play').innerHTML = ICONS.play;
    $('#btn-play').addEventListener('click', () => this.togglePlay());
    $('#btn-mute').addEventListener('click', () => this.toggleMute());
    const vol = $('#volume');
    vol.addEventListener('input', () => {
      this.settings.volume = Number(vol.value);
      if (this.settings.muted && this.settings.volume > 0) this.settings.muted = false;
      this.player.setMuted(this.settings.muted);
      this.player.setVolume(this.settings.volume);
      this.updateVolumeUI();
      saveSettings(this.settings);
    });
    $('#btn-captions').innerHTML = ICONS.captions;
    $('#btn-captions').addEventListener('click', () => this.setCaptions(!this.settings.captions));
    $('#btn-settings').innerHTML = ICONS.settings;
    $('#btn-settings').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSettings();
    });
    $('#btn-fullscreen').innerHTML = ICONS.fullscreen;
    $('#btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
    $('#btn-exit').innerHTML = ICONS.close;
    $('#btn-exit').addEventListener('click', () => this.goHome());
    document.addEventListener('fullscreenchange', () => this.updateFullscreenUI());
    document.addEventListener('webkitfullscreenchange', () => this.updateFullscreenUI());

    // Settings panel
    $$('#set-intensity button').forEach((b) =>
      b.addEventListener('click', () => {
        this.settings.intensity = Number(b.dataset.value);
        setSegmented($('#set-intensity'), this.settings.intensity);
        saveSettings(this.settings);
        this.rechoreograph();
      }),
    );
    $$('#set-quality button').forEach((b) =>
      b.addEventListener('click', () => {
        this.settings.quality = b.dataset.value;
        setSegmented($('#set-quality'), this.settings.quality);
        saveSettings(this.settings);
        const q = this.settings.quality === 'auto' ? pickInitialQuality() : this.settings.quality;
        this.perf.locked = false;
        this.perf.slowFor = 0;
        this.applyQuality(q);
      }),
    );
    const bindSwitch = (id, key, apply) => {
      const el = $(id);
      el.addEventListener('click', () => {
        this.settings[key] = !this.settings[key];
        setSwitch(el, this.settings[key]);
        saveSettings(this.settings);
        apply(this.settings[key]);
      });
    };
    bindSwitch('#set-crowd', 'crowd', (on) => this.engine.setCrowd(on && (this.view === 'show' || this.view === 'end')));
    bindSwitch('#set-motion', 'motion', (on) => (this.engine.motion = on));
    bindSwitch('#set-calm', 'reduceFlashing', (on) => {
      this.engine.setReducedFlashing(on);
      this.runner.reduceFlashing = on;
      if (this.view === 'show') this.runner.reset(this.currentShowTime());
    });
    bindSwitch('#set-sfx', 'sfx', (on) => {
      this.player.ensureContext();
      this.sfx.setEnabled(on);
    });
    $('#set-captions').addEventListener('click', () => this.setCaptions(!this.settings.captions));
    bindSwitch('#set-online', 'lyricsOnline', () => {});
    $('#set-load-lrc').addEventListener('click', () => lrcInput.click());
    const off = $('#set-offset');
    off.addEventListener('input', () => {
      this.settings.offsetMs = Number(off.value);
      this.updateOffsetUI();
      saveSettings(this.settings);
    });
    document.addEventListener('pointerdown', (e) => {
      const panel = $('#settings');
      if (!panel.classList.contains('closed') && !panel.contains(e.target) && !$('#btn-settings').contains(e.target)) this.closeSettings();
    });

    // End card
    $('#end-replay').addEventListener('click', () => this.replay());
    $('#end-new').addEventListener('click', () => this.goHome());

    // Drag & drop anywhere
    let depth = 0;
    const overlay = $('#drop-overlay');
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      overlay.classList.add('show');
      dz.classList.add('drag');
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) {
        overlay.classList.remove('show');
        dz.classList.remove('drag');
      }
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      dz.classList.remove('drag');
      const files = Array.from(e.dataTransfer.files || []);
      const lrc = files.find((f) => /\.lrc$/i.test(f.name));
      const audio = files.find((f) => this.isAudioFile(f));
      if (audio) this.handleFile(audio, { lrcFile: lrc });
      else if (lrc && this.prepared) this.loadLyricsFile(lrc);
      else if (lrc) toast('Drop the song first — or drop the song and its .lrc together.');
      else if (files.length) toast('That file does not look like audio. Try an MP3, WAV, FLAC, OGG or M4A.', { type: 'error' });
    });

    // Keyboard
    window.addEventListener('keydown', (e) => this.onKey(e));

    // Auto-hide controls during the show
    const poke = () => this.pokeUI();
    window.addEventListener('pointermove', poke, { passive: true });
    window.addEventListener('pointerdown', poke, { passive: true });
    window.addEventListener('touchstart', poke, { passive: true });
    $('#controls').addEventListener('pointerenter', () => (this.overControls = true));
    $('#controls').addEventListener('pointerleave', () => (this.overControls = false));
  }

  applySettingsToUI() {
    setSegmented($('#set-intensity'), this.settings.intensity);
    setSegmented($('#set-quality'), this.settings.quality);
    setSwitch($('#set-crowd'), this.settings.crowd);
    setSwitch($('#set-motion'), this.settings.motion);
    setSwitch($('#set-calm'), this.settings.reduceFlashing);
    setSwitch($('#set-sfx'), this.settings.sfx);
    setSwitch($('#set-captions'), this.settings.captions);
    setSwitch($('#set-online'), this.settings.lyricsOnline);
    $('#btn-captions').setAttribute('aria-pressed', String(this.settings.captions));
    $('#set-offset').value = String(this.settings.offsetMs);
    $('#volume').value = String(this.settings.volume);
    this.updateOffsetUI();
    this.updateVolumeUI();
  }

  updateOffsetUI() {
    const v = this.settings.offsetMs;
    $('#set-offset-out').textContent = `${v > 0 ? '+' : ''}${v} ms`;
    const off = $('#set-offset');
    off.style.setProperty('--fill', `${((v + 300) / 600) * 100}%`);
  }

  updateVolumeUI() {
    const v = this.settings.muted ? 0 : this.settings.volume;
    $('#btn-mute').innerHTML = v === 0 ? ICONS.mute : v < 0.5 ? ICONS.volumeLow : ICONS.volume;
    $('#btn-mute').setAttribute('aria-label', this.settings.muted ? 'Unmute' : 'Mute');
    $('#volume').style.setProperty('--fill', `${v * 100}%`);
    $('#volume').value = String(this.settings.muted ? 0 : this.settings.volume);
  }

  setCaptions(on) {
    this.settings.captions = on;
    saveSettings(this.settings);
    setSwitch($('#set-captions'), on);
    $('#btn-captions').setAttribute('aria-pressed', String(on));
    this.lyricsView.setEnabled(on);
  }

  toggleMute() {
    this.settings.muted = !this.settings.muted;
    this.player.setMuted(this.settings.muted);
    this.updateVolumeUI();
    saveSettings(this.settings);
  }

  toggleSettings() {
    const panel = $('#settings');
    const open = panel.classList.contains('closed');
    panel.classList.toggle('closed', !open);
    $('#btn-settings').setAttribute('aria-expanded', String(open));
    if (open) this.pokeUI();
  }

  closeSettings() {
    $('#settings').classList.add('closed');
    $('#btn-settings').setAttribute('aria-expanded', 'false');
  }

  toggleFullscreen() {
    const d = document;
    const el = d.documentElement;
    const fs = d.fullscreenElement || d.webkitFullscreenElement;
    try {
      if (fs) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    } catch {
      toast('Fullscreen is not available here.');
    }
  }

  updateFullscreenUI() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    $('#btn-fullscreen').innerHTML = fs ? ICONS.fullscreenExit : ICONS.fullscreen;
    $('#btn-fullscreen').setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Fullscreen');
  }

  pokeUI() {
    if (this.view !== 'show') return;
    if (!this.pinnedHidden) document.body.classList.remove('ui-hidden');
    document.body.classList.remove('cursor-hidden');
    clearTimeout(this.uiTimer);
    this.uiTimer = setTimeout(() => {
      const settingsOpen = !$('#settings').classList.contains('closed');
      if (this.view === 'show' && this.player.playing && !settingsOpen && !this.overControls) {
        document.body.classList.add('ui-hidden', 'cursor-hidden');
      }
    }, 2800);
  }

  onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if ($('#dlg-how').open) return;
    const k = e.key;
    if (this.view === 'home' && (k === 'Enter' || k === ' ') && e.target === document.body) {
      e.preventDefault();
      $('#file-input').click();
      return;
    }
    if (this.view === 'analysis' && k === 'Enter' && !$('#an-start').disabled) {
      e.preventDefault();
      this.startShow();
      return;
    }
    if (this.view !== 'show' && this.view !== 'end') return;
    const handled = () => {
      e.preventDefault();
      this.pokeUI();
    };
    switch (k) {
      case ' ':
      case 'k':
      case 'K':
        if (e.target && e.target.closest && e.target.closest('button') && k === ' ') return; // let the focused button handle it
        this.togglePlay();
        return handled();
      case 'ArrowRight':
        this.seek(this.player.position() + 5, true);
        return handled();
      case 'ArrowLeft':
        this.seek(this.player.position() - 5, true);
        return handled();
      case 'l':
      case 'L':
        this.seek(this.player.position() + 10, true);
        return handled();
      case 'j':
      case 'J':
        this.seek(this.player.position() - 10, true);
        return handled();
      case 'ArrowUp':
        this.settings.volume = Math.min(1, this.settings.volume + 0.05);
        this.player.setVolume(this.settings.volume);
        this.updateVolumeUI();
        saveSettings(this.settings);
        return handled();
      case 'ArrowDown':
        this.settings.volume = Math.max(0, this.settings.volume - 0.05);
        this.player.setVolume(this.settings.volume);
        this.updateVolumeUI();
        saveSettings(this.settings);
        return handled();
      case 'm':
      case 'M':
        this.toggleMute();
        return handled();
      case 'f':
      case 'F':
        this.toggleFullscreen();
        return handled();
      case 'c':
      case 'C':
        this.setCaptions(!this.settings.captions);
        return handled();
      case 'h':
      case 'H':
        this.pinnedHidden = !this.pinnedHidden;
        document.body.classList.toggle('ui-hidden', this.pinnedHidden);
        e.preventDefault();
        return;
      case 'Home':
        this.seek(0, true);
        return handled();
      case 'Escape':
        if (!$('#settings').classList.contains('closed')) {
          this.closeSettings();
          return handled();
        }
        return;
      default:
    }
  }

  // ---- Loading & analysis --------------------------------------------------------------------

  isAudioFile(f) {
    return (f.type && (f.type.startsWith('audio/') || f.type === 'video/mp4' || f.type === 'video/webm')) || AUDIO_EXT.test(f.name || '');
  }

  async playDemo() {
    try {
      this.player.ensureContext();
    } catch (err) {
      toast(err.message, { type: 'error' });
      return;
    }
    const btn = $('#btn-demo');
    btn.disabled = true;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}demo/skyline.mp3`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], 'Pyrosonic - Skyline.mp3', { type: 'audio/mpeg' });
      await this.handleFile(file, { demo: true });
    } catch (err) {
      console.error(err);
      toast('The demo track could not be loaded. Please check your connection and try again.', { type: 'error' });
    } finally {
      btn.disabled = false;
    }
  }

  async handleFile(file, { demo = false, lrcFile = null } = {}) {
    if (!this.isAudioFile(file)) {
      toast('That file does not look like audio. Try an MP3, WAV, FLAC, OGG or M4A.', { type: 'error' });
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast('That file is larger than 400 MB — please choose a shorter or compressed track.', { type: 'error' });
      return;
    }
    if (file.size < 1024) {
      toast('That file is empty or too small to be a song.', { type: 'error' });
      return;
    }
    try {
      this.player.ensureContext();
    } catch (err) {
      toast(err.message, { type: 'error' });
      return;
    }
    // Stop anything that's playing and hand the sky back to the ambient show.
    this.player.pause();
    this.sfx.stopAll();
    this.cancelAnalysis();
    this.tail = false;
    this.lyricsView.clear();
    clearTimeout(this.titleTimer);
    $('#titlecard').classList.add('gone');
    if (this.view === 'show' || this.view === 'end') {
      this.runner.clear();
      this.ambient.reset(performance.now() / 1000 - this.ambientT0);
    }
    this.releaseWakeLock();
    const job = ++this.jobId;
    this.prepared = null;
    this.resetAnalysisUI(file);
    this.setView('analysis');
    this.ambient.calm = true;

    const metaPromise = demo
      ? Promise.resolve({ title: 'Skyline', artist: 'Pyrosonic demo', album: '', cover: null, lyrics: null, fromTags: true })
      : readMetadata(file);

    // 1. Decode
    this.setStep('decode', 'active');
    this.setProgress(0.03);
    let buffer;
    try {
      const ab = await file.arrayBuffer();
      if (job !== this.jobId) return;
      buffer = await this.player.decode(ab);
    } catch (err) {
      if (job !== this.jobId) return;
      console.error(err);
      toast("This file couldn't be decoded by your browser. Try MP3, WAV or M4A.", { type: 'error' });
      this.goHome();
      return;
    }
    if (job !== this.jobId) return;
    if (buffer.duration < 4) {
      toast('That clip is too short for a show — try something at least a few seconds long.', { type: 'error' });
      this.goHome();
      return;
    }
    if (buffer.duration > MAX_DURATION) {
      toast('That track is over 30 minutes — please choose something shorter.', { type: 'error' });
      this.goHome();
      return;
    }
    this.setStep('decode', 'done', `${formatTime(buffer.duration)} · ${(buffer.sampleRate / 1000).toFixed(1)} kHz`);
    $('#an-duration').textContent = formatTime(buffer.duration);
    this.drawAnalysisWave(buffer);
    this.setProgress(0.1);

    const meta = await metaPromise;
    if (job !== this.jobId) return;
    this.applyMeta(meta);

    // 2. Lyrics lookup runs alongside the analysis.
    const lyricsPromise = this.resolveLyrics(meta, buffer.duration, { demo, lrcFile });

    // 3. Analysis (worker)
    this.setStep('rhythm', 'active');
    let analysis;
    try {
      analysis = await this.runAnalysis(buffer, job, (stage, p) => {
        if (job !== this.jobId) return;
        const step = STEP_FOR_STAGE[stage] || 'rhythm';
        const order = ['rhythm', 'harmony', 'structure'];
        for (const s of order) {
          if (order.indexOf(s) < order.indexOf(step)) this.setStep(s, 'done');
        }
        this.setStep(step, 'active');
        const r = STAGE_RANGE[stage] || [0.1, 0.9];
        this.setProgress(r[0] + (r[1] - r[0]) * p);
      });
    } catch (err) {
      if (job !== this.jobId) return;
      console.error(err);
      toast('Something went wrong while analysing this track. Please try another file.', { type: 'error' });
      this.goHome();
      return;
    }
    if (job !== this.jobId) return;
    this.setStep('rhythm', 'done', `${Math.round(analysis.tempo.bpm)} BPM`);
    this.setStep('harmony', 'done', analysis.key.name);
    this.setStep('structure', 'done', `${analysis.sections.length} sections`);
    this.addFact(`<b>${Math.round(analysis.tempo.bpm)}</b> BPM`);
    this.addFact(`Key <b>${escapeHtml(analysis.key.name)}</b>`);
    this.addFact(`<b>${analysis.sections.length}</b> sections`);
    if (analysis.drops.length) this.addFact(`<b>${analysis.drops.length}</b> drop${analysis.drops.length > 1 ? 's' : ''}`);

    // 4. Lyrics
    this.setStep('lyrics', 'active');
    this.setProgress(0.92);
    const ly = await lyricsPromise;
    if (job !== this.jobId) return;
    this.setStep('lyrics', ly.lyrics && ly.lyrics.synced ? 'done' : 'skipped', ly.note);
    if (ly.lyrics && ly.lyrics.synced) this.addFact(`Lyrics <b>${ly.lyrics.wordSynced ? 'word-synced' : 'synced'}</b>`);

    // 5. Choreography
    this.setStep('design', 'active');
    this.setProgress(0.96);
    await new Promise((r) => setTimeout(r, 30));
    const seed = hashString(`${file.name}|${buffer.duration.toFixed(2)}`);
    const prepared = { file, buffer, analysis, meta, lyrics: ly.lyrics, lyricsNote: ly.note, seed, demo };
    this.prepared = prepared;
    this.buildShow();
    if (job !== this.jobId) return;
    this.setStep('design', 'done', `${prepared.show.stats.aerial} shells`);
    this.setProgress(1);
    this.colorAnalysisWave();
    this.player.setBuffer(buffer);
    const start = $('#an-start');
    start.disabled = false;
    start.focus({ preventScroll: true });
    this.updateLyricsNote();
  }

  async resolveLyrics(meta, duration, { demo, lrcFile }) {
    if (lrcFile) {
      try {
        const ly = parseLRC(await lrcFile.text(), 'file');
        if (ly.lines.length) return { lyrics: ly, note: 'From your .lrc file' };
      } catch {
        /* fall through */
      }
    }
    if (demo) return { lyrics: null, note: 'Instrumental' };
    if (meta.lyrics && meta.lyrics.synced) return { lyrics: meta.lyrics, note: 'Embedded in file' };
    if (!this.settings.lyricsOnline) return { lyrics: meta.lyrics, note: 'Online lookup off' };
    if (navigator.onLine === false) return { lyrics: meta.lyrics, note: 'Offline' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await findLyrics({ title: meta.title, artist: meta.artist, duration }, { signal: ctrl.signal });
      if (!res) return { lyrics: meta.lyrics, note: 'None found' };
      if (res.instrumental) return { lyrics: null, note: 'Instrumental' };
      const note = res.lyrics.wordSynced ? 'Word-synced · LRCLIB' : res.lyrics.synced ? 'Line-synced · LRCLIB' : 'Unsynced · LRCLIB';
      return { lyrics: res.lyrics.synced ? res.lyrics : meta.lyrics || res.lyrics, note };
    } catch {
      return { lyrics: meta.lyrics, note: 'Unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }

  runAnalysis(buffer, job, onProgress) {
    const copyChannels = () => {
      const out = [];
      for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) out.push(buffer.getChannelData(c).slice());
      return out;
    };
    const mainThread = async () => {
      const { analyzeAudio } = await import('./analysis/analyze.js');
      await new Promise((r) => setTimeout(r, 20));
      return analyzeAudio({ channels: copyChannels(), sampleRate: buffer.sampleRate }, onProgress);
    };
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(new URL('./analysis/worker.js', import.meta.url), { type: 'module' });
      } catch {
        mainThread().then(resolve, reject);
        return;
      }
      this.worker = worker;
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        fn(v);
      };
      worker.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'progress') onProgress(m.stage, m.p);
        else if (m.type === 'done') finish(resolve, m.result);
        else if (m.type === 'error') finish(reject, new Error(m.message));
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        if (settled) return;
        settled = true;
        worker.terminate();
        // Module workers unsupported or failed to load: fall back to the main thread.
        mainThread().then(resolve, reject);
      };
      const channels = copyChannels();
      worker.postMessage({ id: job, channels, sampleRate: buffer.sampleRate }, channels.map((c) => c.buffer));
    });
  }

  cancelAnalysis() {
    this.jobId++;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  buildShow() {
    const p = this.prepared;
    if (!p) return;
    const cues = lyricCues(p.lyrics);
    p.cues = cues;
    p.show = choreograph(p.analysis, { intensity: this.settings.intensity, lyricCues: cues, seed: p.seed });
    p.showEnd = p.show.events.reduce((m, e) => Math.max(m, e.end), p.analysis.duration);
    p.sectionColors = p.analysis.sections.map((s, i) => sectionColor(p.show.palettes[i]));
  }

  /** Rebuild the choreography (intensity or lyrics changed) without interrupting playback. */
  rechoreograph() {
    if (!this.prepared) return;
    this.buildShow();
    if (this.view === 'show' || this.view === 'end') {
      this.runner.load(this.prepared.show.events, this.currentShowTime());
      this.sfx.stopAll();
      this.setupShowUI();
    }
  }

  async loadLyricsFile(file) {
    try {
      const text = await file.text();
      if (!looksLikeLRC(text)) {
        toast('That file has no timestamps. Synced lyrics need the .lrc format, e.g. "[00:12.30] line".', { type: 'error', timeout: 6000 });
        return;
      }
      const ly = parseLRC(text, 'file');
      if (!ly.lines.length) throw new Error('empty');
      if (!this.prepared) {
        toast('Load a song first, then add its lyrics.');
        return;
      }
      this.prepared.lyrics = ly;
      this.prepared.lyricsNote = 'From your .lrc file';
      this.rechoreograph();
      if (this.view === 'analysis') {
        this.setStep('lyrics', 'done', 'From your .lrc file');
        if (!$$('#an-facts .chip').some((c) => c.textContent.startsWith('Lyrics'))) this.addFact(`Lyrics <b>${ly.wordSynced ? 'word-synced' : 'synced'}</b>`);
        if (this.prepared.show) this.setStep('design', 'done', `${this.prepared.show.stats.aerial} shells`);
      }
      this.updateLyricsNote();
      toast(`Loaded ${ly.lines.length} lyric lines — the show now reacts to them.`);
    } catch {
      toast("Couldn't read that lyrics file.", { type: 'error' });
    }
  }

  updateLyricsNote() {
    const p = this.prepared;
    const note = $('#set-lyrics-note');
    if (!p || !p.lyrics || !p.lyrics.synced) {
      note.textContent = p && p.lyricsNote ? `No synced lyrics (${p.lyricsNote.toLowerCase()}).` : 'No synced lyrics loaded.';
      return;
    }
    const n = (p.cues || []).filter((c) => c.kind !== 'color').length;
    const cols = (p.cues || []).filter((c) => c.kind === 'color').length;
    note.textContent = `${p.lyrics.lines.length} lines · ${p.lyricsNote}. ${n} lyric effects${cols ? `, ${cols} colour cues` : ''}.`;
  }

  applyMeta(meta) {
    if (this.coverUrl && this.coverUrl !== meta.cover) URL.revokeObjectURL(this.coverUrl);
    this.coverUrl = meta.cover;
    $('#an-title').textContent = meta.title || 'Untitled track';
    $('#an-artist').textContent = meta.artist || meta.album || ' ';
    for (const id of ['#an-cover', '#sm-cover']) {
      const el = $(id);
      if (meta.cover) {
        el.style.backgroundImage = `url("${meta.cover}")`;
        el.classList.remove('generated');
      } else {
        el.style.backgroundImage = '';
        el.classList.add('generated');
      }
    }
  }

  resetAnalysisUI(file) {
    const fb = parseFilename(file.name);
    $('#an-title').textContent = fb.title;
    $('#an-artist').textContent = fb.artist || ' ';
    $('#an-duration').textContent = '';
    $('#an-facts').innerHTML = '';
    $('#an-start').disabled = true;
    for (const li of $$('#an-steps li')) {
      li.classList.remove('active', 'done', 'skipped');
      li.querySelector('.note').textContent = '';
    }
    this.setProgress(0);
    const c = $('#an-wave');
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    this.waveBars = null;
  }

  setStep(name, state, note) {
    const li = $(`#an-steps li[data-step="${name}"]`);
    if (!li) return;
    li.classList.remove('active', 'done', 'skipped');
    li.classList.add(state);
    if (note !== undefined) li.querySelector('.note').textContent = note;
  }

  setProgress(p) {
    const pct = Math.round(Math.min(1, Math.max(0, p)) * 100);
    $('#an-bar').style.width = `${pct}%`;
    $('#an-progress').setAttribute('aria-valuenow', String(pct));
  }

  addFact(html) {
    const el = document.createElement('span');
    el.className = 'chip';
    el.innerHTML = `<i></i>${html}`;
    $('#an-facts').appendChild(el);
  }

  drawAnalysisWave(buffer) {
    const n = 160;
    const ch = buffer.getChannelData(0);
    const ch2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const bars = new Float32Array(n);
    const per = ch.length / n;
    let max = 1e-6;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * per);
      const b = Math.floor((i + 1) * per);
      const step = Math.max(1, Math.floor((b - a) / 800));
      let s = 0, c = 0;
      for (let k = a; k < b; k += step) {
        const v = ch2 ? 0.5 * (ch[k] + ch2[k]) : ch[k];
        s += v * v;
        c++;
      }
      bars[i] = Math.sqrt(s / Math.max(1, c));
      max = Math.max(max, bars[i]);
    }
    for (let i = 0; i < n; i++) bars[i] /= max;
    this.waveBars = bars;
    this.paintAnalysisWave(null);
  }

  colorAnalysisWave() {
    const p = this.prepared;
    if (!p) return;
    this.paintAnalysisWave((t) => {
      const i = p.analysis.sections.findIndex((s) => t >= s.start && t < s.end);
      return i >= 0 ? p.sectionColors[i] : '#ffffff';
    });
  }

  paintAnalysisWave(colorAt) {
    const bars = this.waveBars;
    if (!bars) return;
    const c = $('#an-wave');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || 500;
    const h = c.clientHeight || 64;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const n = bars.length;
    const bw = w / n;
    const dur = this.prepared ? this.prepared.analysis.duration : 1;
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#ffd27a');
    grad.addColorStop(0.35, '#ff8a4c');
    grad.addColorStop(0.65, '#ff4f9a');
    grad.addColorStop(1, '#8b5cff');
    for (let i = 0; i < n; i++) {
      const bh = Math.max(2, Math.pow(bars[i], 0.8) * (h - 6));
      g.fillStyle = colorAt ? colorAt(((i + 0.5) / n) * dur) : grad;
      g.globalAlpha = colorAt ? 0.9 : 0.85;
      const x = i * bw + bw * 0.2;
      const y = (h - bh) / 2;
      const r = Math.min(1.5, bw * 0.3);
      g.beginPath();
      g.roundRect ? g.roundRect(x, y, bw * 0.6, bh, r) : g.rect(x, y, bw * 0.6, bh);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // ---- Show ------------------------------------------------------------------------------------

  setupShowUI() {
    const p = this.prepared;
    const A = p.analysis;
    $('#sm-title').textContent = p.meta.title || 'Untitled track';
    $('#sm-artist').textContent = p.meta.artist || '';
    $('#hud-bpm').textContent = String(Math.round(A.tempo.bpm));
    $('#hud-key').textContent = A.key.name;
    this.timeline.setData({
      duration: A.duration,
      sections: A.sections.map((s, i) => ({ start: s.start, end: s.end, level: s.level, label: s.label, color: p.sectionColors[i] })),
      waveform: A.waveform,
      drops: A.drops.map((d) => d.t),
    });
    this.lyricsView.set(p.lyrics, p.cues || []);
    this.lyricsView.setEnabled(this.settings.captions);
    this.sectionIdx = -1;
    this.updateLyricsNote();
  }

  startShow() {
    const p = this.prepared;
    if (!p || !p.show) return;
    if (this.engine.contextLost) {
      toast('Waiting for the graphics to recover…');
      return;
    }
    try {
      this.player.ensureContext();
    } catch (err) {
      toast(err.message, { type: 'error' });
      return;
    }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    this.setView('show');
    this.setupShowUI();
    this.beginPlayback();
    this.requestWakeLock();
    this.setupMediaSession();
  }

  beginPlayback() {
    const p = this.prepared;
    this.tail = false;
    this.sfx.stopAll();
    this.sfx.setEnabled(this.settings.sfx);
    this.runner.load(p.show.events, -PREROLL);
    this.player.setBuffer(p.buffer);
    this.player.play(0, PREROLL);
    this.clock = { valid: false, visual: -PREROLL };
    this.beatIdx = 0;
    this.updatePlayButton();
    // Title card during the pre-roll.
    const tc = $('#titlecard');
    $('#tc-title').textContent = p.meta.title || 'Untitled track';
    $('#tc-artist').textContent = p.meta.artist || '';
    tc.classList.remove('gone');
    clearTimeout(this.titleTimer);
    this.titleTimer = setTimeout(() => tc.classList.add('gone'), (PREROLL + 1.4) * 1000);
    this.pokeUI();
  }

  replay() {
    if (!this.prepared) return;
    if (this.view !== 'show') this.setView('show');
    this.setupShowUI();
    this.beginPlayback();
  }

  togglePlay() {
    if (!this.prepared) return;
    if (this.engine.contextLost && !this.player.playing) {
      toast('Waiting for the graphics to recover…');
      return;
    }
    if (this.view === 'end') return this.replay();
    if (this.player.playing) {
      this.player.pause();
      this.sfx.stopAll();
    } else {
      if (this.tail || this.player.offset >= this.player.duration - 0.05) {
        this.replay();
        return;
      }
      this.player.play(this.player.offset, 0);
      this.clock.valid = false;
    }
    this.updatePlayButton();
    this.pokeUI();
  }

  updatePlayButton() {
    const playing = this.player.playing;
    const b = $('#btn-play');
    b.innerHTML = playing ? ICONS.pause : ICONS.play;
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    b.dataset.tip = playing ? 'Pause (Space)' : 'Play (Space)';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  seek(t, commit = true) {
    if (!this.prepared || (this.view !== 'show' && this.view !== 'end')) return;
    const d = this.player.duration;
    const target = Math.min(Math.max(0, t), Math.max(0, d - 0.05));
    if (this.view === 'end') this.setView('show');
    this.tail = false;
    this.sfx.stopAll();
    const now = performance.now();
    if (commit || !this.player.playing || now - (this.lastSeekAt || 0) > 120) {
      this.player.seek(target);
      this.lastSeekAt = now;
    }
    this.clock.valid = false;
    $('#titlecard').classList.add('gone');
    this.timeline.setProgress(target);
    this.updatePlayButton();
  }

  onAudioEnded() {
    this.tail = true;
    this.updatePlayButton();
  }

  finishShow() {
    const p = this.prepared;
    this.tail = false;
    this.player.pause();
    this.player.offset = this.player.duration;
    this.sfx.stopAll();
    this.updatePlayButton();
    $('#end-sub').textContent = `${p.meta.title || 'Your track'}${p.meta.artist ? ` — ${p.meta.artist}` : ''}`;
    const s = p.show.stats;
    const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
    $('#end-stats').innerHTML =
      stat(s.aerial.toLocaleString(), 'shells fired') +
      stat(Math.round(p.analysis.tempo.bpm), 'BPM') +
      stat(p.analysis.sections.length, 'sections') +
      stat(s.peakPerSec, 'peak per second');
    this.setView('end');
    this.releaseWakeLock();
  }

  goHome() {
    this.cancelAnalysis();
    this.player.pause();
    this.sfx.stopAll();
    this.tail = false;
    this.lyricsView.clear();
    clearTimeout(this.titleTimer);
    $('#titlecard').classList.add('gone');
    this.runner.clear();
    this.ambient.calm = false;
    this.ambient.reset(performance.now() / 1000 - this.ambientT0);
    this.setView('home');
    this.releaseWakeLock();
  }

  onBurst(ev) {
    if (ev.type === 'salute' || (ev.layer === 'accent' && ev.type !== 'mine' && ev.x === 0)) this.engine.shake(ev.type === 'salute' ? 0.9 : 0.4);
  }

  // ---- GPU resets ------------------------------------------------------------------------------

  /**
   * The browser took our WebGL context away (a GPU driver reset or a crashed
   * GPU process). Pause the music so the show doesn't carry on without its
   * fireworks, and pick up again by itself if the browser restores the context.
   */
  onGraphicsLost() {
    if (this.player.playing) {
      this.gfxResume = this.view === 'show';
      this.player.pause();
      this.sfx.stopAll();
      this.updatePlayButton();
    }
    toast('The graphics driver reset — the show is paused until it recovers.', { type: 'error', timeout: 6000 });
    clearTimeout(this.gfxTimer);
    this.gfxTimer = setTimeout(() => this.showGraphicsBlocked(), 5000);
  }

  onGraphicsRestored() {
    clearTimeout(this.gfxTimer);
    document.querySelector('.fatal.gfx')?.remove();
    this.runner.reset(this.currentShowTime());
    this.timeline.draw();
    if (this.gfxResume && this.view === 'show' && this.prepared && !this.player.playing) {
      this.player.play(this.player.offset, 0);
      this.clock.valid = false;
      this.updatePlayButton();
      toast('Graphics recovered — resuming the show.');
    } else {
      toast('Graphics recovered.');
    }
    this.gfxResume = false;
  }

  /** Still no context after a few seconds: the browser has blocked WebGL for this page until it reloads. */
  showGraphicsBlocked() {
    if (!this.engine.contextLost || document.querySelector('.fatal.gfx')) return;
    const el = document.createElement('div');
    el.className = 'fatal gfx';
    el.setAttribute('role', 'alertdialog');
    el.innerHTML = `<div><h2>The fireworks stopped</h2><p>Your browser reset the graphics processor and hasn't handed 3D graphics back to this page. Reloading usually fixes it.</p><div class="actions"><button class="btn primary" id="gfx-reload">Reload page</button></div></div>`;
    document.body.appendChild(el);
    const btn = el.querySelector('#gfx-reload');
    btn.addEventListener('click', () => location.reload());
    btn.focus({ preventScroll: true });
  }

  // ---- Clock & frame loop ----------------------------------------------------------------------

  currentShowTime() {
    if (this.view === 'show' || this.view === 'end') return this.clock.visual;
    return performance.now() / 1000 - this.ambientT0;
  }

  advanceClock(dt) {
    const offset = -this.settings.offsetMs / 1000;
    const c = this.clock;
    if (this.player.playing) {
      const target = this.player.position() + offset;
      if (!c.valid || Math.abs(target - c.visual) > 0.2) {
        c.visual = target;
        c.valid = true;
      } else {
        c.visual += dt;
        c.visual += (target - c.visual) * Math.min(1, dt * 5);
      }
    } else if (this.tail) {
      c.visual += dt;
    } else {
      c.visual = this.player.position() + offset;
      c.valid = false;
    }
    return c.visual;
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const real = now / 1000;
    let t;
    let flashes;
    if (this.view === 'show' || this.view === 'end') {
      t = this.advanceClock(dt);
      flashes = this.runner.update(t);
      if (this.player.playing) this.sfx.schedule(this.runner, t + this.settings.offsetMs / 1000);
      this.updateShowUI(t);
      if (this.tail && this.prepared && t > this.prepared.showEnd + 0.4 && this.view === 'show') this.finishShow();
    } else {
      t = real - this.ambientT0;
      this.ambient.update(t);
      flashes = this.runner.update(t);
    }
    this.engine.render(t, real, flashes, dt);
    this.adaptQuality(dt);
  }

  updateShowUI(t) {
    const p = this.prepared;
    if (!p) return;
    const A = p.analysis;
    const songT = Math.min(Math.max(0, t), A.duration);
    const text = `${formatTime(songT)} / ${formatTime(A.duration)}`;
    if (text !== this.lastTimeText) {
      this.lastTimeText = text;
      $('#time').innerHTML = `<b>${formatTime(songT)}</b> / ${formatTime(A.duration)}`;
      if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && A.duration > 0) {
        try {
          navigator.mediaSession.setPositionState({ duration: A.duration, position: songT, playbackRate: 1 });
        } catch {
          /* ignore */
        }
      }
    }
    if (!this.timeline.dragging) this.timeline.setProgress(songT);

    // Section chip
    let si = A.sections.findIndex((s) => songT >= s.start && songT < s.end);
    if (si < 0) si = A.sections.length - 1;
    if (si !== this.sectionIdx) {
      this.sectionIdx = si;
      const s = A.sections[si];
      $('#section-name').textContent = s ? s.label : '—';
      $('#section-sw').style.background = p.sectionColors[si] || '#fff';
      $('#section-sw').style.boxShadow = `0 0 10px ${p.sectionColors[si] || '#fff'}`;
    }

    // Beat pulse
    const beats = A.beats;
    if (this.beatIdx > 0 && beats[this.beatIdx - 1] && beats[this.beatIdx - 1].t > t + 0.05) this.beatIdx = 0;
    let crossed = false;
    while (this.beatIdx < beats.length && beats[this.beatIdx].t <= t) {
      crossed = t - beats[this.beatIdx].t < 0.12;
      this.beatIdx++;
    }
    if (crossed) {
      const dot = $('#beat-dot');
      dot.classList.add('on');
      clearTimeout(this.beatTimer);
      this.beatTimer = setTimeout(() => dot.classList.remove('on'), 90);
    }

    this.lyricsView.update(t);
  }

  adaptQuality(dt) {
    if (this.settings.quality !== 'auto' || this.perf.locked || document.hidden) return;
    if (this.view !== 'show' && this.view !== 'home') return;
    if (dt <= 0 || dt > 0.25) return;
    const pf = this.perf;
    pf.ema += (dt - pf.ema) * 0.05;
    if (pf.ema > 1 / 36) pf.slowFor += dt;
    else pf.slowFor = Math.max(0, pf.slowFor - dt * 0.5);
    if (pf.slowFor > 2.5) {
      const order = ['high', 'medium', 'low'];
      const i = order.indexOf(pf.level);
      if (i >= 0 && i < order.length - 1) {
        this.applyQuality(order[i + 1]);
        if (this.view === 'show') toast(`Switched to ${order[i + 1]} quality for smoother playback.`);
      } else {
        pf.locked = true;
      }
      pf.slowFor = 0;
      pf.ema = 1 / 60;
    }
  }

  applyQuality(level) {
    this.perf.level = level;
    this.engine.setQuality(level);
    this.runner.reset(this.currentShowTime());
  }

  onResize() {
    this.engine.resize();
    if (this.waveBars && this.view === 'analysis') {
      if (this.prepared) this.colorAnalysisWave();
      else this.paintAnalysisWave(null);
    }
  }

  onVisibility() {
    if (!document.hidden && this.view === 'show' && this.player.playing) this.requestWakeLock();
  }

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener?.('release', () => (this.wakeLock = null));
      }
    } catch {
      this.wakeLock = null;
    }
  }

  releaseWakeLock() {
    try {
      this.wakeLock?.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const p = this.prepared;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: p.meta.title || 'Untitled track',
        artist: p.meta.artist || 'Pyrosonic',
        album: p.meta.album || 'Fireworks show',
        artwork: p.meta.cover ? [{ src: p.meta.cover, sizes: '512x512' }] : [],
      });
      const h = (action, fn) => {
        try {
          navigator.mediaSession.setActionHandler(action, fn);
        } catch {
          /* unsupported action */
        }
      };
      h('play', () => !this.player.playing && this.togglePlay());
      h('pause', () => this.player.playing && this.togglePlay());
      h('seekbackward', () => this.seek(this.player.position() - 10, true));
      h('seekforward', () => this.seek(this.player.position() + 10, true));
      h('seekto', (d) => d && Number.isFinite(d.seekTime) && this.seek(d.seekTime, true));
    } catch {
      /* ignore */
    }
  }
}
