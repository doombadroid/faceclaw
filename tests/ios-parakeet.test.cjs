const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');

const read = file => fs.readFileSync(file, 'utf8');
// The CI recipe repo sits next to the checkout (or next to the worktree root).
const BUILD_YML = ['../faceclaw-ios-build', '../../faceclaw-ios-build']
  .map(dir => path.join(dir, '.github/workflows/build.yml')).find(file => fs.existsSync(file));

test('every place that sets the minimum iOS says 17.0, which FluidAudio needs', () => {
  assert.match(read('App_Resources/iOS/build.xcconfig'), /^IPHONEOS_DEPLOYMENT_TARGET = 17\.0;$/m);
  assert.doesNotMatch(read('App_Resources/iOS/build.xcconfig'), /iOS 15/);
  assert.match(read('App_Resources/iOS/Podfile'), /^platform :ios, '17\.0'$/m);
  if (!BUILD_YML) return;
  const yml = read(BUILD_YML);
  assert.deepEqual([...yml.matchAll(/IPHONEOS_DEPLOYMENT_TARGET=([\d.]+)/g)].map(m => m[1]), ['17.0']);
  assert.match(yml, /"minOSVersion": "17\.0"/);
  // The ObjC loader imports faceclaw-Swift.h: NativeScript names the product after the checkout folder.
  assert.match(yml, /path: faceclaw\s/);
});

test('FluidAudio comes in through SPMPackages at exactly 0.17.7', () => {
  const config = loader({}, { '@nativescript/core': {} })('nativescript.config.ts').default;
  assert.deepEqual(JSON.parse(JSON.stringify(config.ios.SPMPackages)), [{
    name: 'FluidAudio', libs: ['FluidAudio'], repositoryURL: 'https://github.com/FluidInference/FluidAudio.git', version: '0.17.7',
  }]);
});

const SWIFT = 'App_Resources/iOS/src/FaceclawParakeet.swift';
const SHIM = 'App_Resources/iOS/src/FaceclawSherpa.m';
/** The ObjC selectors FaceclawParakeet.swift exports (`@objc(name)` on a static func). */
const swiftSelectors = () => new Set([...read(SWIFT).matchAll(/@objc\(([\w:]+)\)\s+public static func/g)].map(m => m[1]));
/** The method body that follows an ObjC signature in the shim. */
const shimBody = signature => read(SHIM).split(signature)[1].split(/\n}\n/)[0];

test('the Swift wrapper keeps FluidAudio out of its @objc surface and pins the v3 model', () => {
  const swift = read(SWIFT);
  for (const line of swift.split('\n').filter(l => l.includes('@objc'))) {
    assert.doesNotMatch(line, /AsrManager|AsrModels|TdtDecoderState|ASRResult|DownloadProgress|MLComputeUnits/, line);
  }
  assert.match(swift, /revisionOverrides\[repo\] = revision/);
  assert.match(swift, /repo = "FluidInference\/parakeet-tdt-0\.6b-v3-coreml"/);
  assert.match(swift, /revision = "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe"/);
  // v3 with the int8 encoder on FluidAudio's default .cpuAndNeuralEngine (no GPU: background-safe).
  const calls = swift.split('\n').filter(line => /AsrModels\.(load|download|modelsExist)\(/.test(line));
  assert.equal(calls.length, 3);
  for (const call of calls) assert.match(call, /version: \.v3, encoderPrecision: \.int8/, call);
  assert.doesNotMatch(swift, /cpuAndGPU|computeUnits/);
  // The network is used only by an explicit download.
  assert.match(swift, /ModelHub\.offlineMode = true\n  \}\(\)/);
  assert.equal(swift.match(/ModelHub\.offlineMode = false/g).length, 1);
  const download = swift.split('public static func download(')[1].split('\n  }\n')[0];
  assert.match(download, /ModelHub\.offlineMode = false/);
  // A cancelled download's tail neither ends nor takes offline the one that replaced it.
  assert.match(download, /guard downloadGeneration == generation else \{ return false \}\n\s+downloading = nil/);
  assert.match(download, /if newest \{ ModelHub\.offlineMode = true \}/);
  // A captured var cannot cross into a @Sendable closure; the completion gets a let.
  assert.doesNotMatch(download, /async \{ done\(failure\) \}/);
  // Blocking entry points refuse the main thread.
  for (const name of ['recognize', 'loadModel']) {
    assert.match(swift.split(`public static func ${name}(`)[1].split('\n')[1], /guard !Thread\.isMainThread/, name);
  }
});

