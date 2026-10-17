// interop.bufferFromData(nsdata), and @nativescript/core Http's content.toArrayBuffer() (the same call on
// iOS), return an ArrayBuffer over the NSData's bytes WITHOUT retaining the NSData (NativeScript/ios 9.0.3
// InteropTypes.mm, RegisterBufferFromDataFunction: a no-op deleter). Once the NSData's JS wrapper is
// collected the view reads freed memory: silent garbage, no crash. So every such view is copied in the same
// expression, while a named local still holds the NSData.
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

/** Each native-memory view in [text] that is not copied where it is made, as `line: source`. */
function uncopied(text) {
  const found = [];
  for (const m of text.matchAll(/interop\.bufferFromData\(|\.toArrayBuffer\(\)/g)) {
    const call = m[0] === '.toArrayBuffer()', receiver = call ? /[\w$.?]*$/.exec(text.slice(Math.max(0, m.index - 200), m.index))[0] : '';
    let start = m.index - receiver.length, end = call ? m.index + m[0].length : close(text, m.index + m[0].length - 1);
    const arg = call ? receiver : text.slice(m.index + m[0].length, end - 1);
    if (text.slice(0, start).endsWith('new Uint8Array(') && text[end] === ')') { start -= 'new Uint8Array('.length; end++; }
    // A temporary argument has no JS reference holding its NSData while the copy runs.
    const named = /^[\w$.?]+$/.test(arg.trim());
    const copied = text.startsWith('.slice(', end) || text.slice(0, start).endsWith('.set(');
    if (!named || !copied) {
      const line = text.slice(0, m.index).split('\n').length;
      found.push(`${line}: ${text.split('\n')[line - 1].trim()}`);
    }
  }
  return found;
}

// Each kept site is consumed by a synchronous copy before its NSData local goes out of scope; [proof] pins that copy.
const ALLOWED = [
  { file: 'app/native/image-files.ts', site: 'grayImageFromPacket(new Uint8Array(interop.bufferFromData(toned)))',
    proof: ['app/native/image-files.ts', /export function grayImageFromPacket[^]*?image\.pixels\.set\(bytes\.subarray/] },
  { file: 'app/native/file-access.ios.ts', site: 'writeBinaryFile(path, new Uint8Array(interop.bufferFromData(data)))',
    proof: ['app/native/file-access.ios.ts', /export function writeBinaryFile[^]*?const copy = bytes\.slice\(\)/] },
];

test('every view over native NSData memory is copied where it is made', () => {
  const problems = [];
  for (const file of walk(path.join(ROOT, 'app'))) {
    const rel = path.relative(ROOT, file), text = fs.readFileSync(file, 'utf8');
    for (const site of uncopied(text)) {
      if (!ALLOWED.some(allowed => allowed.file === rel && site.includes(allowed.site))) problems.push(`${rel}:${site}`);
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
  // The build 41 download: the Http response (and its NSData) is dropped as the bytes escape.
  assert.equal(uncopied('bytes: new Uint8Array(response.content.toArrayBuffer()), contentLength').length, 1);
  assert.equal(uncopied('return interop.bufferFromData(raw);').length, 1);
  assert.equal(uncopied('new Uint8Array(interop.bufferFromData(NSData.dataWithContentsOfFile(p))).slice()').length, 1);
  assert.deepEqual(uncopied('new Uint8Array(interop.bufferFromData(data)).slice(); x.pixels.set(new Uint8Array(interop.bufferFromData(d)))'), []);
});
