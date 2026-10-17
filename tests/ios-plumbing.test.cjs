const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');
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
  const { kotlinListener } = loader({ NSObject })('app/native/kotlin-listener.ios.ts');
  const heard = [];
  kotlinListener({}, { onTranscriptTextIsFinal: text => heard.push(text), onFailureMessage_: message => heard.push(message) });
  // K/N moves the "_" between twins by compile order; the protocol picks whichever it declares.
  assert.equal(extended.onTranscriptTextIsFinal_, extended.onTranscriptTextIsFinal);
  assert.equal(extended.onFailureMessage, extended.onFailureMessage_);
  extended.onTranscriptTextIsFinal_('a'); extended.onFailureMessage('b');
  assert.deepEqual(heard, ['a', 'b']);
});

// Runtime 9.0 ends the app on a JS error that unwinds into native code (a release build has no debug pass).
const quietConsole = { ...console, error: () => {} };

test('iOS release builds discard an uncaught JS error and log it instead of terminating', () => {
  const runtime = require('../package.json').devDependencies['@nativescript/ios'];
  const [major, minor] = runtime.replace(/^\D*/, '').split('.').map(Number);
  const config = loader({}, { '@nativescript/core': {} })('nativescript.config.ts').default;
  // The CLI copies ios.discardUncaughtJsExceptions to the top of the app's package.json, where the runtime reads it.
  const discards = config.discardUncaughtJsExceptions === true || config.ios?.discardUncaughtJsExceptions === true;
  assert.ok(discards || major > 9 || (major === 9 && minor >= 1),
    `@nativescript/ios ${runtime} terminates on an uncaught JS error unless nativescript.config.ts discards it`);
  assert.match(read('app/bootstrap.ios.ts'), /Application\.discardedErrorEvent/, 'a discarded error must still reach the log');
});

test('a Kotlin listener method that throws is logged under either twin name, not thrown into native code', () => {
  let extended = null;
  const logged = [];
  const { kotlinListener } = loader({
    NSObject: { extend: (methods) => { extended = methods; return { new: () => methods }; } },
    FaceclawLog: { log: line => logged.push(line) }, console: quietConsole,
  })('app/native/kotlin-listener.ios.ts');
  kotlinListener({}, { onErrorMessage_: () => { throw new Error('boom'); }, valueForKey(key) { return `${this.prefix}${key}`; } });
  assert.doesNotThrow(() => extended.onErrorMessage_('x'));
  assert.doesNotThrow(() => extended.onErrorMessage('x'));
  assert.equal(logged.length, 2);
  for (const line of logged) assert.match(line, /onErrorMessage_.*boom/);
  assert.equal(extended.valueForKey.call({ prefix: 'k:' }, 'a'), 'k:a', 'return values and this pass through');
});

test('a throwing bridge listener is logged and the next listener still hears the event', async () => {
  const logged = [];
  const calls = [];
  const native = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return true; } });
  const { FaceclawCommunicatorBridge: Bridge } = loader({
    setTimeout, NativeClass: () => c => c, NSObject: class { static new() { return new this(); } },
    FaceclawLog: { log: line => logged.push(line) }, console: quietConsole,
    interop: { bufferFromData: d => d.buffer }, NSData: {},
    FaceclawKitFaceclawBleCommunicatorListener: {}, FaceclawKitIosAncsListener: {}, FaceclawKitIosAudioPacketListener: {},
    FaceclawKitFaceclawCompassListener: {},
    FaceclawKitIosGlassesSession: { alloc: () => ({ initWithRightAddressLeftAddressRingAddress: () => native }) },
  }, { '@nativescript/core': {}, './ios-graphics': {}, './ios-bluetooth': {} })('app/native/faceclaw-communicator.ios.ts');
  const bridge = new Bridge({ right: 'r', left: 'l' });
  const heard = [];
  bridge.onSilentMode(() => { throw new Error('first'); });
  bridge.onSilentMode(silent => heard.push(silent));
  bridge.handleSilentMode(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(heard, [true]);
  assert.equal(logged.length, 1); assert.match(logged[0], /first/);
  // An ObjC protocol class calling app code directly from a Kotlin frame.
  bridge.startAudioForwarding(() => { throw new Error('packet'); });
  const forwarder = calls.find(([name]) => name === 'startG2AudioForwardingNsDataListener')[1];
  assert.doesNotThrow(() => forwarder.onAudioPacketDataArmArrivalMs_({ buffer: new Uint8Array([1]).buffer }, 'R', 7));
  assert.match(logged.at(-1), /onAudioPacketDataArmArrivalMs.*packet/);
  await bridge.close();
});
