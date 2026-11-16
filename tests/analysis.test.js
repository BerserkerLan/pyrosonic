import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FFT, splitRealSpectra } from '../src/analysis/fft.js';
import { analyzeAudio } from '../src/analysis/analyze.js';
import { renderDemo, DEMO_BPM } from '../scripts/demo-synth.js';
import { drumLoop, nearestDistance, rng } from './helpers.js';

test('FFT matches a naive DFT', () => {
  const n = 64;
  const r = rng(1);
  const x = Array.from({ length: n }, () => r() * 2 - 1);
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  new FFT(n).transform(re, im);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      sr += x[t] * Math.cos((-2 * Math.PI * k * t) / n);
      si += x[t] * Math.sin((-2 * Math.PI * k * t) / n);
    }
    assert.ok(Math.abs(sr - re[k]) < 1e-9 && Math.abs(si - im[k]) < 1e-9, `bin ${k}`);
  }
});

test('two real spectra from one complex FFT', () => {
  const n = 32;
  const r = rng(2);
  const a = Array.from({ length: n }, () => r());
  const b = Array.from({ length: n }, () => r());
  const fft = new FFT(n);
  const re = Float64Array.from(a), im = Float64Array.from(b);
  fft.transform(re, im);
  const ma = new Float64Array(n / 2 + 1), mb = new Float64Array(n / 2 + 1);
  splitRealSpectra(re, im, ma, mb, 1);
  const mag = (x) => {
    const r2 = Float64Array.from(x), i2 = new Float64Array(n);
    fft.transform(r2, i2);
    return Array.from({ length: n / 2 + 1 }, (_, k) => Math.hypot(r2[k], i2[k]));
  };
  const ea = mag(a), eb = mag(b);
  for (let k = 0; k <= n / 2; k++) {
    assert.ok(Math.abs(ea[k] - ma[k]) < 1e-9);
    assert.ok(Math.abs(eb[k] - mb[k]) < 1e-9);
  }
});

for (const sr of [44100, 48000]) {
  for (const bpm of [92, 120, 128, 140]) {
    test(`tempo and beat timing at ${bpm} BPM, ${sr} Hz`, () => {
      const sig = drumLoop({ sr, bpm, seconds: 30 });
      const a = analyzeAudio(sig);
      assert.ok(Math.abs(a.tempo.bpm - bpm) / bpm < 0.01, `tempo ${a.tempo.bpm}`);
      const inner = a.beats.filter((b) => b.t > 1 && b.t < 28);
      const errs = inner.map((b) => nearestDistance(sig.onsets, b.t));
      const mean = errs.reduce((x, y) => x + y, 0) / errs.length;
      assert.ok(errs.every((e) => e < 0.03), `max beat error ${Math.max(...errs)}`);
      assert.ok(mean < 0.012, `mean beat error ${mean}`);
      // Kick onsets land on the beat too.
      const kicks = a.onsets.kick.filter((k) => k.t > 1 && k.t < 28 && k.s > 0.4);
      assert.ok(kicks.length > inner.length * 0.7, 'most kicks detected');
      assert.ok(kicks.every((k) => nearestDistance(sig.onsets, k.t) < 0.03), 'kicks on the beat');
    });
  }
}

test('demo track: tempo, drops, builds and sections', () => {
  const demo = renderDemo({ sampleRate: 44100 });
  const a = analyzeAudio({ channels: demo.channels, sampleRate: demo.sampleRate });
  assert.ok(Math.abs(a.tempo.bpm - DEMO_BPM) < 0.5, `tempo ${a.tempo.bpm}`);
  // Bars line up with the real bar grid.
  const bar = demo.meta.bar;
  const downbeats = a.beats.filter((b) => b.beatInBar === 0).map((b) => b.t);
  const phaseErr = downbeats.map((t) => Math.abs(((t / bar + 0.5) % 1) - 0.5) * bar);
  assert.ok(phaseErr.filter((e) => e < 0.05).length / phaseErr.length > 0.9, 'downbeats on bar lines');
  // Both real drops (after silence gaps) are found.
  for (const d of demo.meta.drops) {
    const hit = a.drops.find((x) => Math.abs(x.t - d) < 0.1);
    assert.ok(hit, `drop at ${d.toFixed(2)} detected`);
    assert.ok(hit.silenceGap, `pre-drop silence at ${d.toFixed(2)}`);
    assert.ok(a.builds.some((b) => Math.abs(b.end - d) < 0.1 && b.end - b.start > 4), `build into ${d.toFixed(2)}`);
  }
  const labels = a.sections.map((s) => s.label);
  assert.equal(labels[0], 'Intro');
  assert.equal(labels[labels.length - 1], 'Outro');
  assert.ok(labels.includes('Drop') && labels.includes('Final Drop'), labels.join(','));
  assert.ok(a.sections.some((s) => s.climax && s.start > 85 && s.start < 95), 'climax is the final drop');
  // Sections tile the whole track.
  assert.equal(a.sections[0].start, 0);
  assert.ok(Math.abs(a.sections[a.sections.length - 1].end - a.duration) < 1e-6);
  for (let i = 1; i < a.sections.length; i++) assert.ok(Math.abs(a.sections[i].start - a.sections[i - 1].end) < 1e-6);
});

test('edge cases do not throw and stay sane', () => {
  const sr = 44100;
  const n = sr * 8;
  const r = rng(9);
  const cases = {
    silence: [new Float32Array(n)],
    noise: [Float32Array.from({ length: n }, () => (r() * 2 - 1) * 0.3)],
    tone: [Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / sr) * 0.5)],
    short: [Float32Array.from({ length: sr * 2 }, (_, i) => Math.sin((2 * Math.PI * 220 * i) / sr) * 0.5)],
  };
  for (const [name, channels] of Object.entries(cases)) {
    const a = analyzeAudio({ channels, sampleRate: sr });
    assert.ok(Number.isFinite(a.tempo.bpm) && a.tempo.bpm > 0, `${name} bpm`);
    assert.ok(a.sections.length >= 1, `${name} sections`);
    for (const k of Object.keys(a.env)) {
      if (k === 'rate') continue;
      assert.ok(a.env[k].every(Number.isFinite), `${name} env.${k} finite`);
    }
  }
  assert.equal(analyzeAudio({ channels: cases.silence, sampleRate: sr }).silent, true);
});
