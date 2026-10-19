const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');
const { generated } = require('../scripts/check-native-names.cjs');

const SWIFT = 'App_Resources/iOS/src/FaceclawLiveTranscriber.swift';
const swift = fs.readFileSync(SWIFT, 'utf8');
/** A Swift func's body, from its signature to the next member at the same indent. */
const body = (signature, indent = '  ') => swift.split(signature)[1].split(new RegExp(`\\n${indent}(?:@objc|(?:fileprivate |private )?(?:static )?func )`))[0];

test('the Swift class exposes the selectors live-transcriber.ios.ts calls, typed for tsc', () => {
  const block = generated().split('declare class FaceclawLiveTranscriber extends NSObject {')[1].split('\n}\n')[0];
  const members = block.trim().split('\n').map(line => line.trim()).filter(line => !/^static (alloc|new)\(\)/.test(line));
  assert.deepEqual(members, [
    'static statusLanguageCompletion(language: string, done: (p0: string) => void): void;',
    'static installLanguageCompletion(language: string, done: (p0: string | null) => void): void;',
    'static startLanguageEvents(language: string, events: (p0: string) => void): number;',
    'static acceptHandlePcm(handle: number, pcm: NSData): void;',
    'static finishHandle(handle: number): void;',
    'static finalizeHandleThrough(handle: number, seconds: number): void;',
    'static cancelHandle(handle: number): void;',
  ]);
  // Speech, AVFoundation and Locale stay out of the @objc surface (faceclaw-Swift.h never imports them).
  for (const line of swift.split('\n').filter(l => l.includes('@objc'))) {
    assert.doesNotMatch(line, /Speech|Analyzer|AssetInventory|Locale|AVAudio|CMTime/, line);
  }
});

test('the Swift side uses only iOS 26 SDK API, as documented', () => {
  // init(priority:modelRetention:ignoresResourceLimits:) is iOS 27: CI builds with the 26.5 SDK.
  assert.doesNotMatch(swift, /ignoresResourceLimits/);
  assert.match(swift, /SpeechTranscriber\(locale: locale, transcriptionOptions: \[\], reportingOptions: \[\.volatileResults\],\s+attributeOptions: \[\.audioTimeRange, \.transcriptionConfidence\]\)/);
  assert.match(swift, /SpeechAnalyzer\.Options\(priority: \.userInitiated, modelRetention: \.lingering\)/);
  assert.match(swift, /SpeechAnalyzer\.bestAvailableAudioFormat\(compatibleWith: \[transcriber\], considering: source\)/);
  assert.match(swift, /AsyncStream\.makeStream\(of: AnalyzerInput\.self\)/);
  assert.match(swift, /try await analyzer\.start\(inputSequence: stream\)/);
  assert.match(swift, /try await analyzer\?\.finalizeAndFinishThroughEndOfInput\(\)/);
  // finalize(through: CMTime?) async throws (iOS 26.0): Listen forces finals at each pause it detects.
  assert.match(swift, /try await analyzer\.finalize\(through: time\)/);
  assert.equal(swift.match(/try await analyzer\.cancelAndFinishNow|try analyzer\.cancelAndFinishNow/g), null, 'cancelAndFinishNow is async, not throws');
  assert.doesNotMatch(swift, /NSLog/);
});

test('times come from the samples fed, and audio is never resampled with priming', () => {
  const feed = body('  private func feed(');
  assert.match(feed, /let start = CMTime\(value: fed, timescale: CMTimeScale\(format\.sampleRate\)\)\n\s+fed \+= Int64\(converted\.frameLength\)\n\s+input\?\.yield\(AnalyzerInput\(buffer: converted, bufferStartTime: start\)\)/);
  assert.match(swift, /converter\?\.primeMethod = \.none/);
  // PCM held while starting is fed in order once running; what the 10 s hold drops still counts as time.
  const ready = swift.split('phase = .running')[1].split('if finishRequested')[0];
  assert.ok(ready.indexOf('fed = frames(forSourceSamples: skippedSamples)') < ready.indexOf('for chunk in pending { feed(chunk) }'));
  assert.match(swift, /private static let maxPendingBytes = 10 \* 32_000/);
});

