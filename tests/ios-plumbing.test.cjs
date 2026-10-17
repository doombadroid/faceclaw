const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function load(file, context = {}) {
  const sandbox = { exports: {}, console, ...context };
  vm.runInNewContext(ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
  }).outputText, sandbox);
  return sandbox.exports;
}

test('iOS bridge registers itself as the active communicator until it closes', async () => {
  const calls = [];
  const native = new Proxy({}, { get: (_, name) => (...args) => { calls.push(name); return args[0]; } });
  const { FaceclawCommunicatorBridge: Bridge } = load('app/native/faceclaw-communicator.ios.ts', {
    require: () => ({}), setTimeout, NativeClass: () => c => c,
    NSObject: class { static new() { return new this(); } },
    FaceclawKitFaceclawBleCommunicatorListener: {}, FaceclawKitIosAncsListener: {}, FaceclawKitIosAudioPacketListener: {}, FaceclawKitFaceclawCompassListener: {},
    FaceclawKitIosGlassesSession: { alloc: () => ({ initWithRightAddressLeftAddressRingAddress: () => native }) },
  });
  assert.equal(Bridge.getActive(), null);
  const first = new Bridge({ right: 'r', left: 'l' });
  assert.equal(Bridge.getActive(), first);
  const second = new Bridge({ right: 'r', left: 'l' });
  const closing = first.close();
  assert.equal(Bridge.getActive(), second, 'closing an old bridge keeps the newer one active');
  await closing;
  await second.close();
  assert.equal(Bridge.getActive(), null);
  assert.ok(calls.includes('close'));
});

test('fromKotlinBytes converts a KotlinByteArray of signed bytes', () => {
  const { fromKotlinBytes } = load('app/native/kotlin-data.ts');
  const signed = [0, 1, -1, -128, 127];
  const out = fromKotlinBytes({ size: signed.length, getIndex: i => signed[i] });
  assert.deepEqual(Array.from(out), [0, 1, 255, 128, 127]);
  assert.equal(fromKotlinBytes(null).length, 0);
});

test('iOS links every system framework the port uses and declares the usage strings', () => {
  const flags = read('App_Resources/iOS/build.xcconfig').match(/^OTHER_LDFLAGS = (.*)$/m)[1];
  for (const fw of ['CoreBluetooth', 'Network', 'CoreMedia', 'CoreVideo', 'QuartzCore', 'UserNotifications', 'NaturalLanguage', 'Accelerate']) {
    assert.match(flags, new RegExp(`-framework ${fw}(\\s|$)`), fw);
  }
  assert.match(flags, /-lsqlite3\b/); assert.match(flags, /-lc\+\+(\s|$)/);
  const plist = read('App_Resources/iOS/Info.plist');
  for (const key of ['NSPhotoLibraryAddUsageDescription', 'NSAppleMusicUsageDescription', 'NSAlarmKitUsageDescription']) {
    assert.match(plist, new RegExp(`<key>${key}</key>\\s*<string>OcuSmart [^<]{20,}</string>`), key);
  }
});

test('Kotlin listeners answer to both K/N twin selector names', () => {
  let extended = null;
  const NSObject = { extend: (methods) => { extended = methods; return { new: () => methods }; } };
  const { kotlinListener } = load('app/native/kotlin-listener.ios.ts', { NSObject });
  const onTranscript = () => {}, onFailure = () => {};
  kotlinListener({}, { onTranscriptTextIsFinal: onTranscript, onFailureMessage_: onFailure });
  // K/N moves the "_" between twins by compile order; the protocol picks whichever it declares.
  assert.equal(extended.onTranscriptTextIsFinal_, onTranscript);
  assert.equal(extended.onFailureMessage, onFailure);
  assert.equal(extended.onFailureMessage_, onFailure);
});
