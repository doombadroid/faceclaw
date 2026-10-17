const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

/** error-reports.ts over an in-memory file system, a settable clock and the iOS log shim. */
function harness({ files = new Map(), failWrite = false, main = true, logThrows = false } = {}) {
  const h = { files, failWrite, logged: [], timers: [], posted: [], events: {}, now: Date.parse('2026-10-17T12:00:00Z') };
  const dir = path => path.slice(0, path.lastIndexOf('/'));
  const core = {
    File: {
      exists: path => h.files.has(path),
      fromPath: path => ({
        readTextSync: () => h.files.get(path) ?? '',
        writeTextSync: text => {
          if (h.failWrite) throw new Error('disk full');
          // The process dies part way through the write.
          if (h.killAt !== undefined) { h.files.set(path, text.slice(0, h.killAt)); throw new Error('killed'); }
          h.files.set(path, text);
        },
        removeSync: () => h.files.delete(path),
        // Like NativeScript on both platforms: a rename never replaces an existing file.
        renameSync: (name, onError) => {
          const to = `${dir(path)}/${name}`;
          if (h.failRename || h.files.has(to)) return onError?.(new Error('rename failed'));
          h.files.set(to, h.files.get(path)); h.files.delete(path);
        },
      }),
    },
    knownFolders: { documents: () => ({ path: '/docs' }), ios: { library: () => ({ path: '/lib' }) } },
    path: { join: (...parts) => parts.join('/') },
    Utils: { isMainThread: () => main },
    Application: { suspendEvent: 'suspend', exitEvent: 'exit', on: (name, fn) => (h.events[name] ??= []).push(fn) },
  };
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [h.now])); } }
  const quiet = { ...console, error: () => {} };
  h.module = loader({
    global: { isIOS: true, postMessage: message => h.posted.push(JSON.parse(JSON.stringify(message))) }, Date: FakeDate, console: quiet,
    setTimeout: fn => { h.timers.push(fn); return h.timers.length; }, clearTimeout: () => {},
    FaceclawLog: { log: line => { if (logThrows) throw new Error('native log failed'); h.logged.push(line); } },
    NSBundle: { mainBundle: { infoDictionary: { objectForKey: key => ({ CFBundleShortVersionString: '0.8.3', CFBundleVersion: '42' })[key] } } },
  }, { '@nativescript/core': core })('app/native/error-reports.ts');
  // Plain copies: the vm context's objects and arrays fail deepEqual's prototype check.
  const plain = fn => (...args) => JSON.parse(JSON.stringify(fn(...args)));
  h.module = { ...h.module, normalizeError: plain(h.module.normalizeError), listErrorReports: plain(h.module.listErrorReports) };
  h.stored = () => (h.files.get('/lib/error-reports.jsonl') ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line));
  h.flushTimers = () => { const pending = h.timers; h.timers = []; for (const fn of pending) fn(); };
  h.fire = name => { for (const fn of h.events[name] ?? []) fn(); };
  return h;
}

test('Errors, strings, NSErrors and anything else become a message and a stack', () => {
  const { normalizeError } = harness().module;
  const error = new TypeError('x is undefined');
  assert.deepEqual(normalizeError(error), { message: 'TypeError: x is undefined', stack: error.stack });
  assert.equal(normalizeError(new Error('plain')).message, 'plain');
  const text = normalizeError('just text');
  assert.equal(text.message, 'just text');
  assert.match(text.stack, /error-reports/, 'a thrown string gets the reporting call site');
  assert.equal(normalizeError({ localizedDescription: 'The file doesn’t exist.', domain: 'NSCocoaErrorDomain', code: 260 }).message,
    'The file doesn’t exist. (NSCocoaErrorDomain 260)');
  assert.equal(normalizeError({ message: 'from Kotlin', stack: 'kotlin.IllegalStateException\n at …' }).stack, 'kotlin.IllegalStateException\n at …');
  assert.equal(normalizeError(42).message, '42');
  assert.equal(normalizeError(null).message, 'null');
  assert.equal(normalizeError(undefined).message, 'undefined');
  assert.equal(normalizeError({ code: 7 }).message, '{"code":7}');
  assert.equal(normalizeError({ toString() { throw new Error('no'); }, toJSON() { throw new Error('no'); } }).message, '(unprintable error)');
  assert.equal(normalizeError(new Error('')).message, 'Error', 'an empty message still says something');
  assert.equal(normalizeError('x'.repeat(5000)).message.length, 2000);
});

test('A report records when, which build, where and what, and is written at once', () => {
  const h = harness();
  h.module.reportError('ble.onState', new Error('boom'), { phase: 'connecting' });
  const [stored] = h.stored();
  assert.equal(stored.at, '2026-10-17T12:00:00.000Z');
  assert.equal(stored.build, '0.8.3 (42)');
  assert.equal(stored.platform, 'ios');
  assert.equal(stored.source, 'ble.onState');
  assert.equal(stored.message, 'boom');
  assert.match(stored.stack, /boom/);
  assert.deepEqual(stored.context, { phase: 'connecting' });
  assert.equal(stored.count, 1);
  assert.match(h.logged[0], /^\[error-report\] ble\.onState: boom/, 'reaches the iOS system log');
});

