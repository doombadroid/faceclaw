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
