const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');
const { loadModel, generate } = require('../scripts/check-native-names.cjs');

const SWIFT = 'App_Resources/iOS/src/FaceclawTranslate.swift';
const read = file => fs.readFileSync(file, 'utf8');

test('FaceclawTranslate exposes the four calls, typed, with no Translation type in its @objc surface', () => {
  const swift = read(SWIFT);
  const selectors = [...swift.matchAll(/@objc\(([\w:]+)\)\s+public static func/g)].map(m => m[1]);
  assert.deepEqual(selectors, ['translateText:source:target:completion:', 'statusSource:target:completion:',
    'prepareSource:target:completion:', 'supportedLanguages:']);
  for (const line of swift.split('\n').filter(l => /@objc|public static func/.test(l))) {
    assert.doesNotMatch(line, /TranslationSession|LanguageAvailability|Locale|TranslationError/, line);
  }
  const types = generate(loadModel('native/kotlin/FaceclawKit.h.snapshot'));
  const decl = types.slice(types.indexOf('declare class FaceclawTranslate '), types.indexOf('declare class FaceclawTranslateSpike '));
  assert.match(decl, /static translateTextSourceTargetCompletion\(text: string, source: string, target: string, done: \(p0: string\) => void\): void;/);
  assert.match(decl, /static statusSourceTargetCompletion\(source: string, target: string, done: \(p0: string\) => void\): void;/);
  assert.match(decl, /static prepareSourceTargetCompletion\(source: string, target: string, done: \(p0: string \| null\) => void\): void;/);
  assert.match(decl, /static supportedLanguages\(done: \(p0: string\) => void\): void;/);
  // The spike's file-private sheet types keep their names; these are distinct.
  assert.doesNotMatch(swift, /\b(PrepareState|PrepareView|PrepareTask)\b/);
});