test('The same error from the same source counts up instead of adding entries', () => {
  const h = harness();
  h.module.reportError('render', new Error('bad frame'));
  h.now += 5000;
  h.module.reportError('render', new Error('bad frame'));
  h.module.reportError('render', new Error('bad frame'));
  h.module.reportError('audio', new Error('bad frame'));
  h.flushTimers();
  const reports = h.module.listErrorReports();
  assert.deepEqual(reports.map(r => [r.source, r.count]).sort(), [['audio', 1], ['render', 3]]);
  const render = reports.find(r => r.source === 'render');
  assert.equal(render.count, 3);
  assert.equal(render.at, '2026-10-17T12:00:05.000Z');
  assert.equal(h.stored().length, 2);
  assert.equal(h.stored().find(r => r.source === 'render').count, 3, 'the repeat count reaches the file');
  // Logged at counts 1 and 2 only (powers of two), so a per-frame error cannot flood the log.
  assert.equal(h.logged.filter(line => line.includes('render')).length, 2);
});

test('A burst of distinct errors writes at most once a second, the first at once', () => {
  const h = harness();
  let writes = 0;
  const files = { set: h.files.set.bind(h.files) };
  // Each save writes the .tmp once, then renames it into place.
  h.files.set = (k, v) => { if (k.endsWith('.tmp')) writes++; return files.set(k, v); };
  for (let i = 0; i < 30; i++) h.module.reportError(`burst ${i}`, `error ${i}`);
  assert.equal(writes, 1);
  assert.equal(h.stored()[0].message, 'error 0');
  h.flushTimers();
  assert.equal(writes, 2);
  assert.equal(h.stored().length, 30);
});

test('A source failing with a different message every time cannot flood the reports', () => {
  const h = harness();
  const fresh = [];
  h.module.onErrorReport((report, isNew) => { if (isNew) fresh.push(report.message); });
  for (let frame = 0; frame < 30; frame++) h.module.reportError('IosGlassesSession.submitSurfaceFrame', new Error(`frame ${frame} failed`));
  h.module.reportError('other', new Error('still heard'));
  const reports = h.module.listErrorReports();
  assert.equal(reports.length, 22, '20 distinct messages, one overflow report, and the other source');
  const overflow = reports.find(report => report.message.startsWith('more than 20'));
  assert.equal(overflow.count, 10);
  assert.equal(overflow.context.latest, 'frame 29 failed');
  assert.equal(fresh.length, 22, 'one notice per report, not per frame');
  h.module.clearErrorReports();
  h.module.reportError('IosGlassesSession.submitSurfaceFrame', new Error('frame 30 failed'));
  assert.equal(h.module.listErrorReports()[0].message, 'frame 30 failed', 'clearing starts the count over');
});

test('Reports are listed newest first, by their latest occurrence', () => {
  const h = harness();
  h.module.reportError('a', 'first');
  h.now += 1000; h.module.reportError('b', 'second');
  h.now += 1000; h.module.reportError('a', 'first');
  assert.deepEqual(h.module.listErrorReports().map(r => r.source), ['a', 'b']);
});

test('The file keeps the newest 200 reports and about 1 MB', () => {
  const h = harness();
  for (let i = 0; i < 250; i++) { h.now += 1000; h.module.reportError(`loop ${i}`, `error ${i}`); }
  const stored = h.stored();
  assert.equal(stored.length, 200);
  assert.equal(stored[0].message, 'error 50');
  assert.equal(h.module.listErrorReports().length, 200);

  const big = harness();
  for (let i = 0; i < 150; i++) { big.now += 1000; big.module.reportError(`big ${i}`, { message: `big ${i}`, stack: 's'.repeat(100_000) }); }
  const text = big.files.get('/lib/error-reports.jsonl');
  assert.ok(text.length <= 1_000_000, `${text.length} chars`);
  assert.ok(big.stored().length > 50, 'stacks are truncated, so many reports still fit');
  assert.equal(big.stored().at(-1).message, 'big 149');
});

test('Reports from an earlier launch are kept, and a recurrence is new to this session', () => {
  const first = harness();
  first.module.reportError('sync', new Error('timeout'));
  const second = harness({ files: first.files });
  const seen = [];
  second.module.onErrorReport((report, isNew) => seen.push([report.message, isNew]));
  assert.equal(second.module.listErrorReports().length, 1);
  second.module.reportError('sync', new Error('timeout'));
  second.module.reportError('sync', new Error('timeout'));
  assert.deepEqual(seen, [['timeout', true], ['timeout', false]]);
  assert.equal(second.stored().length, 2);
});

