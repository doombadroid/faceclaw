// Every iosMain entry point JavaScript or an ObjC shim calls must go through boundary() or
// boundaryError() (commonMain util/PlatformUtil.kt). Kotlin/Native terminates the app when an
// exception without @Throws reaches Objective-C, so a JS try/catch or .catch() never runs; @Throws
// would rename every selector the JS uses. Constructors and properties are not checked here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const IOS_MAIN = path.join(ROOT, 'native/kotlin/shared/src/iosMain/kotlin');

// Referenced from JS but never called: JS passes IosProtocolPlatform.shared to IosBleCentral.
const NOT_CALLED = new Set(['IosProtocolPlatform']);
// Their `override fun`s implement Kotlin ports (SessionLink, StockLink) the shared cores call on
// their own threads, where exceptions stay in Kotlin; JS only scans and waits for power-on.
const KOTLIN_PORTS = new Set(['IosBleCentral']);
// Field reads and writes that cannot throw.
const TRIVIAL = new Set([
  'IosBleCentral.setSessionListener', 'IosBleCentral.setAncsAuthorizationListener', 'IosBleCentral.bluetoothState',
  'IosBleTraffic.recordWrite', 'IosBleTraffic.recordRead', 'IosBleTraffic.recordDisplayFrame', 'IosBleTraffic.sample',
  'IosVideoPlayer.setListener', 'IosVideoPlayer.isPlaying',
  'IosWavRecorder.isOpen',
  'IosDeviceInfoProbe.setListener', 'IosFlashPrompt.setListener', 'IosFirmwareFlasher.setListener',
]);

function walk(dir, test) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, test) : test(entry.name) ? [full] : [];
  });
}

/** The source with string, char and comment contents blanked (offsets kept), so braces are code. */
function mask(text) {
  let out = '';
  const modes = []; // 'str' | 'raw' | template brace depth (number)
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], mode = modes[modes.length - 1];
    const blank = n => { out += text.slice(i, i + n).replace(/[^\n]/g, ' '); i += n - 1; };
    if (mode === 'str' || mode === 'raw') {
      if (mode === 'str' && c === '\\') { blank(2); continue; }
      if (c === '$' && text[i + 1] === '{') { modes.push(++depth); out += '${'; i++; continue; }
      if (mode === 'raw' && text.startsWith('"""', i)) { modes.pop(); out += '"""'; i += 2; continue; }
      if (mode === 'str' && c === '"') { modes.pop(); out += c; continue; }
      blank(1);
      continue;
    }
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); blank((end < 0 ? text.length : end) - i); continue; }
    if (text.startsWith('/*', i)) { blank(text.indexOf('*/', i) + 2 - i); continue; }
    if (text.startsWith('"""', i)) { modes.push('raw'); out += '"""'; i += 2; continue; }
    if (c === '"') { modes.push('str'); out += c; continue; }
    if (c === "'") { blank(text.indexOf("'", i + (text[i + 1] === '\\' ? 3 : 2)) + 1 - i); continue; }
    if (c === '{') depth++;
    if (c === '}') { if (mode === depth) { modes.pop(); depth--; out += c; continue; } depth--; }
    out += c;
  }
  return out;
}

function closingBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
}

