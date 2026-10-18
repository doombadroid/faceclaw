// A caught error must never be a silent failure: every catch in the guard helpers files an error
// report (app/native/error-reports.ts, or Kotlin's CaughtErrors sink, which iOS points at
// IosErrorReports), not only a log line. PlatformLog/NSLog and console output are invisible on iOS 27.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KOTLIN = ['commonMain', 'iosMain'].map(set => path.join(ROOT, 'native/kotlin/shared/src', set, 'kotlin'));
const REPORTS = /\breportError\(|\blogJsError\(|\bCaughtErrors\.report\(/;

function walk(dir, keep) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, keep) : keep(entry.name) ? [full] : [];
  });
}
const sources = [...walk(path.join(ROOT, 'app'), n => n.endsWith('.ts')), ...KOTLIN.flatMap(dir => walk(dir, n => n.endsWith('.kt')))]
  .map(file => ({ file: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }));

/** The `{...}` starting at or after [from] (string contents are not code, but the helpers keep braces out of them). */
function block(text, from) {
  const open = text.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error('unbalanced braces');
}

/** A body plus the catch clauses after it: Kotlin's `fun f() = try { } catch (t: Throwable) { }`. */
function withCatches(text, from) {
  let body = block(text, from), end = text.indexOf('{', from) + body.length;
  for (let m; (m = /^\s*catch\s*\([^)]*\)\s*\{/.exec(text.slice(end)));) {
    const clause = block(text, end + m[0].length - 1);
    body += text.slice(end, end + m[0].length - 1) + clause;
    end += m[0].length - 1 + clause.length;
  }
  return body;
}

/** The one definition of a helper across app/ and the Kotlin sources, as its body text. */
function definition(pattern) {
  const hits = sources.flatMap(({ file, text }) => [...text.matchAll(pattern)].map(m => ({ file, body: withCatches(text, m.index + m[0].length - 1) })));
  assert.equal(hits.length, 1, `${pattern}: expected one definition, found ${hits.map(h => h.file).join(', ') || 'none'}`);
  return hits[0];
}

/** Every catch block in [body]: Kotlin `catch (t: Throwable) {`, TS `catch (error) {` and `catch {`. */
const catches = body => [...body.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)].map(m => block(body, m.index + m[0].length - 1));

