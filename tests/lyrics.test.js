import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLRC, looksLikeLRC, fromSyncText } from '../src/lyrics/lrc.js';
import { parseLyricsfile } from '../src/lyrics/lrclib.js';
import { lyricCues } from '../src/lyrics/keywords.js';
import { parseFilename } from '../src/audio/metadata.js';

test('LRC: timestamps, repeats, offset and enhanced word tags', () => {
  const ly = parseLRC(
    '[ti:Test]\n[offset:+200]\n[00:01.00]<00:01.00>Hello <00:01.50>red <00:02.10>world\n[00:03.00][00:10.00]Chorus fire line\n[00:05.5]\n[1:02.345]Late line',
    'file',
  );
  assert.equal(ly.synced, true);
  assert.equal(ly.lines.length, 4);
  assert.ok(Math.abs(ly.lines[0].t - 0.8) < 1e-9);
  assert.equal(ly.lines[0].words.length, 3);
  assert.ok(Math.abs(ly.lines[0].words[1].t - 1.3) < 1e-9);
  assert.ok(Math.abs(ly.lines[1].end - 5.3) < 1e-9, 'blank line ends the previous one');
  assert.ok(Math.abs(ly.lines[2].t - 9.8) < 1e-9);
  assert.ok(Math.abs(ly.lines[3].t - 62.145) < 1e-9);
  assert.equal(looksLikeLRC('just words'), false);
});

test('LRCLIB word-synced lyricsfile (YAML)', () => {
  const yaml = `version: '1.0'
metadata:
  title: Test
lines:
- text: Hearts on fire
  start_ms: 1000
  end_ms: 2600
  words:
  - text: 'Hearts '
    start_ms: 1000
  - text: 'on '
    start_ms: 1500
  - text: fire
    start_ms: 1900
- text: It's golden
  start_ms: 3000
  end_ms: 4000
  words: []
`;
  const ly = parseLyricsfile(yaml);
  assert.equal(ly.lines.length, 2);
  assert.equal(ly.lines[0].words.length, 3);
  assert.ok(Math.abs(ly.lines[0].words[2].t - 1.9) < 1e-9);
  assert.equal(ly.lines[1].text, "It's golden");
  const cues = lyricCues(ly);
  assert.deepEqual(cues.map((c) => c.kind), ['heart', 'fire', 'gold']);
});

test('embedded SYLT lyrics', () => {
  const ly = fromSyncText([{ text: 'b', timestamp: 2000 }, { text: 'a', timestamp: 500 }, { text: 'x' }]);
  assert.deepEqual(ly.lines.map((l) => l.text), ['a', 'b']);
});

test('filename parsing', () => {
  assert.deepEqual(parseFilename('03 - Daft Band – Night Sky (Official Audio).mp3'), { artist: 'Daft Band', title: 'Night Sky' });
  assert.deepEqual(parseFilename('my_song.wav'), { artist: '', title: 'my song' });
});