test('only installLanguage downloads, and a session needs an installed model', () => {
  assert.equal(swift.match(/assetInstallationRequest\(supporting:/g).length, 1);
  assert.match(body('  private static func installAssets('), /assetInstallationRequest\(supporting: \[module\]\)[\s\S]*downloadAndInstall\(\)/);
  // downloadAndInstall may return early: the status is polled after it.
  assert.match(body('  private static func installAssets('), /downloadAndInstall\(\)[\s\S]*for _ in 0\.\.<240 \{\n\s+switch await AssetInventory\.status/);
  assert.match(body('  private func setUp('), /guard await AssetInventory\.status\(forModules: \[transcriber\]\) == \.installed else \{\n\s+return "The \\\(tag\) speech recognition model is not downloaded\."/);
  // supportedLocale(equivalentTo:) can echo a tag it cannot transcribe.
  assert.match(body('  fileprivate static func supportedLocale('), /\(supported \+ installed\)\.contains \{ \$0\.identifier\(\.bcp47\) == tag \}/);
});

test('our language ids map to the contract\'s default regions', () => {
  const map = Object.fromEntries([...swift.split('private static let regions = [')[1].split(']')[0].matchAll(/"([\w-]+)": "([\w-]+)"/g)].map(m => [m[1], m[2]]));
  assert.deepEqual(map, { en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-BR', ja: 'ja-JP', ko: 'ko-KR', 'zh-Hans': 'zh-CN' });
});

test('events go out through the session queue, and nothing follows ended', () => {
  const post = body('  private func post(_ line: String)');
  assert.match(post, /guard phase != \.ended else \{ return \}/);
  assert.match(post, /DispatchQueue\.main\.async \{ events\(line\) \}/);
  const end = body('  private func end()');
  assert.match(end, /guard phase != \.ended else \{ return \}\n\s+post\(\["kind": "ended"\]\)\n\s+phase = \.ended/);
  assert.match(end, /FaceclawLiveTranscriber\.forget\(handle\)/);
  // Every result arrives off-queue and hops onto it; the stream's end ends the session.
  assert.match(body('  private func read('), /queue\.async \{ \[self\] in post\(line\) \}[\s\S]*end\(\)/);
  // A finalize that hangs still ends.
  assert.match(body('  private func beginFinish('), /queue\.asyncAfter\(deadline: \.now\(\) \+ 15\)/);
});

test('a cancelled read stays silent, so setUp\'s own startup error reaches JS', () => {
  const read = body('  private func read(');
  assert.match(read, /\}\n\s+\/\/ Whoever cancelled[^\n]*\n\s+if Task\.isCancelled \{ return \}\n\s+let message = failure\n\s+queue\.async/);
});

test('a session reserves its installed locale, and reservations of the pair are kept', () => {
  assert.match(body('  private func setUp('), /== \.installed else \{[^}]*\}\n\s+await FaceclawLiveTranscriber\.keepReserved\(locale\)/);
  const keep = body('  fileprivate static func keepReserved(');
  assert.match(keep, /remember\(locale\)[\s\S]*guard !reserved\.contains[\s\S]*await makeRoom\(for: locale\)\n\s+do \{ try await AssetInventory\.reserve\(locale: locale\) \}/);
  assert.match(body('  private static func installAssets('), /remember\(locale\)\n\s+do \{/);
  assert.match(body('  private static func remember('), /\.suffix\(2\)/);
  assert.match(body('  private static func makeRoom('), /code\(Locale\(identifier: regions\[\$0\.language\] \?\? \$0\.language\)\) \} \+ recent\)/);
  const describe = body('  fileprivate static func describe(');
  for (const code of ['insufficientResources', 'assetLocaleNotAllocated', 'tooManyAssetLocalesAllocated', 'noModel']) {
    assert.match(describe, new RegExp(`case SFSpeechError\\.Code\\.${code}\\.rawValue:\\n\\s+return "`), code);
  }
});

test('logging calls +[FaceclawLog log:] through its IMP, as FaceclawTranslate does', () => {
  assert.doesNotMatch(swift, /\.perform\(/);
  assert.match(swift, /private typealias LogFunction = @convention\(c\) \(AnyClass, Selector, NSString\) -> Void/);
  assert.match(swift, /fileprivate static func note\(_ message: String\) \{ logLine\?\("speech: \\\(message\)"\) \}/);
});

/** live-transcriber.ios.ts over a stand-in FaceclawLiveTranscriber. */
function wrapper({ native = true, handle = 7 } = {}) {
  const calls = [], reported = [], timers = [];
  const fake = {
    statusLanguageCompletion: (language, done) => { calls.push(['status', language]); fake.statusDone = done; },
    installLanguageCompletion: (language, done) => { calls.push(['install', language]); fake.installDone = done; },
    startLanguageEvents: (language, events) => { calls.push(['start', language]); fake.events = events; return handle; },
    acceptHandlePcm: (h, pcm) => calls.push(['accept', h, pcm]),
    finishHandle: h => calls.push(['finish', h]),
    cancelHandle: h => calls.push(['cancel', h]),
  };
  const globals = {
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  };
  if (native) globals.FaceclawLiveTranscriber = fake;
  const mod = loader(globals, {
    './callback-errors.ios': {
      guardCallback: (where, run) => { try { return run(); } catch (error) { reported.push([where, String(error)]); return undefined; } },
      logJsError: (where, error) => reported.push([where, String(error)]),
    },
    './kotlin-data': { toData: bytes => ({ nsdata: Array.from(bytes) }) },
  })('app/native/live-transcriber.ios.ts');
  return { mod, fake, calls, reported, timers };
}

test('a transcriber forwards PCM and events until ended, then goes quiet', () => {
  const { mod, fake, calls, reported } = wrapper();
  assert.equal(mod.liveTranscriberAvailable(), true);
  const events = [];
  const t = mod.startLiveTranscriber('es', e => events.push(e));
  assert.equal(t.language, 'es');
  t.accept(new Uint8Array([1, 2, 3, 4]));
  t.accept(new Uint8Array([9]));  // under one sample: not sent
  fake.events('{"kind":"ready","locale":"es-ES"}');
  fake.events('{"conf":0.9,"end":1.5,"kind":"final","start":0.2,"text":"hola"}');
  fake.events('not json');
  t.finish();
  fake.events('{"kind":"ended"}');
  fake.events('{"kind":"partial","text":"late","conf":-1,"start":0,"end":0}');
  t.accept(new Uint8Array([5, 6]));
  t.finish();
  t.cancel();
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    { kind: 'ready', locale: 'es-ES' },
    { conf: 0.9, end: 1.5, kind: 'final', start: 0.2, text: 'hola' },
    { kind: 'ended' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['start', 'es'], ['accept', 7, { nsdata: [1, 2, 3, 4] }], ['finish', 7]]);
  assert.equal(reported.length, 1);
  assert.equal(reported[0][0], 'live-transcriber.event');
});

test('no native class or no handle: no transcriber', () => {
  assert.equal(wrapper({ native: false }).mod.startLiveTranscriber('es', () => {}), null);
  assert.equal(wrapper({ native: false }).mod.liveTranscriberAvailable(), false);
  assert.equal(wrapper({ handle: 0 }).mod.startLiveTranscriber('es', () => {}), null);
});

test('install never rejects; status rejects only on a timeout (unknown, not unsupported)', async () => {
  const w = wrapper();
  const status = w.mod.speechLanguageStatus('ja');
  w.fake.statusDone('{"installed":false,"locale":"ja-JP","supported":true}');
  assert.deepEqual(JSON.parse(JSON.stringify(await status)), { supported: true, installed: false, locale: 'ja-JP' });
  assert.equal(w.timers[0].ms, 15_000);
  assert.equal(w.timers[0].cleared, true);

  const slow = w.mod.speechLanguageStatus('ko', 50);
  w.timers[1].fn();
  w.fake.statusDone('{"installed":true,"locale":"ko-KR","supported":true}');  // too late: ignored
  await assert.rejects(slow, /timed out/);

  const ok = w.mod.installSpeechLanguage('fr');
  assert.equal(w.timers[2].ms, 300_000);
  w.fake.installDone(null);
  assert.equal(await ok, null);
  const failed = w.mod.installSpeechLanguage('fr');
  w.fake.installDone('no network');
  assert.equal(await failed, 'no network');
  const hung = w.mod.installSpeechLanguage('fr', 10);
  w.timers[4].fn();
  assert.equal(await hung, 'timeout');

  const none = wrapper({ native: false }).mod;
  assert.deepEqual(JSON.parse(JSON.stringify(await none.speechLanguageStatus('es'))), { supported: false, installed: false, locale: '' });
  assert.match(await none.installSpeechLanguage('es'), /no live speech/);
});

test('the non-iOS stub has the same exports and offers nothing', async () => {
  const stub = loader()('app/native/live-transcriber.ts');
  assert.deepEqual(Object.keys(stub).sort(), Object.keys(wrapper().mod).sort());
  assert.equal(stub.liveTranscriberAvailable(), false);
  assert.equal(stub.startLiveTranscriber('es', () => {}), null);
  assert.equal((await stub.speechLanguageStatus('es')).installed, false);
  assert.equal(typeof await stub.installSpeechLanguage('es'), 'string');
});
