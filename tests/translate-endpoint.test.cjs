// Listen's pause detector (app/apps/translate/endpoint.ts): utterance ends on 16 kHz S16LE PCM.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const { Endpointer } = loader()('app/apps/translate/endpoint.ts');
const RATE = 16000;

// Seconds of a 300 Hz tone at `amp` (0..1) over a little noise; amp 0 is the room's noise alone.
function pcm(seconds, amp, seed = 1) {
  const n = Math.round(seconds * RATE), out = new Int16Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const noise = ((s / 0x7fffffff) - 0.5) * 200;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(noise + amp * 20000 * Math.sin(2 * Math.PI * 300 * i / RATE))));
  }
  return new Uint8Array(out.buffer);
}
// Feeds `parts` in 50 ms chunks (as the glasses deliver them); returns every boundary.
function run(parts, opts) {
  const e = new Endpointer(opts), out = [];
  for (const part of parts) for (let i = 0; i < part.length; i += 1600) out.push(...e.push(part.subarray(i, i + 1600)));
  return out;
}
const near = (actual, expected, tol = 0.11) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} not within ${tol} of ${expected}`);

test('one utterance ends shortly after its last speech, once the pause is long enough', () => {
  const b = run([pcm(1, 0), pcm(2, 0.5), pcm(1, 0)]);
  assert.equal(b.length, 1);
  near(b[0], 3.15);
});

test('two utterances with a 1.2 s gap give two boundaries; a 0.3 s gap is one utterance', () => {
  const b = run([pcm(1, 0), pcm(1.5, 0.5), pcm(1.2, 0), pcm(1, 0.5), pcm(1, 0)]);
  assert.equal(b.length, 2);
  near(b[0], 2.65); near(b[1], 4.85);
  assert.equal(run([pcm(1, 0), pcm(1, 0.5), pcm(0.3, 0), pcm(1, 0.5), pcm(1, 0)]).length, 1);
});

test('a click shorter than minSpeech is no utterance', () => {
  assert.deepEqual(run([pcm(1, 0), pcm(0.1, 0.5), pcm(1.5, 0)]), []);
});

test('continuous speech is cut at maxSegmentS', () => {
  const b = run([pcm(0.5, 0), pcm(5.2, 0.5)], { maxSegmentS: 2 });
  assert.equal(b.length, 2);
  near(b[0], 2.5); near(b[1], 4.5);
});

test('silence alone, and odd chunk sizes, never produce a boundary or throw', () => {
  const e = new Endpointer();
  assert.equal(e.push(pcm(3, 0).subarray(0, 12345)).length, 0);
  assert.equal(e.push(new Uint8Array(0)).length, 0);
});

test('a louder room raises the floor: steady noise is not speech', () => {
  assert.ok(run([pcm(1, 0), pcm(4, 0.05), pcm(1, 0)]).length <= 1);
});