test('Listeners hear each report, can unsubscribe, and cannot break reporting', () => {
  const h = harness();
  const seen = [];
  h.module.onErrorReport(() => { throw new Error('listener bug'); });
  const off = h.module.onErrorReport((report, isNew) => seen.push([report.source, report.count, isNew]));
  h.module.reportError('x', 'one');
  h.module.reportError('x', 'one');
  h.module.reportError('y', 'two');
  off();
  h.module.reportError('z', 'three');
  assert.deepEqual(seen, [['x', 1, true], ['x', 2, false], ['y', 1, true]]);
  assert.equal(h.module.listErrorReports().length, 3);
});

test('reportError never throws, even when the disk or the input misbehaves', () => {
  const h = harness({ failWrite: true });
  const seen = [];
  h.module.onErrorReport((report, isNew) => seen.push(isNew));
  assert.doesNotThrow(() => h.module.reportError('disk', new Error('first')));
  assert.doesNotThrow(() => h.module.reportError('odd', { get message() { throw new Error('getter'); } }));
  assert.doesNotThrow(() => h.module.reportError(undefined, Symbol('s')));
  assert.doesNotThrow(() => h.flushTimers());
  assert.deepEqual(seen, [true, true, true], 'still reported in memory and to listeners');
  assert.deepEqual(h.module.listErrorReports().map(r => r.message).sort(), ['(unprintable error)', 'Symbol(s)', 'first']);

  const unreadable = harness({ files: new Map([['/lib/error-reports.jsonl', '{"source":"ok","message":"m","count":1,"at":"x"}\nnot json\n']]) });
  assert.doesNotThrow(() => unreadable.module.reportError('after', 'corrupt file'));
  assert.deepEqual(unreadable.module.listErrorReports().map(r => r.source).sort(), ['after', 'ok']);
});

test('Clearing empties the list and the file', () => {
  const h = harness();
  h.module.reportError('x', 'one');
  h.module.clearErrorReports();
  assert.deepEqual(h.module.listErrorReports(), []);
  assert.equal(h.files.has('/lib/error-reports.jsonl'), false);
  const seen = [];
  h.module.onErrorReport((_report, isNew) => seen.push(isNew));
  h.module.reportError('x', 'one');
  assert.deepEqual(seen, [true], 'a cleared error is new again');
});

test('A write killed part way loses no earlier report', () => {
  const h = harness();
  h.module.reportError('a', 'first');
  h.now += 2000; h.killAt = 10;
  h.module.reportError('b', 'second');
  assert.deepEqual(harness({ files: h.files }).module.listErrorReports().map(r => r.source), ['a']);

  // Killed between dropping the old file and renaming the new one into place: the new one is complete.
  const gap = harness();
  gap.module.reportError('a', 'first');
  gap.now += 2000; gap.failRename = true;
  gap.module.reportError('b', 'second');
  assert.deepEqual(harness({ files: gap.files }).module.listErrorReports().map(r => r.source), ['b', 'a']);
  assert.deepEqual([...gap.files.keys()], ['/lib/error-reports.jsonl'], 'the recovered copy is put in place before the next save overwrites the .tmp');

  const clean = harness();
  clean.module.reportError('a', 'first');
  clean.now += 2000; clean.module.reportError('b', 'second');
  assert.deepEqual([...clean.files.keys()], ['/lib/error-reports.jsonl'], 'no temporary file left behind');
  clean.module.clearErrorReports();
  assert.deepEqual(harness({ files: clean.files }).module.listErrorReports(), [], 'cleared stays cleared');
});

test('Reports still waiting for the timer reach disk when the app is suspended or exits', () => {
  for (const event of ['suspend', 'exit']) {
    const h = harness();
    h.module.reportError('r', 'x');
    h.module.reportError('r', 'x');
    assert.equal(h.stored()[0].count, 1);
    h.fire(event);
    assert.equal(h.stored()[0].count, 2, event);
  }
});

test('A logger that throws cannot stop the save or the listeners', () => {
  const h = harness({ logThrows: true });
  const seen = [];
  h.module.onErrorReport((_report, isNew) => seen.push(isNew));
  h.module.reportError('x', 'one');
  assert.equal(h.stored().length, 1);
  assert.deepEqual(seen, [true]);
});

test('Lines that are not reports are skipped, not fatal', () => {
  const h = harness({ files: new Map([['/lib/error-reports.jsonl', 'null\n42\n"text"\n{"at":5}\n{"source":"ok","message":"m","count":1,"at":"2026-10-16T00:00:00.000Z"}\n']]) });
  assert.deepEqual(h.module.listErrorReports().map(r => r.source), ['ok']);
  h.module.reportError('after', 'new');
  assert.deepEqual(h.stored().map(r => r.source), ['ok', 'after']);
});

test('A worker forwards its report to the main thread and never writes the file', () => {
  const h = harness({ main: false });
  h.module.reportError('worker.app', new Error('in worker'), { app: 'pinball' });
  assert.equal(h.files.size, 0, 'the main isolate owns the file');
  assert.equal(h.posted.length, 1);
  const [posted] = h.posted;
  assert.deepEqual({ ...posted, stack: undefined }, { type: 'error-report', source: 'worker.app', message: 'in worker', context: { app: 'pinball' }, stack: undefined });
  assert.match(posted.stack, /in worker/);
});