test('the ObjC loader sends only the Parakeet folder to Swift and keeps voice-prints on sherpa', () => {
  const shim = read(SHIM), selectors = swiftSelectors();
  assert.match(shim, /^#import "faceclaw-Swift\.h"$/m);
  // faceclaw-Swift.h needs NativeScriptEmbedderDelegate declared before it.
  assert.ok(shim.indexOf('#import "NativeScriptEmbedder.h"') >= 0 && shim.indexOf('#import "NativeScriptEmbedder.h"') < shim.indexOf('#import "faceclaw-Swift.h"'));
  // [FaceclawParakeet recognizeSamples:samples dir:_modelDir] -> recognizeSamples:dir:
  const sent = [...shim.matchAll(/\[FaceclawParakeet ([^\]]+)\]/g)].map(([, message]) => [...message.matchAll(/(\w+):/g)].map(m => `${m[1]}:`).join(''));
  assert.deepEqual([...new Set(sent)].sort(), ['isParakeetDir:', 'loadDir:', 'recognizeSamples:dir:']);
  for (const selector of sent) assert.ok(selectors.has(selector), selector);
  const recognizer = shimBody('- (id<FaceclawKitIosPcmRecognizer>)recognizerModelDir:(NSString *)modelDir whisper:(BOOL)whisper {');
  assert.ok(recognizer.indexOf('isParakeetDir:') < recognizer.indexOf('faceclaw_sherpa_recognizer'), 'Parakeet is checked before sherpa');
  assert.doesNotMatch(shimBody('- (id<FaceclawKitIosVoicePrinter>)voicePrinterModelPath:(NSString *)modelPath {'), /Parakeet/);
  // IosOnDeviceTranscriber closes after every capture; the model must stay loaded.
  assert.match(shim, /@implementation FaceclawParakeetRecognizer[\s\S]*?- \(void\)close \{\n\}/);
});

const PARAKEET_DIR = '/M/faceclaw-voice-asr/parakeet-tdt-0.6b-v3-coreml';

/** asr-model.ts over a stand-in FaceclawParakeet (null: Android, no native class). */
function asrModels({ native = true } = {}) {
  const calls = [], fake = { downloaded: false, warm: false, progress: null, done: null };
  const fluid = {
    isDownloadedDir: dir => (calls.push(['downloaded?', dir]), fake.downloaded),
    isWarmDir: dir => (calls.push(['warm?', dir]), fake.warm),
    downloadDirProgressCompletion: (dir, progress, done) => { calls.push(['download', dir]); fake.progress = progress; fake.done = done; },
    warmUpDirCompletion: (dir, done) => { calls.push(['warmUp', dir]); fake.done = done; },
    cancelDownload: () => calls.push(['cancel']),
    deleteDir: dir => calls.push(['delete', dir]),
  };
  const asr = loader({}, {
    './model-downloader': { modelsRoot: () => '/M', isModelFilePresent: () => false, startModelDownload: () => { throw new Error('sherpa path'); },
      deleteModelFiles: () => { throw new Error('sherpa path'); } },
    './parakeet': { fluidNative: () => native ? fluid : null },
  })('app/native/asr-model.ts');
  return { asr, calls, fake };
}

test('Parakeet downloads through FluidAudio into the shared models folder, Preparing until warm', () => {
  const { asr, calls, fake } = asrModels();
  assert.equal(asr.asrModelDir('parakeet-v3'), PARAKEET_DIR);
  assert.equal(asr.ASR_MODELS['parakeet-v3'].totalBytes, 483e6);
  assert.equal(asr.isAsrModelReady('parakeet-v3'), false);
  const states = [];
  asr.onAsrModelStateChanged('parakeet-v3', state => states.push(state.status === 'downloading' ? state.bytesDownloaded : state.status));
  asr.startAsrModelDownload('parakeet-v3');
  assert.deepEqual(calls.filter(c => c[0] === 'download'), [['download', PARAKEET_DIR]]);
  // FluidAudio's fraction restarts per file: the row never steps back.
  fake.progress(0.5); fake.progress(0.2); fake.progress(1);
  assert.deepEqual(states, [0, 241.5e6, 241.5e6, 483e6]);
  // A second tap while it runs starts nothing.
  asr.startAsrModelDownload('parakeet-v3');
  assert.equal(calls.filter(c => c[0] === 'download').length, 1);
  fake.downloaded = true; fake.done(null);
  assert.equal(states.at(-1), 'ready');
  assert.equal(asr.isAsrModelWarm('parakeet-v3'), false);
  fake.warm = true;
  assert.equal(asr.isAsrModelWarm('parakeet-v3'), true);
  asr.deleteAsrModel('parakeet-v3');
  assert.deepEqual(calls.filter(c => c[0] === 'delete'), [['delete', PARAKEET_DIR]]);
});

