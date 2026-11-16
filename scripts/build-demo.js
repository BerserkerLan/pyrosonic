#!/usr/bin/env node
/**
 * Renders the procedural demo track and encodes it to public/demo/skyline.mp3.
 * Usage: node scripts/build-demo.js [--wav path/to/out.wav]
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { renderDemo, encodeWav } from './demo-synth.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const wavArg = args.indexOf('--wav');
const wavPath = wavArg >= 0 ? resolve(args[wavArg + 1]) : join(tmpdir(), `skyline-${process.pid}.wav`);
const mp3Path = join(root, 'public', 'demo', 'skyline.mp3');

const t0 = Date.now();
let last = -1;
const demo = renderDemo({
  sampleRate: 44100,
  onProgress: (p) => {
    const pct = Math.floor(p * 10) * 10;
    if (pct !== last) { last = pct; process.stdout.write(`\rRendering demo… ${pct}%`); }
  },
});
process.stdout.write(`\rRendered ${demo.meta.duration.toFixed(1)} s in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

mkdirSync(dirname(wavPath), { recursive: true });
writeFileSync(wavPath, encodeWav(demo.channels, demo.sampleRate));
mkdirSync(dirname(mp3Path), { recursive: true });
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-i', wavPath,
  '-codec:a', 'libmp3lame', '-q:a', '2',
  '-metadata', 'title=Skyline',
  '-metadata', 'artist=Pyrosonic',
  '-metadata', 'album=Pyrosonic Demo',
  mp3Path,
]);
if (wavArg < 0) rmSync(wavPath, { force: true });
console.log(`Wrote ${mp3Path}${wavArg >= 0 ? ` and ${wavPath}` : ''}`);
