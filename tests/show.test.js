import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio } from '../src/analysis/analyze.js';
import { choreograph } from '../src/show/choreographer.js';
import { buildEvent, createBuildTarget, resetBuildTarget, STRIDE, TYPE_INFO, flightTime, eventTiming, posAt, solveVelocity } from '../src/show/shells.js';
import { renderDemo } from '../scripts/demo-synth.js';
import { rng } from './helpers.js';

let analysis;
before(() => {
  const demo = renderDemo({ sampleRate: 44100 });
  analysis = analyzeAudio({ channels: demo.channels, sampleRate: demo.sampleRate });
});

test('choreography is deterministic for a given seed', () => {
  const a = choreograph(analysis, { seed: 42 });
  const b = choreograph(analysis, { seed: 42 });
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
  const c = choreograph(analysis, { seed: 43 });
  assert.notEqual(JSON.stringify(a.events), JSON.stringify(c.events));
});

test('events are well-formed, sorted and inside the song', () => {
  for (const intensity of [0.7, 1, 1.4]) {
    const { events, stats } = choreograph(analysis, { seed: 7, intensity });
    assert.ok(events.length > 200, `${intensity}: ${events.length} events`);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      assert.ok(TYPE_INFO[e.type], `known type ${e.type}`);
      for (const k of ['t', 'x', 'y', 'z', 'size', 'launch', 'end', 'intensity']) assert.ok(Number.isFinite(e[k]), `${e.type}.${k}`);
      assert.ok(e.t >= 0 && e.t <= analysis.duration + 0.5);
      assert.ok(Math.abs(e.x) <= 1.0001 && e.y >= 0 && e.y <= 1.0001);
      assert.ok(Array.isArray(e.colors) && e.colors.length > 0);
      if (i) assert.ok(events[i - 1].launch <= e.launch, 'sorted by launch');
      const timing = eventTiming(e);
      assert.ok(Math.abs(timing.launch - e.launch) < 1e-9 && Math.abs(timing.end - e.end) < 1e-9);
    }
    assert.ok(stats.peakPerSec < 45, `peak ${stats.peakPerSec}/s`);
  }
});

test('aerial shells are timed to burst on the beat', () => {
  const { events } = choreograph(analysis, { seed: 7 });
  const beats = analysis.beats.map((b) => b.t);
  const near = (t) => beats.reduce((m, b) => Math.min(m, Math.abs(b - t)), Infinity);
  for (const layer of ['structure', 'beat', 'snare', 'accent']) {
    const evs = events.filter((e) => e.layer === layer);
    assert.ok(evs.length > 0, layer);
    const onBeat = evs.filter((e) => near(e.t) < 0.03).length / evs.length;
    assert.ok(onBeat > 0.9, `${layer}: ${(onBeat * 100).toFixed(0)}% on the beat`);
  }
  // Launch is back-computed from flight time.
  for (const e of events.filter((x) => TYPE_INFO[x.type].kind === 'aerial')) {
    assert.ok(Math.abs(e.t - flightTime(e.y) - e.launch) < 1e-9);
  }
});

test('drops get a salvo and the silence before them stays dark', () => {
  const { events, blackouts } = choreograph(analysis, { seed: 7 });
  const gapDrops = analysis.drops.filter((d) => d.silenceGap);
  assert.ok(gapDrops.length >= 2);
  assert.ok(blackouts.length >= 2);
  for (const d of gapDrops) {
    const salvo = events.filter((e) => Math.abs(e.t - d.t) < 0.02 && e.layer === 'accent');
    assert.ok(salvo.some((e) => e.type === 'salute'), 'salute on the drop');
    assert.ok(salvo.filter((e) => e.type === 'mine').length >= 4, 'mines on the drop');
  }
  for (const b of blackouts) {
    const inside = events.filter((e) => e.t > b.start && e.t < b.end && e.layer !== 'accent' && e.layer !== 'finale');
    assert.equal(inside.length, 0, `nothing bursts in the blackout ${b.start.toFixed(2)}–${b.end.toFixed(2)}`);
  }
});

test('every effect type builds finite particles', () => {
  const r = rng(5);
  const out = createBuildTarget();
  for (const type of Object.keys(TYPE_INFO)) {
    for (const variant of ['', 'pistil', 'double', 'saturn', 'tipped', 'pop']) {
      for (const calm of [false, true]) {
        resetBuildTarget(out);
        const ev = { t: 10, type, variant, x: r() * 2 - 1, y: r(), z: r() * 2 - 1, size: r(), colors: ['red', 'gold', 'white'], seed: 1 + Math.floor(r() * 1e6), dur: 2 };
        buildEvent(ev, { quality: 1, reduceFlashing: calm, stage: { halfWidth: 165, scale: 1 } }, out);
        const total = out.trails.count + out.sparks.count;
        assert.ok(total > 0 || type === 'fountain', `${type} produced particles`);
        const { launch, end } = eventTiming(ev);
        for (const w of [out.trails, out.sparks]) {
          const d = w.view();
          for (let i = 0; i < d.length; i++) assert.ok(Number.isFinite(d[i]), `${type}/${variant} field ${i % STRIDE}`);
          for (let p = 0; p < w.count; p++) {
            const birth = d[p * STRIDE + 3];
            const life = d[p * STRIDE + 7];
            assert.ok(life > 0 && birth >= launch - 1e-3 && birth + life <= end + 1e-3, `${type} lifetime inside event window`);
            assert.ok(d[p * STRIDE + 16] >= 0.05, 'drag floor');
          }
        }
        for (const f of out.flashes) assert.ok(Number.isFinite(f.strength) && f.strength > 0);
      }
    }
  }
});

test('rocket solver lands exactly on the burst point', () => {
  const from = [10, 0.8, -244];
  const to = [-40, 90, -262];
  const v = solveVelocity(from, to, 2.1, 0.35, 1.8, [0, 0, 0]);
  const p = posAt(from[0], from[1], from[2], v[0], v[1], v[2], 0.35, 1.8, 2.1, [0, 0, 0]);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(p[i] - to[i]) < 1e-6);
});

test('lyric cues become themed shells', () => {
  const cues = [
    { t: 12.0, word: 'love', kind: 'heart' },
    { t: 60.0, word: 'stars', kind: 'star' },
    { t: 75.0, word: 'red', kind: 'color', color: 'red', lineStart: 74, lineEnd: 78 },
  ];
  const { events } = choreograph(analysis, { seed: 7, lyricCues: cues });
  assert.ok(events.some((e) => e.layer === 'lyric' && e.type === 'heart' && Math.abs(e.t - 12) < 1e-9));
  assert.ok(events.some((e) => e.layer === 'lyric' && e.type === 'star' && Math.abs(e.t - 60) < 1e-9));
  const inLine = events.filter((e) => e.layer === 'structure' && e.t >= 74 && e.t <= 78);
  assert.ok(inLine.every((e) => e.colors.includes('red')), 'colour word recolours the line');
});