test('FaceclawTranslate picks lowLatency only when installed and re-checks after a failure or a download', () => {
  const swift = read(SWIFT);
  const run = swift.split('private static func run(')[1].split('\n  private static func forget(')[0];
  assert.match(run, /LanguageAvailability\(preferredStrategy: \.lowLatency\)\.status\(from: from, to: to\)/);
  assert.match(run, /if case \.installed = status \{ low = true \}/);
  assert.match(run, /TranslationSession\(installedSource: from, target: to, preferredStrategy: low \? \.lowLatency : \.highFidelity\)/);
  // A new session that is not ready, and any failed translate, forget the pair.
  assert.match(run, /if fresh, !\(await session\.isReady\) \{\n\s+forget\(pair\)/);
  assert.match(run, /\} catch \{\n.*\n\s+forget\(pair\)/);
  assert.match(run, /"notInstalled": TranslationError\.notInstalled ~= error/);
  // A stuck translate is cancelled so its pair's queue moves on; the session is dropped first so a
  // simultaneous success cannot leave it cached, and only the watchdog firing reads as a timeout.
  assert.match(run, /if Task\.isCancelled \{ return false \}\n\s+forget\(pair\)\n\s+session\.cancel\(\)\n\s+return true/);
  assert.match(run, /timedOut = await watchdog\.value/);
  assert.doesNotMatch(run, /ms >= Double\(translateLimitNs\)/);
  const forget = swift.split('private static func forget(')[1].split('\n  }\n')[0];
  for (const key of ['fast.removeValue(forKey: pair)', '"\\(pair)|lowLatency"', '"\\(pair)|highFidelity"']) assert.ok(forget.includes(key), key);
  // Calls for one pair queue behind each other.
  assert.match(swift, /let previous = tails\[pair\]\n\s+tails\[pair\] = Task \{\n\s+await previous\?\.value/);
  // ...but one that waited past its JS caller's patience is skipped, so a backlog drains.
  assert.match(swift, /await previous\?\.value\n\s+let out: String\n\s+if DispatchTime\.now\(\)\.uptimeNanoseconds - queued > staleNs \{\n\s+out = json\(\["error": "stale/);
  const prepare = swift.split('public static func prepare(')[1].split('\n  }\n')[0];
  assert.match(prepare, /forget\("\\\(source\)>\\\(target\)"\)/);
});

test('the prepare sheet is lowLatency, cancellable, dismisses only once presented, and does not wait on prepareTranslation alone', () => {
  const swift = read(SWIFT);
  assert.match(swift, /\.translationTask\(source: source, target: target, preferredStrategy: \.lowLatency\)/);
  assert.match(swift, /Button\("Cancel"\) \{ finish\("cancelled on the phone"\) \}/);
  assert.match(swift, /top\.present\(host, animated: true\) \{ MainActor\.assumeIsolated \{ state\.presented\(\) \} \}/);
  // A present from a controller mid-transition (the last sheet still closing) or onto a prepare
  // sheet still up is waited out, else fails fast, instead of being refused silently.
  assert.match(swift, /await presentPrepare\(/);
  assert.match(swift, /guard let busy = found, !presentable\(busy\) else \{ break \}/);
  assert.match(swift, /guard presentable\(top\) else \{ return done\(/);
  assert.match(swift, /!top\.isBeingDismissed && !top\.isBeingPresented\n\s+&& !\(top is UIHostingController<TranslatePrepareView>\)/);
  assert.match(swift, /if shown \{ host\?\.dismiss\(animated: true\) \}\n\s+guard let report = done else \{ return \}\n\s+done = nil/);
  assert.match(swift, /if await FaceclawTranslate\.installed\(source, target\) \{\n\s+await MainActor\.run \{ finish\(nil\) \}/);
  // Logs reach FaceclawLog (no bridging header: looked up at run time), never NSLog.
  assert.match(swift, /NSClassFromString\("FaceclawLog"\)/);
  assert.doesNotMatch(swift, /\bNSLog\(|\bprint\(/);
});

/** The wrapper with FaceclawTranslate mocked; calls[name] records each native call's arguments and completion. */
function wrapper(native = {}) {
  const calls = {};
  const timers = [];
  const record = name => (...args) => { (calls[name] ||= []).push(args); native[name]?.(...args); };
  const shim = native === null ? undefined : {
    translateTextSourceTargetCompletion: record('translate'),
    statusSourceTargetCompletion: record('status'),
    prepareSourceTargetCompletion: record('prepare'),
    supportedLanguages: record('languages'),
  };
  const globals = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  if (shim) globals.FaceclawTranslate = shim;
  const guarded = [];
  const mod = loader(globals, { './callback-errors.ios': { guardCallback: (where, run) => { guarded.push(where); return run(); } } })(
    'app/native/apple-translate.ios.ts');
  const fire = () => { for (const timer of timers.splice(0)) timer.fn?.(); };
  return { mod, calls, timers, fire, guarded };
}

test('translateText parses the answer and resolves (never rejects) on a timeout, a bad answer or a throw', async () => {
  const { mod, calls, timers, fire, guarded } = wrapper();
  assert.equal(mod.appleTranslateAvailable(), true);
  const ok = mod.translateText('hola', 'es', 'en');
  const [text, source, target, done] = calls.translate[0];
  assert.deepEqual([text, source, target, timers[0].ms], ['hola', 'es', 'en', 8000]);
  done('{"out":"hello","strategy":"lowLatency","ms":24}');
  assert.deepEqual({ ...await ok }, { out: 'hello', strategy: 'lowLatency', ms: 24 });
  assert.deepEqual(guarded, ['apple-translate.translate']);
  assert.equal(timers[0].fn, null, 'the answer clears the timer');

  const failed = mod.translateText('x', 'es', 'en');
  calls.translate[1][3]('{"error":"not installed","notInstalled":true,"ms":3}');
  assert.deepEqual({ ...await failed }, { error: 'not installed', notInstalled: true, ms: 3 });

  const late = mod.translateText('x', 'es', 'en', 500);
  assert.equal(timers.at(-1).ms, 500);
  fire();
  assert.equal((await late).error, 'timeout');
  calls.translate[2][3]('{"out":"too late","ms":1}'); // a late answer is ignored

  const garbled = mod.translateText('x', 'es', 'en');
  calls.translate[3][3]('not json');
  assert.match((await garbled).error, /unreadable answer/);

  // Empty text never reaches native code.
  assert.deepEqual({ ...await mod.translateText('  ', 'es', 'en') }, { out: '', ms: 0 });
  assert.equal(calls.translate.length, 4);

  const throwing = wrapper({ translate: () => { throw new Error('boom'); } });
  assert.match((await throwing.mod.translateText('x', 'es', 'en')).error, /boom/);
});

test('status, prepare and languages map answers, timeouts and junk', async () => {
  const { mod, calls, timers, fire } = wrapper();
  const status = mod.translationStatus('es', 'en');
  calls.status[0][2]('{"lowLatency":"supported","highFidelity":"installed"}');
  assert.deepEqual({ ...await status }, { lowLatency: 'supported', highFidelity: 'installed' });
  const odd = mod.translationStatus('es', 'en');
  calls.status[1][2]('{"lowLatency":"bad pair"}');
  assert.deepEqual({ ...await odd }, { lowLatency: 'unknown', highFidelity: 'unknown' });

  const prepared = mod.prepareTranslation('es', 'en');
  assert.equal(timers.at(-1).ms, 180000);
  calls.prepare[0][2](null);
  assert.equal(await prepared, null);
  const cancelled = mod.prepareTranslation('es', 'en');
  calls.prepare[1][2]('cancelled on the phone');
  assert.equal(await cancelled, 'cancelled on the phone');
  const stuck = mod.prepareTranslation('es', 'en', 1000);
  fire();
  assert.equal(await stuck, 'timeout');

  const languages = mod.translationLanguages();
  calls.languages[0][0]('{"languages":["en","es","zh-Hans"]}');
  assert.deepEqual([...await languages], ['en', 'es', 'zh-Hans']);
});

test('without the Swift shim every call resolves as unavailable', async () => {
  const { mod } = wrapper(null);
  assert.equal(mod.appleTranslateAvailable(), false);
  assert.match((await mod.translateText('hola', 'es', 'en')).error, /FaceclawTranslate/);
  assert.deepEqual({ ...await mod.translationStatus('es', 'en') }, { lowLatency: 'unsupported', highFidelity: 'unsupported' });
  assert.match(await mod.prepareTranslation('es', 'en'), /FaceclawTranslate/);
  assert.deepEqual([...await mod.translationLanguages()], []);
});

test('the non-iOS stub has the iOS exports and says unavailable', async () => {
  const stub = loader()('app/native/apple-translate.ts');
  const ios = wrapper().mod;
  assert.deepEqual(Object.keys(stub).sort(), Object.keys(ios).sort());
  assert.equal(stub.appleTranslateAvailable(), false);
  assert.ok((await stub.translateText('hola', 'es', 'en')).error);
  assert.ok(await stub.prepareTranslation('es', 'en'));
  assert.deepEqual([...await stub.translationLanguages()], []);
});