/** Public member funs of each top-level class/object (and its companion), with the text after the signature. */
function facadeFunctions(file) {
  const text = fs.readFileSync(file, 'utf8');
  const masked = mask(text);
  const out = [];
  for (const m of masked.matchAll(/^(?:open |abstract |data )?(class|object) (\w+)[^{\n]*(?:\n[^{\n]*)*?\{/gm)) {
    const owner = m[2];
    const open = m.index + m[0].length - 1;
    const close = closingBrace(masked, open);
    const scopes = [[open + 1, close]];
    const body = masked.slice(open + 1, close);
    const companion = /^ {4}companion object[^{\n]*\{/m.exec(body);
    if (companion) {
      const start = open + 1 + companion.index + companion[0].length - 1;
      scopes.push([start + 1, closingBrace(masked, start)]);
    }
    for (const [from, to] of scopes) {
      let depth = 0;
      for (let i = from; i < to; i++) {
        if (masked[i] === '{') depth++;
        else if (masked[i] === '}') depth--;
        if (depth !== 0 || (i > from && masked[i - 1] !== '\n')) continue;
        const decl = /^ +((?:\w+ )*)fun (?:<[^>]*> )?(\w+)\(/.exec(masked.slice(i, to));
        if (!decl || /\b(private|internal|protected)\b/.test(decl[1])) continue;
        const after = masked.slice(i + decl[0].length);
        out.push({ owner, name: decl[2], override: /\boverride\b/.test(decl[1]), rest: text.slice(i + decl[0].length, i + decl[0].length + after.length),
          where: `${path.relative(ROOT, file)}:${text.slice(0, i).split('\n').length}` });
      }
    }
  }
  return out;
}

/** The text after a fun's parameter list: `): T = boundary("Owner.name", ...`, or a call of a guarded sibling. */
function guarded(fn, siblings = new Set()) {
  let depth = 1, i = 0;
  for (; i < fn.rest.length && depth > 0; i++) {
    if (fn.rest[i] === '(') depth++;
    else if (fn.rest[i] === ')') depth--;
  }
  const body = fn.rest.slice(i).replace(/^\s*:\s*[\w<>?, .]+?(?=\s*=)/, '');
  const label = `${fn.owner}.${fn.name}`.replace(/\./g, '\\.');
  if (new RegExp(`^\\s*=\\s*(?:boundary\\("${label}",|boundaryError\\("${label}"\\))`).test(body)) return true;
  const delegate = /^\s*=\s*(\w+)\(/.exec(body);
  return !!delegate && delegate[1] !== fn.name && siblings.has(delegate[1]);
}

function referencedNames() {
  const sources = [...walk(path.join(ROOT, 'app'), n => n.endsWith('.ts')), ...walk(path.join(ROOT, 'App_Resources/iOS/src'), n => /\.(m|h|swift)$/.test(n))];
  const names = new Set();
  for (const file of sources) for (const m of fs.readFileSync(file, 'utf8').matchAll(/FaceclawKit(\w+)/g)) names.add(m[1]);
  return names;
}

function unguarded() {
  const names = referencedNames();
  const problems = [];
  let checked = 0;
  for (const file of walk(IOS_MAIN, n => n.endsWith('.kt'))) {
    const fns = facadeFunctions(file);
    for (const fn of fns) {
      if (!names.has(fn.owner) || NOT_CALLED.has(fn.owner)) continue;
      if (fn.override && KOTLIN_PORTS.has(fn.owner)) continue;
      const label = `${fn.owner}.${fn.name}`;
      if (TRIVIAL.has(label)) continue;
      checked++;
      const siblings = new Set(fns.filter(other => other.owner === fn.owner && guarded(other)).map(other => other.name));
      if (!guarded(fn, siblings)) problems.push(`${fn.where}: ${label} is callable from JS but not \`= boundary("${label}", ...)\``);
    }
  }
  return { problems, checked };
}

test('every JS-callable iosMain facade fun goes through boundary()', () => {
  const { problems, checked } = unguarded();
  assert.ok(checked > 100, `only ${checked} facade funs found; the parser lost them`);
  assert.deepEqual(problems, []);
});

test('the gate finds the facades it guards', () => {
  const found = new Set(walk(IOS_MAIN, n => n.endsWith('.kt')).flatMap(facadeFunctions).map(fn => `${fn.owner}.${fn.name}`));
  for (const label of ['IosGlassesSession.setSurfaceVisible', 'IosSurfaceCompositor.visible', 'IosVideoPlayer.probe',
    'IosWavRecorder.repairHeader', 'IosRemoteInput.startAddress', 'IosConversationStore.deleteUnreferencedRecordings']) {
    assert.ok(found.has(label), label);
  }
  // Nested private classes and anonymous objects are not facade entry points.
  assert.ok(!found.has('IosGlassesSession.onAudioPacket'));
  assert.ok(!found.has('IosCaptionEngine.loadTranscriber'));
  assert.ok(!found.has('IosGlassesSession.coreForTests'));
});

test('guarded() needs the helper and the owner.name label', () => {
  const fn = rest => ({ owner: 'IosX', name: 'go', rest });
  assert.ok(guarded(fn('a: Int): Boolean = boundary("IosX.go", false) { a > 0 }')));
  assert.ok(guarded(fn('id: String) = boundaryError("IosX.go") { use(id) }')));
  assert.ok(guarded(fn('): List<NSData> = boundary("IosX.go", emptyList()) { x() }')));
  assert.ok(!guarded(fn('id: String) = core.go(id)')));
  assert.ok(!guarded(fn('id: String) = boundary("IosX.other", Unit) { core.go(id) }')));
  assert.ok(!guarded(fn('id: String) {\n        boundary("IosX.go", Unit) { core.go(id) }\n    }')));
  assert.ok(guarded(fn('port: Int): String = goAt(port, "x")'), new Set(['goAt'])));
  assert.ok(!guarded(fn('port: Int): String = goAt(port, "x")'), new Set(['other'])));
});