test('a cancelled Parakeet download keeps its row free for the next one', () => {
  const { asr, calls, fake } = asrModels();
  asr.startAsrModelDownload('parakeet-v3');
  const firstDone = fake.done;
  asr.cancelAsrModelDownload('parakeet-v3');
  assert.equal(calls.filter(c => c[0] === 'cancel').length, 1);
  asr.startAsrModelDownload('parakeet-v3');
  firstDone('Download cancelled.');
  assert.equal(asr.asrModelState('parakeet-v3').status, 'downloading', 'the old completion does not end the new download');
});

test('the launch warm-up runs only for a downloaded, cold model, and never downloads', () => {
  const { asr, calls, fake } = asrModels();
  asr.warmUpAsrModels();
  assert.equal(calls.filter(c => c[0] === 'warmUp' || c[0] === 'download').length, 0);
  fake.downloaded = true; fake.warm = true;
  asr.warmUpAsrModels();
  assert.equal(calls.filter(c => c[0] === 'warmUp').length, 0);
  fake.warm = false;
  asr.warmUpAsrModels();
  assert.deepEqual(calls.filter(c => c[0] === 'warmUp'), [['warmUp', PARAKEET_DIR]]);
  // Moonshine and Whisper are warm whenever they are downloaded.
  assert.equal(asr.isAsrModelWarm('moonshine'), asr.isAsrModelReady('moonshine'));
});

test('without FaceclawParakeet (Android) Parakeet is never ready and never downloads', () => {
  const { asr } = asrModels({ native: false });
  assert.equal(asr.isAsrModelReady('parakeet-v3'), false);
  assert.equal(asr.isAsrModelWarm('parakeet-v3'), false);
  asr.startAsrModelDownload('parakeet-v3');
  assert.equal(asr.asrModelState('parakeet-v3').status, 'absent');
  asr.warmUpAsrModels();
});

test('On-device (Parakeet) maps to the warm model with Moonshine\'s segmenting, else to Apple\'s recognizer', () => {
  let warm = false;
  const calls = [];
  const transcriber = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return transcriber; } });
  const stt = loader({ FaceclawSherpa: { new: () => ({ loader: true }) }, FaceclawKitIosOnDeviceTranscriber: { alloc: () => transcriber },
    FaceclawKitIosTranscriptListener: 'listener' }, {
    './asr-model': { asrModelDir: id => `/Models/${id}`, isAsrModelReady: () => true, isAsrModelWarm: id => warm && id === 'parakeet-v3' },
    './kotlin-data': {}, './kotlin-listener.ios': { kotlinListener: (_, methods) => methods },
  })('app/native/onboard-stt.ios.ts');
  assert.equal(stt.onboardModel('onboard-parakeet'), null);
  warm = true;
  assert.equal(stt.onboardModel('onboard-parakeet'), 'parakeet-v3');
  assert.equal(stt.onboardModel('onboard'), null);
  stt.createOnboardSttClient('parakeet-v3', { onTranscript() {}, onStatus() {}, onError() {} });
  // The same FaceclawSherpa loader (it routes the folder), with whisper=false.
  assert.deepEqual(calls[0].slice(1, 4), [{ loader: true }, '/Models/parakeet-v3', false]);
});

