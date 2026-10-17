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
        // Like NativeScript: a read failure (say, a torn UTF-8 sequence) goes to onError, else returns undefined.
        readTextSync: onError => {
          if (h.failRead === true || h.failRead === path) { const error = new Error('unreadable'); return onError ? onError(error) : undefined; }
          return h.files.get(path) ?? '';
        },
        writeTextSync: text => {
          if (h.failWrite) throw new Error('disk full');
          // The process dies part way through the write.
          if (h.killAt !== undefined) { h.files.set(path, text.slice(0, h.killAt)); throw new Error('killed'); }
          h.files.set(path, text);
        },
        removeSync: onError => { if (h.failRemove) return onError?.(new Error('killed')); h.files.delete(path); },
        // Like NativeScript on both platforms: a rename never replaces an existing file.
        renameSync: (name, onError) => {
          const to = `${dir(path)}/${name}`;
          if (h.failRename || h.files.has(to)) return onError?.(new Error('rename failed'));
          h.files.set(to, h.files.get(path)); h.files.delete(path);
        },
      }),
    },
    Folder: { fromPath: folder => ({ getEntitiesSync: () => [...h.files.keys()].filter(key => dir(key) === folder).map(key => ({ name: key.slice(folder.length + 1), path: key })) }) },
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
    FaceclawKitIosErrorReports: { shared: { forgetRepeats: () => { h.kotlinForgot = (h.kotlinForgot ?? 0) + 1; } } },
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

test('A new error is on disk at once, up to 5 a second; a burst past that waits for the timer', () => {
  const h = harness();
  let writes = 0;
  const files = { set: h.files.set.bind(h.files) };
  // Each save writes the .tmp once, then renames it into place.
  h.files.set = (k, v) => { if (k.endsWith('.tmp')) writes++; return files.set(k, v); };
  for (let i = 0; i < 30; i++) h.module.reportError(`burst ${i}`, `error ${i}`);
  assert.equal(writes, 5);
  assert.deepEqual(h.stored().map(r => r.message), ['error 0', 'error 1', 'error 2', 'error 3', 'error 4']);
  h.flushTimers();
  assert.equal(writes, 6);
  assert.equal(h.stored().length, 30);
  h.now += 1000;
  h.module.reportError('later', 'a second on');
  assert.equal(writes, 7, 'the next second has its own budget');
  assert.equal(h.stored().at(-1).message, 'a second on');
});

