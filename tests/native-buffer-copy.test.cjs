// interop.bufferFromData(nsdata), and @nativescript/core Http's content.toArrayBuffer() (the same call on
// iOS), return an ArrayBuffer over the NSData's bytes WITHOUT retaining the NSData (NativeScript/ios 9.0.3
// InteropTypes.mm, RegisterBufferFromDataFunction: a no-op deleter). Once the NSData's JS wrapper is
// collected the view reads freed memory: silent garbage, no crash. So every such view is copied in the same
// expression, while a named local still holds the NSData. That a named local stays alive until the copy
// finishes rests on the runtime running V8 --jitless (Runtime.mm): Ignition frames keep every register a
// GC root, where optimized code could drop a local after its last use. core's File.readBuffer(Sync) views
// a temporary NSData the app never holds, so no copy can save it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : /\.(?:ts|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

/** Index just past the `)` closing the `(` at [open]. */
function close(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i + 1;
  }
  throw new Error('unbalanced parens');
}

/** Each native-memory view in [text] that is not copied where it is made, as { line, site }: [site] runs from
 * the start of its line to just past the view's consumer `)`. */
function uncopied(text) {
  const found = [];
  for (const m of text.matchAll(/\b(?:bufferFromData|readBuffer(?:Sync)?)\b|(?<=\.)toArrayBuffer\b(?=\s*(?:\?\.)?\s*\()/g)) {
    const before = text.slice(Math.max(0, m.index - 200), m.index), after = text.slice(m.index + m[0].length);
    let start = m.index, end = -1, named = false;
    if (m[0] === 'toArrayBuffer') {
      // A receiver chain rooted at a named local: `(await x).content` has none.
      const receiver = /(?<![\w$.?)\]])[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\??\.$/.exec(before);
      const call = /^\s*(?:\?\.)?\s*\(\s*\)/.exec(after);
      if (receiver && call) { start -= receiver[0].length; end = m.index + m[0].length + call[0].length; named = true; }
    } else if (m[0] === 'bufferFromData' && /(?<![\w$.?)\]])interop\.$/.test(before) && after.startsWith('(')) {
      start -= 'interop.'.length;
      end = close(text, m.index + m[0].length);
      // A temporary or getter argument has no JS reference holding its NSData while the copy runs.
      named = /^\s*[A-Za-z_$][\w$]*\s*$/.test(text.slice(m.index + m[0].length + 1, end - 1));
    }
    const wrap = /new Uint8Array\(\s*$/.exec(text.slice(Math.max(0, start - 100), start)), unwrap = /^\s*,?\s*\)/.exec(text.slice(end));
    if (end >= 0 && wrap && unwrap) { start -= wrap[0].length; end += unwrap[0].length; }
    // `.set(` copies only into a typed array; the app's are GrayImage pixels (a Map's set would store the view).
    const copied = end >= 0 && (/^\s*\.slice\(/.test(text.slice(end)) || /\.pixels\.set\(\s*$/.test(text.slice(Math.max(0, start - 100), start)));
    if (!named || !copied) {
      const line = text.slice(0, m.index).split('\n').length;
      found.push({ line, site: text.slice(text.lastIndexOf('\n', start) + 1, end < 0 ? m.index + m[0].length : end + 1).trim() });
    }
  }
  return found;
}

// Each kept site is consumed by a synchronous copy before its NSData local goes out of scope; [proof] pins that copy.
const ALLOWED = [
  { file: 'app/native/image-files.ts', site: 'grayImageFromPacket(new Uint8Array(interop.bufferFromData(toned)))',
    proof: ['app/native/image-files.ts', /export function grayImageFromPacket(?:(?!\n\})[^])*?image\.pixels\.set\(bytes\.subarray/] },
  { file: 'app/native/file-access.ios.ts', site: 'writeBinaryFile(path, new Uint8Array(interop.bufferFromData(data)))',
    proof: ['app/native/file-access.ios.ts', /export function writeBinaryFile(?:(?!\n\})[^])*?const copy = bytes\.slice\(\)/] },
];

test('every view over native NSData memory is copied where it is made', () => {
  const problems = [];
  for (const file of walk(path.join(ROOT, 'app'))) {
    const rel = path.relative(ROOT, file), text = fs.readFileSync(file, 'utf8');
    for (const { line, site } of uncopied(text)) {
      if (!ALLOWED.some(allowed => allowed.file === rel && site.endsWith(allowed.site))) problems.push(`${rel}:${line}: ${site}`);
    }
  }
  assert.deepEqual(problems, [], 'copy with .slice() in the same expression, from a named NSData local');
});

test('each allowed site still exists and its synchronous copy is still there', () => {
  for (const { file, site, proof: [proofFile, pattern] } of ALLOWED) {
    assert.ok(fs.readFileSync(path.join(ROOT, file), 'utf8').includes(site), `${file}: allowed site gone, drop it from ALLOWED`);
    assert.match(fs.readFileSync(path.join(ROOT, proofFile), 'utf8'), pattern, `${proofFile}: the copy that made ${site} safe is gone`);
  }
});

test('the gate flags the uncopied forms', () => {
  const flags = code => assert.notDeepEqual(uncopied(code), [], code);
  // The build 41 download: the Http response (and its NSData) is dropped as the bytes escape.
  flags('bytes: new Uint8Array(response.content.toArrayBuffer()), contentLength');
  flags('return interop.bufferFromData(raw);');
  flags('new Uint8Array(interop.bufferFromData(NSData.dataWithContentsOfFile(p))).slice()');
  flags('new Uint8Array(interop.bufferFromData(img.TIFFRepresentation)).slice()');
  flags('new Uint8Array((await Http.request(o)).content.toArrayBuffer()).slice()');
  flags('new Uint8Array((interop as any).bufferFromData(raw)).slice()');
  flags('const { bufferFromData } = interop; return new Uint8Array(bufferFromData(raw)).slice()');
  flags('interop["bufferFromData"](raw)');
  flags('cache.set(new Uint8Array(interop.bufferFromData(data)));');
  flags('File.fromPath(p).readBufferSync()');
  // A second view on an allowed site's line is its own site.
  assert.deepEqual(uncopied('f(new Uint8Array(interop.bufferFromData(a))); g(new Uint8Array(interop.bufferFromData(b)))').map(found => found.site),
    ['f(new Uint8Array(interop.bufferFromData(a)))', 'f(new Uint8Array(interop.bufferFromData(a))); g(new Uint8Array(interop.bufferFromData(b)))']);
  assert.deepEqual(uncopied('new Uint8Array(interop.bufferFromData(data)).slice(); x.pixels.set(new Uint8Array(interop.bufferFromData(d)))'), []);
  assert.deepEqual(uncopied('new Uint8Array(\n  interop.bufferFromData(x),\n).slice(); new Uint8Array(response.content.toArrayBuffer?.()).slice()'), []);
});