/** dashboard-settings.ts over an in-memory store, as in display-layout-setting.test.cjs. */
function settings(isIOS, store = new Map()) {
  const vm = require('node:vm'), ts = require('typescript');
  const context = { exports: {}, global: { isIOS }, setTimeout: fn => fn(), require: id => {
    if (id.includes('settings-store')) return { onSettingsStoreChanged() {}, getStringSetting: (k, d) => store.get(k) ?? d,
      setStringSetting: (k, v) => store.set(k, v), getBooleanSetting: (k, d) => store.get(k) ?? d, setBooleanSetting: (k, v) => store.set(k, v) };
    if (id.includes('brightness-curve')) return require('../.test-build/app/g2/brightness-curve.js');
    if (id.includes('animation-speed')) return require('../.test-build/app/ui/animation-speed.js');
    if (id.includes('branding')) return { APP_NAME: 'OcuSmart' };
    return { Layer: class {}, ASSISTANT_MODEL_CHOICES: [] };
  } };
  vm.runInNewContext(ts.transpileModule(read('app/ui/dashboard-settings.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return context.exports;
}

test('iOS defaults to On-device (Parakeet) and moves the old Apple default over once; Android is unchanged', () => {
  const fresh = settings(true).voiceProviderSetting;
  assert.equal(fresh.get(), 'onboard-parakeet');
  assert.equal(fresh.displayValue('onboard-parakeet'), 'On-device (Parakeet)');
  assert.equal(fresh.isDisabled('onboard-parakeet'), false, 'pickable before the download: it falls back to Apple');
  const store = new Map([['voice.provider', 'onboard']]);
  const ios = settings(true, store);
  ios.migrateIosVoiceProvider();
  assert.equal(ios.voiceProviderSetting.get(), 'onboard-parakeet');
  // Picking Apple again afterwards sticks.
  ios.voiceProviderSetting.set('onboard');
  settings(true, store).migrateIosVoiceProvider();
  assert.equal(store.get('voice.provider'), 'onboard');
  // Another explicit choice is never touched.
  const moonshine = new Map([['voice.provider', 'onboard-moonshine']]);
  settings(true, moonshine).migrateIosVoiceProvider();
  assert.equal(moonshine.get('voice.provider'), 'onboard-moonshine');
  const android = settings(false, new Map([['voice.provider', 'onboard']]));
  android.migrateIosVoiceProvider();
  assert.equal(android.voiceProviderSetting.get(), 'onboard');
  assert.equal(android.voiceProviderSetting.values.includes('onboard-parakeet'), false);
  assert.match(read('app/bootstrap.ios.ts'), /migrateIosVoiceProvider\(\)/);
});

test('Transcribe offers the Parakeet download once on iOS, and only a tap downloads', () => {
  const store = new Map(), started = [];
  let provider = 'onboard-parakeet', status = 'absent', isIOS = true;
  const offer = () => loader({ global: { get isIOS() { return isIOS; } } }, {
    '../../native/asr-model': { ASR_MODELS: { 'parakeet-v3': { totalBytes: 483e6 } }, asrModelState: () => ({ status }),
      startAsrModelDownload: id => started.push(id) },
    '../../native/settings-store': { getBooleanSetting: (k, d) => store.get(k) ?? d, setBooleanSetting: (k, v) => store.set(k, v) },
    '../../ui/dashboard-settings': { voiceProviderSetting: { get: () => provider } },
  })('app/apps/transcribe/parakeet-offer.ts');
  const o = offer();
  assert.match(o.takeParakeetNotice(), /Download Parakeet \(483 MB\)/);
  assert.equal(o.takeParakeetNotice(), '', 'once');
  assert.equal(started.length, 0);
  const [item] = o.parakeetMenuItems(() => started.push('notice'));
  assert.equal(item.label, 'Download Parakeet (483 MB)');
  const popped = [];
  item.onSelect({ stack: { pop: () => popped.push(true) } });
  assert.deepEqual(started, ['parakeet-v3', 'notice']);
  assert.equal(popped.length, 1);
  for (const [field, value] of [['status', 'downloading'], ['provider', 'onboard'], ['isIOS', false]]) {
    status = 'absent'; provider = 'onboard-parakeet'; isIOS = true;
    if (field === 'status') status = value; else if (field === 'provider') provider = value; else isIOS = value;
    store.clear();
    assert.equal(offer().takeParakeetNotice(), '', field);
    assert.equal(offer().parakeetMenuItems(() => {}).length, 0, field);
  }
});

test('About credits the Parakeet model (CC BY 4.0) and FluidAudio (Apache 2.0)', () => {
  const about = read('app/phone-ui/ios/about-page.ts');
  assert.match(about, /PARAKEET_CREDIT = [^\n]*Parakeet TDT 0\.6B v3[\s\S]*?CC BY 4\.0[\s\S]*?FluidAudio[\s\S]*?Apache License 2\.0/);
  assert.match(about, /footer: PARAKEET_CREDIT/);
});

test('every FaceclawParakeet call the TypeScript makes is a selector the Swift class exports', () => {
  // NativeScript's JS name for an ObjC selector: downloadDir:progress:completion: -> downloadDirProgressCompletion.
  const jsName = selector => selector.split(':').filter(Boolean).map((part, i) => i ? part[0].toUpperCase() + part.slice(1) : part).join('');
  const exported = new Set([...swiftSelectors()].map(jsName));
  const declared = [...read('app/native/parakeet.ts').split('export type FluidNative = {')[1].split('};')[0].matchAll(/^  (\w+)\(/gm)].map(m => m[1]);
  assert.deepEqual(declared.sort(), ['cancelDownload', 'deleteDir', 'downloadDirProgressCompletion', 'isDownloadedDir', 'isWarmDir', 'warmUpDirCompletion']);
  for (const name of declared) assert.ok(exported.has(name), `${name} is not exported by FaceclawParakeet.swift`);
});
