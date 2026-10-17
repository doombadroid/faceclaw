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

/** error-reports.ts stand-in: the reports a guard filed, as [source, message]. */
function reportSink() {
  const reports = [];
  return { reports, module: { reportError: (source, error) => reports.push([source, String(error?.message ?? error)]) } };
}

test('Kotlin listeners answer to both K/N twin selector names', () => {
  let extended = null;
  const NSObject = { extend: (methods) => { extended = methods; return { new: () => methods }; } };
  const { kotlinListener } = loader({ NSObject }, { './error-reports': reportSink().module })('app/native/kotlin-listener.ios.ts');
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

test('a Kotlin listener method that throws files an error report under either twin name, not thrown into native code', () => {
  let extended = null;
  const sink = reportSink();
  const { kotlinListener } = loader({
    NSObject: { extend: (methods) => { extended = methods; return { new: () => methods }; } }, console: quietConsole,
  }, { './error-reports': sink.module })('app/native/kotlin-listener.ios.ts');
  kotlinListener({}, { onErrorMessage_: () => { throw new Error('boom'); }, valueForKey(key) { return `${this.prefix}${key}`; } });
  assert.doesNotThrow(() => extended.onErrorMessage_('x'));
  assert.doesNotThrow(() => extended.onErrorMessage('x'));
  assert.deepEqual(sink.reports, [['onErrorMessage_', 'boom'], ['onErrorMessage_', 'boom']]);
  assert.equal(extended.valueForKey.call({ prefix: 'k:' }, 'a'), 'k:a', 'return values and this pass through');
});

/** FaceclawCommunicatorBridge over a recording native session; [errors] maps a selector to the error string it returns. */
function bridgeHarness(errors = {}) {
  const sink = reportSink();
  const calls = [];
  const native = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return name in errors ? errors[name] : true; } });
  const { FaceclawCommunicatorBridge: Bridge } = loader({
    setTimeout, NativeClass: () => c => c, NSObject: class { static new() { return new this(); } }, console: quietConsole,
    interop: { bufferFromData: d => d.buffer }, NSData: {},
    FaceclawKitFaceclawBleCommunicatorListener: {}, FaceclawKitIosAncsListener: {}, FaceclawKitIosAudioPacketListener: {},
    FaceclawKitFaceclawCompassListener: {},
    FaceclawKitIosGlassesSession: { alloc: () => ({ initWithRightAddressLeftAddressRingAddress: () => native }) },
  }, { '@nativescript/core': {}, './ios-graphics': {}, './ios-bluetooth': {}, './error-reports': sink.module })('app/native/faceclaw-communicator.ios.ts');
  return { bridge: new Bridge({ right: 'r', left: 'l' }), calls, reports: sink.reports };
}

test('a throwing bridge listener files a report and the next listener still hears the event', async () => {
  const { bridge, calls, reports } = bridgeHarness();
  const heard = [];
  bridge.onSilentMode(() => { throw new Error('first'); });
  bridge.onSilentMode(silent => heard.push(silent));
  bridge.handleSilentMode(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(heard, [true]);
  assert.deepEqual(reports, [['bridge listener', 'first']]);
  // An ObjC protocol class calling app code directly from a Kotlin frame.
  bridge.startAudioForwarding(() => { throw new Error('packet'); });
  const forwarder = calls.find(([name]) => name === 'startG2AudioForwardingNsDataListener')[1];
  assert.doesNotThrow(() => forwarder.onAudioPacketDataArmArrivalMs_({ buffer: new Uint8Array([1]).buffer }, 'R', 7));
  assert.deepEqual(reports.at(-1), ['onAudioPacketDataArmArrivalMs', 'packet']);
  // The preview animation block Kotlin calls on the main queue: each listener on its own.
  const animation = calls.find(([name]) => name === 'setPreviewAnimationListenerListener')[1];
  const stepped = [];
  bridge.onPreviewAnimationFrame(() => { throw new Error('step'); });
  bridge.onPreviewAnimationFrame(() => stepped.push(1));
  assert.doesNotThrow(() => animation());
  assert.deepEqual(stepped, [1]);
  assert.deepEqual(reports.at(-1), ['previewAnimation', 'step']);
  await bridge.close();
});

test('every SessionListener, AncsListener and CompassListener method guards the app code it calls', () => {
  const { bridge, calls, reports } = bridgeHarness();
  bridge.setRequiresAncs(true);
  bridge.addCompassListener(() => {});
  const proxy = selector => calls.find(([name]) => name === selector)[1];
  const thrower = new Proxy({}, { get: () => () => { throw new Error('app code'); } });
  let methods = 0;
  for (const listener of [proxy('setListenerListener'), proxy('setAncsListenerListener'), proxy('addCompassListenerListener')]) {
    listener.bridge = thrower;
    listener.handler = () => { throw new Error('app code'); };
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(listener)).filter(n => n !== 'constructor')) {
      const before = reports.length;
      assert.doesNotThrow(() => listener[name]({ buffer: new ArrayBuffer(1) }), name);
      assert.equal(reports.length, before + 1, `${name} filed no report`);
      methods++;
    }
  }
  assert.ok(methods >= 13, `only ${methods} listener methods found`);
});

test('brightness, screen and wear-detection failures reject, as on Android', async () => {
  const { bridge } = bridgeHarness({
    configureBrightnessAutoLevelMinimumMaximumCurveFadeMs: 'IosGlassesSession.configureBrightness: bad',
    setG2ScreenOnScreenOn: 'IosGlassesSession.setG2ScreenOn: bad',
    enableWearDetectionAndRequestState: 'IosGlassesSession.enableWearDetectionAndRequestState: bad',
  });
  await assert.rejects(bridge.configureBrightness({ auto: true, level: 50, minimum: 2, maximum: 100, curve: '0:0', fadeMs: 0 }), /configureBrightness: bad/);
  await assert.rejects(bridge.setG2ScreenOn(true), /setG2ScreenOn: bad/);
  await assert.rejects(bridge.enableWearDetectionAndRequestState(), /enableWearDetectionAndRequestState: bad/);
  await bridge.close();
});
