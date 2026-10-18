const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const QUEUE = '/lib/remote-log-queue.jsonl';

/** remote-log.ios.ts over an in-memory file, a settable clock, manual timers and a scripted Http. */
function harness({ url = 'https://sink.example/abc', files = new Map(), secrets = [] } = {}) {
  const h = { url, files, secrets, now: Date.parse('2026-10-17T12:00:00Z'), timers: [], requests: [], tasks: [], events: {}, reports: [], printed: [], respond: () => Promise.resolve({ statusCode: 200 }) };
  const core = {
    File: {
      exists: path => h.files.has(path),
      fromPath: path => ({
        readTextSync: () => h.files.get(path) ?? '',
        writeTextSync: text => { h.files.set(path, text); },
        appendTextSync: text => { h.files.set(path, (h.files.get(path) ?? '') + text); },
      }),
    },
    Http: { request: options => { h.requests.push(options); return h.respond(options); } },
    knownFolders: { ios: { library: () => ({ path: '/lib' }) } },
    path: { join: (...parts) => parts.join('/') },
    Application: { suspendEvent: 'suspend', exitEvent: 'exit', on: (name, fn) => (h.events[name] ??= []).push(fn) },
  };
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [h.now])); } }
  const fakeConsole = { log: (...a) => h.printed.push(a), info: (...a) => h.printed.push(a), warn: (...a) => h.printed.push(a), error: (...a) => h.printed.push(a) };
  let reportListener = null;
  h.module = loader({
    Date: FakeDate, console: fakeConsole,
    setTimeout: (fn, ms) => { const t = { fn, at: h.now + (ms ?? 0) }; h.timers.push(t); return t; },
    clearTimeout: t => { h.timers = h.timers.filter(x => x !== t); },
    UIDevice: { currentDevice: { systemVersion: '26.4', model: 'iPhone' } },
    UIBackgroundTaskInvalid: 0,
    UIApplication: { sharedApplication: { beginBackgroundTaskWithExpirationHandler: () => { h.tasks.push('begin'); return 7; }, endBackgroundTask: task => h.tasks.push(`end ${task}`) } },
  }, {
    '@nativescript/core': core,
    './error-reports': {
      appBuild: () => '0.8.3 (42)',
      onErrorReport: fn => { reportListener = fn; return () => {}; },
      // Must never be called: a send failure reported here would come back through the channel.
      reportError: (...args) => h.reports.push(args),
    },
    './callback-errors.ios': { guardCallback: (_where, run) => run() },
  })('app/native/remote-log.ios.ts');
  h.console = fakeConsole;
  h.install = () => h.module.installRemoteLog({ url: () => h.url, secretValues: () => h.secrets });
  h.fileReport = report => reportListener(report, true);
  /** Advance the clock by [ms], running due timers (and the promise chains they start). */
  h.advance = async (ms) => {
    const until = h.now + ms;
    for (;;) {
      await new Promise(resolve => setImmediate(resolve));
      const due = h.timers.filter(t => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      h.timers = h.timers.filter(t => t !== due);
      h.now = Math.max(h.now, due.at);
      due.fn();
    }
    h.now = until;
    await new Promise(resolve => setImmediate(resolve));
  };
  h.sentRecords = () => h.requests.flatMap(r => JSON.parse(r.content));
  h.status = () => JSON.parse(JSON.stringify(h.module.remoteLogStatus()));
  h.stored = () => (h.files.get(QUEUE) ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return h;
}

test('off while the URL is empty: nothing is queued, sent or written', async () => {
  const h = harness({ url: '' });
  h.install();
  h.module.remoteLog('test', 'info', 'hello');
  h.console.log('a console line');
  await h.advance(10_000);
  assert.equal(h.requests.length, 0);
  assert.equal(h.files.size, 0);
  assert.equal(h.status().on, false);
  assert.equal(h.status().queued, 0);
  // The original console still prints.
  assert.deepEqual(h.printed, [['a console line']]);
});

test('lines are batched into one POST of a JSON array to <url>/log every 2 s', async () => {
  const h = harness({ url: 'https://sink.example/abc/' });
  h.install();
  h.module.remoteLog('test', 'info', 'one');
  h.console.warn('[ble-scan] two', { n: 2 });
  // Forwarded where they are made (release builds strip console calls).
  h.console.error('[error-report] three');
  h.console.log('[ios-ble] four');
  await h.advance(1_900);
  assert.equal(h.requests.length, 0);
  await h.advance(200);
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.url, 'https://sink.example/abc/log');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['Content-Type'], 'application/json');
  const records = JSON.parse(request.content);
  // The session line first, then the lines; console "[error-report]" copies come through the listener instead.
  assert.deepEqual(records.map(r => [r.source, r.level, r.msg]), [
    ['remote-log', 'info', 'session start'], ['test', 'info', 'one'], ['ble-scan', 'warn', 'two {"n":2}']]);
  assert.deepEqual(records[0].data, { build: '0.8.3 (42)', ios: '26.4', model: 'iPhone', session: records[0].session });
  for (const [i, r] of records.entries()) {
    assert.equal(r.seq, i + 1);
    assert.equal(r.session, records[0].session);
    assert.equal(r.build, '0.8.3 (42)');
    assert.equal(r.ts, '2026-10-17T12:00:00.000Z');
  }
  assert.equal(h.status().sent, 3);
  assert.equal(h.status().queued, 0);
  assert.equal(h.status().lastSuccessAt, '2026-10-17T12:00:02.000Z');
});

