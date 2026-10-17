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
const swiftSelectors = () => new Set([...read(SWIFT).matchAll(/@objc\(([\w:]+)\) public static func/g)].map(m => m[1]));
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
  assert.match(swift.split('public static func download(')[1].split('\n  }\n')[0], /ModelHub\.offlineMode = false/);
  // Blocking entry points refuse the main thread.
  for (const name of ['recognize', 'loadModel']) {
    assert.match(swift.split(`public static func ${name}(`)[1].split('\n')[1], /guard !Thread\.isMainThread/, name);
  }
});

test('the ObjC loader sends only the Parakeet folder to Swift and keeps voice-prints on sherpa', () => {
  const shim = read(SHIM), selectors = swiftSelectors();
  assert.match(shim, /^#import "faceclaw-Swift\.h"$/m);
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