const HELPERS = [
  ['boundary()', /internal inline fun <T> boundary\([^]*?\)\s*:\s*T\s*=\s*try\s*\{/g],
  ['boundaryError()', /internal inline fun boundaryError\([^]*?\)\s*:\s*String\?\s*=\s*try\s*\{/g],
  ['guardCallback', /export function guardCallback<R>\([^)]*\)[^{]*\{/g],
  ['logJsError', /export function logJsError\([^)]*\)[^{]*\{/g],
];

test('every catch in the guard helpers files an error report', () => {
  for (const [name, pattern] of HELPERS) {
    const { file, body } = definition(pattern);
    // logJsError is what guardCallback's catch calls, so its whole body is the catch path.
    const found = name === 'logJsError' ? [body] : catches(body);
    assert.ok(found.length > 0, `${name} (${file}): no catch found; the gate lost it`);
    for (const c of found) assert.match(c, name === 'logJsError' ? /\breportError\(/ : REPORTS, `${name} (${file}): a catch only logs:\n${c}`);
  }
});

test('the JS callback paths native code calls go through guardCallback', () => {
  const communicator = sources.find(s => s.file === 'app/native/faceclaw-communicator.ios.ts').text;
  assert.match(block(communicator, communicator.indexOf('private emitAsync')), /guardCallback\(/, 'emitAsync');
  assert.match(block(communicator, communicator.indexOf('setPreviewAnimationListenerListener(')), /guardCallback\(/, 'previewAnimation block');
  // A setTimeout fan-out: one throwing listener must not starve the rest, and must leave a report.
  const fanOuts = sources.filter(({ file }) => file.endsWith('.ios.ts')).flatMap(({ file, text }) => [...text.matchAll(/setTimeout\(\s*\(\)\s*=>\s*\{[^]*?\},\s*0\)/g)]
    .filter(m => /for \(const \w+ of /.test(m[0])).map(m => ({ file, code: m[0] })));
  assert.ok(fanOuts.length >= 5, `only ${fanOuts.length} setTimeout fan-outs found`);
  for (const { file, code } of fanOuts) assert.match(code, /guardCallback\(/, `${file}: ${code}`);
  const bootstrap = sources.find(s => s.file === 'app/bootstrap.ios.ts').text;
  for (const event of ['discardedErrorEvent', 'uncaughtErrorEvent']) {
    assert.match(bootstrap, new RegExp(`Application\\.${event},[^\\n]*(?:reportError|logJsError)\\('uncaught JS'`), event);
  }
});

test('every catch in bootstrap files an error report; each reporter install has its own try', () => {
  const bootstrap = sources.find(s => s.file === 'app/bootstrap.ios.ts').text;
  const found = catches(bootstrap);
  assert.ok(found.length >= 3, `only ${found.length} catches in bootstrap`);
  for (const c of found) assert.match(c, /\b(?:reportError|logJsError)\(/, `bootstrap: a catch only logs:\n${c}`);
  // One try for both: installErrorNotice throwing would leave the Kotlin listener unregistered.
  for (const install of ['installErrorNotice', 'installKotlinErrorReports']) {
    assert.match(bootstrap, new RegExp(`try \\{ ${install}\\(\\) \\} catch`), install);
  }
});

test('a rejected brightness curve reaches JS on iOS as a reported error, as it throws on Android', () => {
  const ios = sources.find(s => s.file.endsWith('iosMain/kotlin/com/faceclaw/app/ble/IosGlassesSession.kt')).text;
  assert.match(ios, /fun configureBrightness\([^)]*\): String\? =\s*boundaryError\("IosGlassesSession\.configureBrightness"\) \{ core\.configureBrightness\(/);
  const bridge = sources.find(s => s.file === 'app/native/faceclaw-communicator.ios.ts').text;
  assert.match(bridge, /async configureBrightness\([^]*?\{\s*await this\.enqueueNativeCall\(\(\) => throwIfError\(this\.communicator\.configureBrightness/);
  // The shared core throws (Android's FaceclawBleCommunicator passes it to JS); no fallback hides it.
  const core = sources.find(s => s.file.endsWith('session/GlassesSessionCore.kt')).text;
  assert.doesNotMatch(block(core, core.indexOf('fun configureBrightness(auto: Boolean')), /\bcatch\b/);
});

test('Kotlin catches reach IosErrorReports', () => {
  const ios = sources.find(s => s.file.endsWith('iosMain/kotlin/com/faceclaw/app/PlatformUtil.ios.kt')).text;
  assert.match(ios, /platformCaughtErrorSink[^=\n]*= IosErrorReports::record/);
  // Session-core catches log through logWarn(line, t); behaviour: GlassesSessionCoreTest.aListenerThatThrowsFilesAReport.
  const core = sources.find(s => s.file.endsWith('session/GlassesSessionCore.kt')).text;
  assert.match(core, /fun logWarn\(line: String, error: Throwable\? = null\) \{[^}]*if \(error != null\) CaughtErrors\.report\(/);
  // The reporter's own catches are its last resort: reporting from there would re-enter it.
  const reporter = definition(/^object IosErrorReports \{/gm).body;
  assert.doesNotMatch(reporter, /\bboundary(?:Error)?\(|CaughtErrors\.report\(/);
});

test('the one exception: remote log failures go to its status row, never to reportError', () => {
  // The error report listener forwards every report through remote-log, so a send failure filed
  // as a report would queue a line about itself (native/remote-log.ios.ts, top comment).
  const { text } = sources.find(s => s.file === 'app/native/remote-log.ios.ts');
  assert.doesNotMatch(text, /\breportError\(|\blogJsError\(|import \{[^}]*\breportError\b/);
  // Every catch except the console formatter's JSON.stringify fallback records the failure.
  const found = catches(text).filter(c => !/return String\(arg\)/.test(c));
  assert.ok(found.length >= 5, `only ${found.length} catches found`);
  for (const c of found) assert.match(c, /\bnoteFailure\(/, `remote-log: a catch neither reports nor records:\n${c}`);
  assert.match(text, /\.catch\(\(error: unknown\) => \{\s*noteFailure\('sending', error\)/, 'a failed send');
});