test('An error repeating every frame rewrites the file at counts 2, 4, 8... only, and the latest count is flushed at suspend', () => {
  const h = harness();
  let writes = 0;
  const files = { set: h.files.set.bind(h.files) };
  h.files.set = (k, v) => { if (k.endsWith('.tmp')) writes++; return files.set(k, v); };
  h.module.reportError('IosGlassesSession.submitSurfaceFrame', new Error('surface gone'));
  assert.equal(writes, 1, 'a new report is on disk at once');
  // A thousand frames, the timer firing between each: a second's worth of frames or more.
  for (let frame = 0; frame < 1000; frame++) {
    h.now += 1000;
    h.module.reportError('IosGlassesSession.submitSurfaceFrame', new Error('surface gone'));
    h.flushTimers();
  }
  assert.equal(writes, 1 + 9, 'counts 2, 4, 8 ... 512 only');
  assert.equal(h.stored()[0].count, 512);
  h.module.reportError('other', new Error('new'));
  assert.equal(writes, 11, 'a new report still saves at once');
  assert.equal(h.stored().find(r => r.source === 'IosGlassesSession.submitSurfaceFrame').count, 1001, 'and carries the latest count');
  h.module.reportError('IosGlassesSession.submitSurfaceFrame', new Error('surface gone'));
  h.fire('suspend');
  assert.equal(h.stored().find(r => r.source === 'IosGlassesSession.submitSurfaceFrame').count, 1002, 'suspend flushes a repeat-only change');
  h.fire('exit');
  assert.equal(writes, 12, 'nothing left to flush at exit');
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

test('A listener that throws files its own report, once, without looping', () => {
  const h = harness();
  h.module.onErrorReport(() => { throw new Error('refresh failed'); });
  h.module.reportError('x', 'one');
  // Deferred: the caller may be mid-layout, and reporting inline would re-enter the listener.
  assert.deepEqual(h.module.listErrorReports().map(r => r.source), ['x']);
  for (let i = 0; i < 5; i++) h.flushTimers();
  const reports = h.module.listErrorReports();
  assert.deepEqual(reports.map(r => [r.source, r.message, r.count]).sort(),
    [['error report listener', 'refresh failed', 1], ['x', 'one', 1]]);
  assert.deepEqual(h.timers, [], 'no report re-arms itself');
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

test('An unreadable file is moved aside and reported, never overwritten by the next save', () => {
  const h = harness({ files: new Map([['/lib/error-reports.jsonl', 'older reports']]) });
  h.failRead = true;
  h.module.reportError('after', 'new');
  h.failRead = false;
  const aside = [...h.files.keys()].filter(key => key.startsWith('/lib/error-reports.jsonl.corrupt-'));
  assert.deepEqual(aside, ['/lib/error-reports.jsonl.corrupt-2026-10-17T12-00-00-000Z']);
  assert.equal(h.files.get(aside[0]), 'older reports', 'kept as it was');
  const stored = h.stored();
  assert.deepEqual(stored.map(r => r.source).sort(), ['after', 'error reports']);
  const notice = stored.find(r => r.source === 'error reports');
  assert.match(notice.message, /unreadable/);
  assert.equal(notice.context.movedTo, 'error-reports.jsonl.corrupt-2026-10-17T12-00-00-000Z');
});

test('At most two unreadable files are kept', () => {
  const files = new Map([['/lib/error-reports.jsonl', 'new garbage'],
    ...['2026-10-01', '2026-10-02', '2026-10-03'].map(day => [`/lib/error-reports.jsonl.corrupt-${day}T00-00-00-000Z`, day])]);
  const h = harness({ files });
  h.failRead = true;
  h.module.reportError('after', 'new');
  assert.deepEqual([...h.files.keys()].filter(key => key.includes('.corrupt-')).sort(), [
    '/lib/error-reports.jsonl.corrupt-2026-10-03T00-00-00-000Z', '/lib/error-reports.jsonl.corrupt-2026-10-17T12-00-00-000Z']);
});

test('An unreadable file that cannot be moved aside is not overwritten either', () => {
  const h = harness({ files: new Map([['/lib/error-reports.jsonl', 'older reports']]) });
  h.failRead = true; h.failRename = true;
  h.module.reportError('after', 'new');
  h.flushTimers();
  assert.equal(h.files.get('/lib/error-reports.jsonl'), 'older reports');
  assert.deepEqual(h.module.listErrorReports().map(r => r.source).sort(), ['after', 'error reports'], 'still reported in memory');
});

test('Killed after writing the .tmp but before dropping the old file: both are merged', () => {
  const h = harness();
  h.module.reportError('a', 'first');
  h.now += 2000;
  h.module.reportError('a', 'first');
  h.flushTimers();
  h.now += 2000;
  h.module.reportError('a', 'first');
  h.module.reportError('a', 'first');
  h.failRemove = true;
  h.module.reportError('b', 'second');
  h.failRemove = false;
  assert.deepEqual([...h.files.keys()].sort(), ['/lib/error-reports.jsonl', '/lib/error-reports.jsonl.tmp']);
  const next = harness({ files: h.files });
  const listed = next.module.listErrorReports();
  assert.deepEqual(listed.map(r => [r.source, r.count, r.at]), [['b', 1, '2026-10-17T12:00:04.000Z'], ['a', 4, '2026-10-17T12:00:04.000Z']]);
  next.now += 10_000;
  next.module.reportError('c', 'third');
  assert.deepEqual([...next.files.keys()], ['/lib/error-reports.jsonl'], 'the next save writes the merged set');
  assert.deepEqual(next.stored().map(r => [r.source, r.count]).sort(), [['a', 4], ['b', 1], ['c', 1]]);
});

test('A torn .tmp next to an intact file: only the .tmp is moved aside, the file\'s reports stay', () => {
  const keep = JSON.stringify({ at: '2026-10-16T00:00:00.000Z', source: 'old', message: 'kept', count: 3 });
  const h = harness({ files: new Map([['/lib/error-reports.jsonl', `${keep}\n`], ['/lib/error-reports.jsonl.tmp', 'torn \u2026']]) });
  h.failRead = '/lib/error-reports.jsonl.tmp';
  const listed = h.module.listErrorReports();
  assert.deepEqual(listed.map(r => [r.source, r.count]), [['error reports', 1], ['old', 3]]);
  assert.equal(listed[0].context.tmpMovedTo, 'error-reports.jsonl.corrupt-2026-10-17T12-00-00-000Z.tmp');
  assert.equal(listed[0].context.movedTo, undefined, 'the intact file stays');
  assert.deepEqual([...h.files.keys()].sort(), ['/lib/error-reports.jsonl', '/lib/error-reports.jsonl.corrupt-2026-10-17T12-00-00-000Z.tmp']);
  assert.deepEqual(h.stored().map(r => r.source).sort(), ['error reports', 'old'], 'the notice is saved next to the kept report');

  // The other way round: an unreadable file next to a complete .tmp keeps the .tmp's reports.
  const tmp = harness({ files: new Map([['/lib/error-reports.jsonl', 'garbage'], ['/lib/error-reports.jsonl.tmp', `${keep}\n`]]) });
  tmp.failRead = '/lib/error-reports.jsonl';
  assert.deepEqual(tmp.module.listErrorReports().map(r => [r.source, r.context?.movedTo]),
    [['error reports', 'error-reports.jsonl.corrupt-2026-10-17T12-00-00-000Z'], ['old', undefined]]);
  assert.equal(tmp.files.get('/lib/error-reports.jsonl.corrupt-2026-10-17T12-00-00-000Z'), 'garbage');
});

test('Clearing also resets Kotlin\'s repeat filter, so an error that keeps happening is new again at once', () => {
  const h = harness();
  h.module.reportError('x', 'one');
  h.module.clearErrorReports();
  assert.equal(h.kotlinForgot, 1);
});

test('Merging keeps an earlier launch\'s report of the same error apart', () => {
  const first = harness();
  first.module.reportError('sync', 'timeout');
  const second = harness({ files: first.files });
  second.now += 60_000;
  second.failRemove = true;
  second.module.reportError('sync', 'timeout');
  const third = harness({ files: second.files });
  assert.deepEqual(third.module.listErrorReports().map(r => [r.message, r.at]),
    [['timeout', '2026-10-17T12:01:00.000Z'], ['timeout', '2026-10-17T12:00:00.000Z']]);
});

test('An error Kotlin already filed (thrown by throwIfError) is not filed twice', () => {
  const h = harness();
  const { throwIfError } = loader({}, {})('app/native/kotlin-data.ts');
  let thrown;
  try { throwIfError('IosGlassesSession.configureSurface: Unknown surface: s'); } catch (error) { thrown = error; }
  assert.equal(thrown.message, 'IosGlassesSession.configureSurface: Unknown surface: s');
  h.module.reportError('iOS preview', thrown);
  assert.deepEqual(h.module.listErrorReports(), [], 'boundaryError filed it on the Kotlin side');
  h.module.reportError('iOS preview', new Error('a JS failure'));
  assert.deepEqual(h.module.listErrorReports().map(r => r.message), ['a JS failure']);
});

test('Kotlin forwards a repeat with the occurrences it skipped, and the count stays true', () => {
  const h = harness();
  const kit = { shared: {} };
  loader({ FaceclawKitIosErrorReports: kit, FaceclawKitIosErrorReportListener: {} }, {
    './kotlin-listener.ios': { kotlinListener: (_protocol, impl) => impl }, './error-reports': { reportError: h.module.reportError },
  })('app/native/kotlin-error-reports.ios.ts').installKotlinErrorReports();
  const listener = kit.shared.listener;
  // IosErrorReports.record forwards the 1st, 2nd, 4th, 8th occurrence: 1, 1, 2, 4 at a time.
  for (const occurrences of [1, 1, 2, 4]) listener.onCaughtErrorSourceMessageStackOccurrences('IosGlassesSession.submitSurfaceFrame', 'kotlin.IllegalStateException: surface gone', 'at frame', occurrences);
  const [report] = h.module.listErrorReports();
  assert.equal(report.count, 8);
  assert.equal(report.stack, 'at frame');
  assert.equal(h.stored()[0].count, 1, 'the first is on disk at once; the timer writes the rest');
  h.flushTimers();
  assert.equal(h.stored()[0].count, 8, 'count 2, 4 and 8 are each a write');
});