test('50 waiting lines go out at once, without waiting for the tick', async () => {
  const h = harness();
  h.install();
  for (let i = 0; i < 49; i++) h.module.remoteLog('test', 'info', `line ${i}`);
  await h.advance(0);
  assert.equal(h.requests.length, 1);
  assert.equal(JSON.parse(h.requests[0].content).length, 50);
});

test('error reports are forwarded with their stack, at counts 1, 2, 4, 8', async () => {
  const h = harness();
  h.install();
  for (let count = 1; count <= 5; count++) h.fileReport({ source: 'ble', message: 'boom', stack: 'at x', context: { a: '1' }, count, at: 't' });
  await h.advance(2_000);
  const reports = h.sentRecords().filter(r => r.source === 'error-report');
  assert.deepEqual(reports.map(r => r.data.count), [1, 2, 4]);
  assert.equal(reports[0].msg, 'ble: boom');
  assert.equal(reports[0].level, 'error');
  assert.deepEqual(reports[0].data, { stack: 'at x', context: { a: '1' }, count: 1, at: 't' });
});

test('a failed send retries with backoff doubling to 60 s, and never files an error report', async () => {
  const h = harness();
  h.respond = () => Promise.reject(new Error('The Internet connection appears to be offline.'));
  h.install();
  h.module.remoteLog('test', 'info', 'one');
  const attempts = [];
  for (let t = 0; t <= 300_000; t += 1_000) { const before = h.requests.length; await h.advance(1_000); if (h.requests.length > before) attempts.push(h.now - Date.parse('2026-10-17T12:00:00Z')); }
  const gaps = attempts.slice(1).map((at, i) => at - attempts[i]);
  assert.deepEqual(gaps.slice(0, 6), [2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
  assert.ok(gaps.slice(5).every(gap => gap === 60_000), String(gaps));
  assert.equal(h.reports.length, 0);
  const status = h.status();
  assert.match(status.lastError, /^sending: The Internet connection appears to be offline\.$/);
  assert.equal(status.queued, 2);
  assert.equal(status.sent, 0);
  // An HTTP error status is a failure too; back online, the queue drains and the delay resets.
  h.respond = () => Promise.resolve({ statusCode: 404 });
  await h.advance(60_000);
  assert.match(h.status().lastError, /HTTP 404/);
  h.respond = () => Promise.resolve({ statusCode: 200 });
  await h.advance(60_000);
  assert.equal(h.status().queued, 0);
  assert.equal(h.status().sent, 2);
  assert.equal(h.status().retryInMs, 0);
  assert.equal(h.reports.length, 0);
});

test('Send Test Line sends now, without waiting out the retry delay', async () => {
  const h = harness();
  h.respond = () => Promise.reject(new Error('offline'));
  h.install();
  h.module.remoteLog('test', 'info', 'one');
  for (let i = 0; i < 5; i++) await h.advance(30_000);
  assert.ok(h.status().retryInMs > 0);
  h.respond = () => Promise.resolve({ statusCode: 200 });
  const before = h.requests.length;
  h.module.sendRemoteLogTest();
  await h.advance(0);
  assert.equal(h.requests.length, before + 1);
  assert.equal(h.status().queued, 0);
  assert.ok(h.sentRecords().some(r => r.source === 'remote-log' && /test line/.test(r.msg)));
});

test('the queue is capped at 5000 lines: the oldest go first and are counted', async () => {
  const h = harness();
  h.respond = () => Promise.reject(new Error('offline'));
  h.install();
  for (let i = 0; i < 6_000; i++) h.module.remoteLog('test', 'info', `line ${i}`);
  const status = h.status();
  assert.ok(status.queued <= 5_000 && status.queued >= 4_500, String(status.queued));
  assert.equal(status.dropped, 6_001 - status.queued);
  await h.advance(2_000);
  // The newest line survives.
  assert.equal(h.stored().at(-1).msg, 'line 5999');
  assert.equal(h.stored().length, status.queued);
});

test('the queue is capped at about 2 MB', () => {
  const h = harness();
  h.respond = () => Promise.reject(new Error('offline'));
  h.install();
  const big = 'x'.repeat(20_000);
  for (let i = 0; i < 200; i++) h.module.remoteLog('test', 'info', big);
  const status = h.status();
  assert.ok(status.queued < 100 && status.queued > 80, String(status.queued));
  assert.ok(status.dropped > 0);
});

test('queued lines survive a relaunch and go out next session', async () => {
  const files = new Map();
  const first = harness({ files });
  first.respond = () => Promise.reject(new Error('offline'));
  first.install();
  first.module.remoteLog('test', 'info', 'before the crash');
  await first.advance(1_000);
  // Saved by the 2 s tick, which also tries (and fails) to send.
  await first.advance(1_000);
  assert.deepEqual(first.stored().map(r => r.msg), ['session start', 'before the crash']);
  // A torn last line from a crash mid-write is skipped.
  files.set(QUEUE, files.get(QUEUE) + '{"ts":"2026');

  const second = harness({ files });
  second.install();
  await second.advance(2_000);
  const msgs = second.sentRecords().map(r => r.msg);
  assert.deepEqual(msgs, ['session start', 'before the crash', 'session start']);
  const sessions = new Set(second.sentRecords().map(r => r.session));
  assert.equal(sessions.size, 2);
  // Sent lines leave the file.
  assert.deepEqual(second.stored(), []);
});

test('going to the background saves the queue and sends it', async () => {
  const h = harness();
  h.install();
  h.module.remoteLog('test', 'info', 'one');
  for (const fn of h.events.suspend) fn();
  assert.equal(h.stored().length, 2);
  assert.equal(h.requests.length, 1);
  await h.advance(0);
  assert.equal(h.status().queued, 0);
  assert.deepEqual(h.tasks, ['begin', 'end 7']);
});

test('API key values are replaced with [redacted] before a line is queued', async () => {
  const key = 'sk-ant-api03-SECRETSECRET';
  const h = harness({ secrets: [key, 'short', ''] });
  h.respond = () => Promise.reject(new Error('offline'));
  h.install();
  h.module.remoteLog('test', 'info', `Authorization: Bearer ${key}`, { header: `x-api-key ${key}`, short: 'short' });
  h.console.log('key is', key);
  await h.advance(2_000);
  const stored = h.files.get(QUEUE);
  assert.ok(!stored.includes(key), stored);
  assert.ok(!h.requests.some(r => r.content.includes(key)));
  const records = h.stored();
  assert.equal(records[1].msg, 'Authorization: Bearer [redacted]');
  assert.deepEqual(records[1].data, { header: 'x-api-key [redacted]', short: 'short' });
  assert.equal(records[2].msg, 'key is [redacted]');
});

test('an oversized line is truncated, not dropped', () => {
  const h = harness();
  h.install();
  h.module.remoteLog('test', 'info', 'y'.repeat(100_000), { blob: 'z'.repeat(100_000) });
  for (const fn of h.events.exit) fn();
  const record = h.stored()[1];
  assert.equal(record.msg.length, 16_000);
  assert.equal(typeof record.data, 'string');
  assert.ok(record.truncated > 200_000);
  assert.ok(h.files.get(QUEUE).split('\n')[1].length <= 33_000);
});
