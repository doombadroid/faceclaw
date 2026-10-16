const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
// The provider settings ios-preview-controller hands the voice bridge.
const voiceSettings = { voiceProviderSetting: { get: () => 'onboard' }, elevenLabsApiKeySetting: { get: () => '' },
  openAiApiKeySetting: { get: () => '' }, sonioxApiKeySetting: { get: () => '' } };
function load(file, context) {
  const sandbox = { exports: {}, ...context };
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  return sandbox.exports;
}

test('iOS worker replies keep cached draw references paired with their baked pixels', () => {
  const replies = [], received = [];
  const wrap = buffer => ({ length: buffer.byteLength, buffer,
    base64EncodedStringWithOptions: () => Buffer.from(buffer).toString('base64') });
  const NSData = {
    dataWithBytesLength: buffer => wrap(buffer),
    alloc: () => ({ initWithBase64EncodedStringOptions: text => {
      const bytes = Uint8Array.from(Buffer.from(text, 'base64')); return wrap(bytes.buffer);
    } }),
  };
  const interop = { handleof: buffer => buffer, bufferFromData: data => data.buffer };
  const display = load('app/native/active-display.ios.ts', {
    NSData, interop, global: { postMessage: message => replies.push(message) },
  }).getActiveDisplay();
  const pixels = new Uint8Array([255, 0, 0, 255]), draws = new Uint8Array([1, 7, 0, 0, 0, 0, 0, 0, 0]);
  display.submitSurfaceFrame(pixels.buffer, 'window:test', 0, 0, 2, 2, 'frame', 0, 1, draws.buffer);
  const worker = {};
  const { WorkerAppHost } = load('app/ui/shell/worker-window.ts', {
    require: () => ({}), global: { isIOS: true }, NSData, interop,
  });
  const host = new WorkerAppHost({ appId: 'test', worker, submitPixels: (...args) => received.push(args) });
  host.openWindows.add('test');
  worker.onmessage({ data: replies[0] });
  assert.equal(received.length, 1);
  assert.deepEqual([...received[0][1]], [...pixels]);
  assert.deepEqual([...new Uint8Array(received[0][4])], [...draws]);
  display.submitSurfaceFrame(pixels.buffer, 'window:test', 0, 0, 2, 2);
  worker.onmessage({ data: replies[1] });
  assert.equal(received[1][4], null, 'a pixel-only update must clear previous draw identities');
  host.openWindows.clear(); worker.onmessage({ data: replies[0] });
  assert.equal(received.length, 2, 'closed windows cannot deliver stale cached draws');
});

test('iOS installed apps launch, recover missing packages, and close before uninstall', async () => {
  const calls = [], app = { packageId: 'test.app', name: 'Test' };
  let present = true;
  const modules = {
    "../ui/input-monitor": load("app/ui/input-monitor.ts", {}),
    '../apps/all-apps': { ALL_APPS: [{ appId: 'evenhub' }] },
    '../apps/evenhub/installed-apps': { getInstalledEvenHubAppById: id => id === 'installed' ? app : null,
      installedEvenHubPackageId: id => id === 'installed' ? app.packageId : null,
      uninstallEvenHubPackage: id => calls.push(['uninstall', id]) },
    '../apps/evenhub/updates': { isInstalledPackagePresent: () => present },
    '../apps/evenhub': { openEvenHubStoreForPackage: (_ctx, value) => calls.push(['reinstall', value.packageId]) },
    '../apps/evenhub/manager': { launchInstalledPackage: (ctx, value) => calls.push(['launch', ctx.appId, value.packageId]),
      closeRunningPackage: id => calls.push(['close', id]) },
  };
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', { require: id => modules[id] ?? {} });
  const host = Object.create(IosPreviewController.prototype);
  host.buildAppContext = app => app; host.fail = assert.fail; host.requestShellRender = () => {};
  await host.launchApp('installed'); present = false; await host.launchApp('installed');
  await host.uninstallApp('installed');
  assert.deepEqual(calls, [['launch', 'installed', 'test.app'], ['reinstall', 'test.app'], ['close', 'test.app'], ['uninstall', 'test.app']]);
});

test('iOS settings prompts honor password input and report cancellation', async () => {
  const prompts = [], writes = [];
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', { require: id => id === '@nativescript/core' ? {
    Dialogs: { prompt: async options => { prompts.push(options); return { result: false, text: 'discarded' }; } },
  } : {} });
  const host = Object.create(IosPreviewController.prototype); host.active = true;
  const accepted = await host.editSetting({ editorTitle: 'Password', inputKind: 'password', get: () => '', set: value => writes.push(value) });
  assert.equal(prompts[0].inputType, 'password');
  assert.equal(accepted, false); assert.deepEqual(writes, []);
});

test('iOS host forwards hands-free capture mode to the voice bridge', async () => {
  const captures = [];
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', { require: id => id === '../native/ios-voice-input'
    ? { iosVoiceInput: { startGlassesCapture: (_session, _voice, _log, endpointing) => captures.push(endpointing) } }
    : id === '../ui/dashboard-settings' ? voiceSettings : {} });
  const host = Object.create(IosPreviewController.prototype);
  host.communicator = {}; host.state = { phase: 'connected' };
  await host.startVoiceCapture(true);
  await host.startVoiceCapture();
  assert.deepEqual(captures, [true, false]);
});

test('iOS phone battery distinguishes unknown, charging, full and unplugged readings', () => {
  const device = { batteryLevel: -1, batteryState: 0 };
  const api = load('app/native/phone-battery.ts', { require: () => ({}), global: { isIOS: true },
    UIDevice: { currentDevice: device }, UIDeviceBatteryState: { Unknown: 0, Unplugged: 1, Charging: 2, Full: 3 } });
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: null, charging: null });
  device.batteryLevel = 0.726; device.batteryState = 2;
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: 73, charging: true });
  device.batteryLevel = 1; device.batteryState = 3;
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: 100, charging: true });
  device.batteryLevel = 0; device.batteryState = 1;
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: 0, charging: false });
});
test('settings changes propagate between iOS worker isolates once, including after a getter read', () => {
  const store = new Map(), ticks = new Set(), tasks = [];
  const ApplicationSettings = { getString: (k, d) => store.get(k) ?? d, getBoolean: (k, d) => store.get(k) ?? d,
    setString: (k, v) => store.set(k, v), setBoolean: (k, v) => store.set(k, v), hasKey: k => store.has(k) };
  const context = { require: () => ({ ApplicationSettings }), setTimeout: fn => tasks.push(fn),
    setInterval: fn => { ticks.add(fn); return fn; }, clearInterval: fn => ticks.delete(fn) };
  const main = load('app/native/settings-store.ios.ts', context), worker = load('app/native/settings-store.ios.ts', context);
  const seenMain = [], seenWorker = [];
  const offMain = main.onSettingsStoreChanged(k => seenMain.push(k));
  const offWorker = worker.onSettingsStoreChanged(k => seenWorker.push(k));
  main.getStringSetting('terminal.connections', '[]'); worker.getStringSetting('terminal.connections', '[]');
  main.setStringSetting('terminal.connections', '["test"]');
  assert.equal(worker.getStringSetting('terminal.connections', '[]'), '["test"]');
  const flush = () => { for (const tick of ticks) tick(); while (tasks.length) tasks.shift()(); };
  flush(); flush();
  assert.deepEqual(seenMain, ['terminal.connections']); assert.deepEqual(seenWorker, ['terminal.connections']);
  main.getBooleanSetting('sound', true); worker.getBooleanSetting('sound', true);
  worker.setBooleanSetting('sound', false); flush();
  assert.equal(main.getBooleanSetting('sound', true), false);
  assert.deepEqual(seenMain, ['terminal.connections', 'sound']);
  offWorker(); offMain(); assert.equal(ticks.size, 0);
});
test('iOS worker frames preserve baked grayscale bytes through the message boundary', () => {
  const messages = [];
  const api = load('app/native/active-display.ios.ts', { global: { postMessage: m => messages.push(m) },
    interop: { handleof: b => b }, NSData: { dataWithBytesLength: (b, n) => ({ base64EncodedStringWithOptions: () => Buffer.from(b, 0, n).toString('base64') }) } });
  const pixels = new Uint8Array([0, 1, 15, 127, 254, 255]);
  api.getActiveDisplay().submitSurfaceFrame(pixels.buffer, 'window:blocks:main', 0, 0, 3, 2);
  assert.equal(messages[0].surfaceId, 'window:blocks:main');
  assert.equal(messages[0].width, 3); assert.equal(messages[0].height, 2);
  assert.deepEqual(Buffer.from(messages[0].pixels, 'base64'), Buffer.from(pixels));
});

test('settings-driven repaint runs after font cache invalidation, regardless of subscription order', () => {
  const listeners = [], tasks = [], painted = [];
  let cachedFont = 'Light';
  const api = load('app/ui/dashboard-settings.ts', { global: { isIOS: true },
    require: id => id.includes('settings-store') ? { onSettingsStoreChanged: fn => listeners.push(fn) }
      : { Layer: class {}, ASSISTANT_MODEL_CHOICES: [] },
    setTimeout: fn => tasks.push(fn),
  });
  api.onAnySettingChanged(() => painted.push(cachedFont));
  listeners.push(() => { cachedFont = 'Bold'; });
  for (const listener of listeners) listener('display.uiFont2');
  while (tasks.length) tasks.shift()();
  assert.deepEqual(painted, ['Bold']);
});

function remotePageHarness({ enabled = () => false, totals = () => ({ messages: 0, bytes: 0, frames: 0 }), now = () => 0, intervals = new Map() } = {}) {
  const views = [], appEvents = new Map(), settingListeners = new Set(), runtimeListeners = new Map();
  let nextId = 0;
  class View {
    events = new Map(); children = []; ios = {};
    actionBar = { actionItems: { addItem() {} }, set() {}, setColor(navBar, color) { navBar.title = color; navBar.tintColor = color; } };
    constructor() { views.push(this); }
    on(event, fn) { this.events.set(event, fn); }
    addChild(view) { this.children.push(view); }
    set(key, value) { this[key] = value; }
    notifyPropertyChange() {}
    getActualSize() { return { width: 0, height: 0 }; }
    getViewById() { return null; }
    static setRow() {} static setColumn() {}
  }
  // NativeScript's iOS Image: src wraps an ImageSource in a copy; teardown nulls the held imageSource's native image.
  class Image extends View {
    get src() { return this._src; }
    set src(value) { this._src = value; this.imageSource = { ios: value.ios }; }
    dispose() { if (this.imageSource) this.imageSource.ios = null; }
  }
  const core = { Application: { suspendEvent: 'suspend', resumeEvent: 'resume',
    on: (key, fn) => appEvents.set(key, fn), off: key => appEvents.delete(key) },
    ActionItem: View, Builder: { load: () => new View() }, Observable: View, Color: class {}, GridLayout: View, Image, Label: View, Page: View };
  const controller = { pauses: 0, resumes: 0, pause() { this.pauses++; }, resume() { this.resumes++; } };
  // A plain counter: a release the page runs twice shows as a negative count.
  const runtime = { controller, frame: null, keyboardSession: null, mirrors: 0,
    acquireMirror() { this.mirrors++; return () => { this.mirrors--; }; }, on(event, fn) {
    runtimeListeners.set(event, fn); return () => runtimeListeners.delete(event);
  } };
  const modules = {
    '@nativescript/core': core,
    './runtime': { getRuntime: () => runtime },
    '../phone-gestures': { PhoneGestureRecognizer: class { cancel() {} } },
    '../ble-bandwidth-meter': require('../.test-build/app/phone-ui/ble-bandwidth-meter.js'),
    '../../native/ble-traffic': { sampleBleTraffic: () => totals() },
    '../../ui/dashboard-settings': { showBleBandwidthSetting: { get: () => enabled() }, mirrorTouchSetting: { get: () => true },
      onAnySettingChanged: fn => { settingListeners.add(fn); return () => settingListeners.delete(fn); } },
  };
  // The shared view models resolve their own imports relative to phone-ui/.
  const shared = { '@nativescript/core': core, '../ui/dashboard-settings': { brightnessSetting: { get: () => 'auto' }, displayLayoutSetting: { displayValue: () => 'Tall' } } };
  modules['./ui-kit'] = load('app/phone-ui/ios/ui-kit.ts', { require: id => id === '@nativescript/core' ? core : {} });
  modules['../keyboard-input-view-model'] = load('app/phone-ui/keyboard-input-view-model.ts', { require: id => shared[id] ?? {} });
  modules['../remote-controls-view-model'] = load('app/phone-ui/remote-controls-view-model.ts', { require: id => shared[id] ?? {} });
  const { createRemotePage } = load('app/phone-ui/ios/remote-page.ts', {
    require: id => modules[id] ?? {}, Date: { now },
    NSNotificationCenter: { defaultCenter: { addObserverForNameObjectQueueUsingBlock: () => ({}), removeObserver() {} } },
    UIKeyboardWillChangeFrameNotification: 'keyboard', NSOperationQueue: { mainQueue: {} },
    setInterval: fn => { const id = ++nextId; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    setTimeout: () => 1, clearTimeout() {},
  });
  return { page: createRemotePage(), views, appEvents, settingListeners, runtimeListeners, controller, intervals, runtime };
}

test('iOS Remote counts its mirror as shown exactly while loaded', () => {
  const { page, runtime, appEvents } = remotePageHarness();
  assert.equal(runtime.mirrors, 0, 'a created page shows nothing yet');
  page.events.get('loaded')(); assert.equal(runtime.mirrors, 1, 'pushed or its tab selected: the mirror shows');
  page.events.get('loaded')(); assert.equal(runtime.mirrors, 1, 'a repeated loaded holds one count');
  appEvents.get('suspend')(); assert.equal(runtime.mirrors, 1, 'suspend pauses the controller; the count stays for resume');
  page.events.get('unloaded')(); assert.equal(runtime.mirrors, 0, 'popped or its tab hidden: the mirror is gone');
  page.events.get('unloaded')(); assert.equal(runtime.mirrors, 0, 'a repeated unloaded releases nothing more');
  page.events.get('loaded')(); assert.equal(runtime.mirrors, 1, 'shown again after a pop back or tab return');
});

test('iOS Remote bandwidth footer toggles live, polls only in foreground and resets its rate window on resume', () => {
  let enabled = false, atMs = 0, totals = { messages: 0, bytes: 0, frames: 0 };
  const { page, views, appEvents, settingListeners, intervals } = remotePageHarness({ enabled: () => enabled, totals: () => totals, now: () => atMs });
  const footer = views.find(v => v.accessibilityIdentifier === 'ble-bandwidth-indicator');
  page.events.get('loaded')(); assert.equal(intervals.size, 0); assert.equal(footer.visibility, 'collapse');
  enabled = true; for (const fn of settingListeners) fn();
  assert.equal(intervals.size, 1); assert.equal(footer.visibility, 'visible');
  totals = { messages: 4, bytes: 2000, frames: 2 }; atMs = 1000; for (const fn of intervals.values()) fn();
  assert.match(footer.text, /2.0 fps, 1,000 B\/frame/);
  appEvents.get('suspend')(); assert.equal(intervals.size, 0);
  const previousText = footer.text;
  totals = { messages: 40, bytes: 20000, frames: 20 }; atMs = 20000;
  for (const fn of settingListeners) fn(); assert.equal(footer.text, previousText); assert.equal(intervals.size, 0);
  appEvents.get('resume')(); assert.equal(intervals.size, 1); assert.doesNotMatch(footer.text, /fps/);
  enabled = false; for (const fn of settingListeners) fn(); assert.equal(footer.visibility, 'collapse'); assert.equal(intervals.size, 0);
  page.events.get('unloaded')(); assert.equal(appEvents.size, 0); assert.equal(settingListeners.size, 0);
});

test('iOS Remote subscribes to the runtime while loaded and never pauses the shared controller', () => {
  const { page, views, runtimeListeners, controller } = remotePageHarness();
  page.events.get('loaded')();
  assert.deepEqual([...runtimeListeners.keys()].sort(), ['frame', 'keyboardSession']);
  const mirror = views.find(v => v.accessibilityIdentifier === 'glasses-preview');
  const frame = { image: { ios: 'png' }, focus: 'Clock' };
  runtimeListeners.get('frame')(frame); assert.equal(mirror.imageSource.ios, 'png');
  // Remote is a pushed page now: popping it tears the mirror down, and the runtime's cached frame must survive.
  mirror.dispose(); assert.equal(frame.image.ios, 'png', 'the shared cached frame keeps its image after Remote is popped');
  page.events.get('unloaded')(); page.events.get('loaded')(); page.events.get('unloaded')();
  assert.equal(runtimeListeners.size, 0);
  assert.deepEqual([controller.pauses, controller.resumes], [0, 0], 'TabView unloads hidden tabs; the runtime owns pause/resume');
  const navBar = {}; page.actionBar.setColor(navBar, 'black');
  assert.deepEqual(navBar, { title: 'black', tintColor: null }, 'the CSS text colour styles the title, not the bar tint');
});

test('iOS runtime fans controller callbacks out to subscribers and caches the latest values', async () => {
  let callbacks, connects = 0, pauses = 0, resumes = 0, suppressed = false, flashes = 0, addresses = { right: 'AA', left: 'BB' }, pairedAtMs = 1;
  const appEvents = new Map(), alerts = [], order = [];
  const { getRuntime } = load('app/phone-ui/ios/runtime.ts', { require: id => ({
    '@nativescript/core': { Application: { suspendEvent: 'suspend', resumeEvent: 'resume', on: (key, fn) => appEvents.set(key, fn) },
      Dialogs: { alert: options => { alerts.push(options); return Promise.resolve(); } } },
    '../../g2/ios-preview-controller': { IosPreviewController: class {
      constructor(...args) { callbacks = args; }
      connect() { connects++; } pause() { pauses++; this.active = false; } resume() { resumes++; this.active = true; }
      acquireMirror() { return 'release'; }
      disconnect() { order.push('disconnect'); return Promise.resolve(); }
      // As the controller does: emitState reports only while active.
      forgetSessionReport() { order.push('forget'); if (this.active) callbacks[2]({ phase: 'disconnected' }); }
    } },
    '../onboarding-state': { isPreviewOnlyMode: () => false },
    '../../g2/reconnect-policy': { isAutoReconnectSuppressed: () => suppressed, suppressAutoReconnect() { suppressed = true; } },
    '../../g2/device-addresses': { loadDeviceAddresses: () => addresses, loadPairedGlassesIdentity: () => ({ pairedAtMs }) },
    '../../g2/ios-peripheral-identity': { deviceAddressError: () => null },
    '../../branding': { APP_NAME: 'OcuSmart' },
    '../../native/firmware-flasher.ios': { flashesStarted: () => flashes },
  })[id] });
  const runtime = getRuntime();
  assert.equal(getRuntime(), runtime, 'one controller per process');
  assert.equal(runtime.acquireMirror(), 'release', "mirror demand is the controller's");
  const [onFrame, onError, onConnection, onKeyboard, onButton] = callbacks;
  const a = [], b = [];
  const offA = runtime.on('connection', s => a.push(s.phase));
  runtime.on('connection', s => b.push(s.phase));
  onConnection({ phase: 'connecting' }); offA(); onConnection({ phase: 'connected' });
  assert.deepEqual([a, b], [['connecting'], ['connecting', 'connected']]);
  onFrame('img', 'Clock'); onKeyboard({ targets: [] }); onButton({ windowId: 'w', title: 'App', icon: null });
  assert.deepEqual(JSON.parse(JSON.stringify([runtime.connection, runtime.frame, runtime.keyboardSession, runtime.evenHubButton])),
    [{ phase: 'connected' }, { image: 'img', focus: 'Clock' }, { targets: [] }, { windowId: 'w', title: 'App', icon: null }]);
  const errors = []; runtime.on('error', m => errors.push(m)); runtime.on('error', m => errors.push(m));
  onError('boom'); assert.deepEqual(errors, ['boom', 'boom']); assert.equal(alerts.length, 1, 'one alert, not one per page');
  assert.equal(alerts[0].title, 'OcuSmart');
  runtime.start(); runtime.start();
  assert.deepEqual([resumes, connects], [1, 1], 'start runs once and auto-connects');
  appEvents.get('suspend')(); appEvents.get('resume')(); assert.deepEqual([pauses, resumes], [1, 2]);
  runtime.setDetour(true); appEvents.get('resume')(); assert.deepEqual([pauses, resumes], [2, 2], 'a detour holds the controller paused');
  runtime.setDetour(false); assert.deepEqual([resumes, connects], [3, 2], 'closing a detour re-runs the auto-connect check');
  const detours = []; runtime.on('detour', open => detours.push(open));
  runtime.setDetour(true); runtime.setDetour(false); assert.deepEqual(detours, [true, false], 'pages under a detour learn it closed');
  // A halted session's report survives a detour that changed nothing, and only that.
  const detour = async change => {
    order.length = 0;
    await runtime.withDisconnected(() => order.push('present'));
    runtime.setDetour(true); change(); runtime.setDetour(false);
    return order.includes('forget');
  };
  assert.deepEqual(order, []);
  assert.equal(await detour(() => {}), false, 'backing out keeps the halted warning');
  assert.deepEqual(order, ['disconnect', 'present']);
  assert.equal(await detour(() => flashes++), true, 'any flash, even a failed one');
  assert.equal(await detour(() => { addresses = { right: 'CC', left: 'DD' }; }), true, 'other glasses paired');
  assert.equal(await detour(() => { pairedAtMs++; }), true, "the same glasses re-paired (the 'unpaired' halt's remedy)");
  runtime.connection = { phase: 'error' };
  assert.equal(await detour(() => flashes++), true);
  assert.equal(runtime.connection.phase, 'disconnected', 'the reset reaches the cached connection');
  assert.equal(await detour(() => { suppressed = false; }), true, 'a config save or firmware check lifted the suppression');
  runtime.setDetour(true); runtime.setDetour(false); assert.equal(order.filter(o => o === 'forget').length, 1, 'Permissions keeps it');
});

test('iOS mirror composites only while a page shows one, though the app is in the foreground', () => {
  const timers = [], frames = [];
  let composites = 0;
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', {
    require: id => ({
      './phone-preview-crop': { phonePreviewCrop: () => null },
      '../ui/dashboard-settings': { previewColorSetting: { get: () => 'white' } },
      '../ui/shell/shell': { shell: { foregroundWindow: () => null, getFocus: () => 'app' } },
    })[id] ?? {},
    setTimeout: fn => { timers.push(fn); return timers.length; }, console,
  });
  // Foreground ('active'), as on the Apps, Hub and Settings tabs, where no mirror shows.
  const host = Object.assign(Object.create(IosPreviewController.prototype), {
    active: true, mirrorDemand: 0, previewTimer: null, glassesLocked: false,
    glance: { screenRect: () => null, isVisible: () => false },
    // display is communicator ?? previewTarget.
    communicator: { getCompositePreview: () => { composites++; return { ios: `frame-${composites}` }; } },
    onFrame: image => frames.push(image.ios),
  });
  const run = () => { while (timers.length) timers.shift()(); };
  // Every surface change routes through schedulePreviewUpdate.
  const surfaceChanges = n => { for (let i = 0; i < n; i++) { host.schedulePreviewUpdate(); run(); } };
  surfaceChanges(5);
  assert.deepEqual([composites, timers.length], [0, 0], 'no mirror shown: nothing composites, nothing is scheduled');
  const release = host.acquireMirror();
  assert.equal(timers.length, 1, 'acquiring schedules a frame at once'); run();
  assert.deepEqual(frames, ['frame-1'], 'exactly one prompt frame replaces the cached one');
  const second = host.acquireMirror(); run();
  assert.equal(composites, 1, 'a second mirror on screen needs no extra frame');
  surfaceChanges(2); assert.equal(composites, 3);
  release(); surfaceChanges(1); assert.equal(composites, 4, 'one mirror still shown');
  host.schedulePreviewUpdate(); second(); run();
  assert.equal(composites, 4, 'a frame pending when the last mirror leaves is dropped');
  surfaceChanges(3); assert.equal(composites, 4, 'released: compositing stops');
  release(); second(); surfaceChanges(1); assert.equal(composites, 4, 'double release is harmless');
  const third = host.acquireMirror(); run();
  assert.equal(composites, 5, 'the count never went negative: the next mirror gets its prompt frame');
  host.active = false; surfaceChanges(2); assert.equal(composites, 5, 'paused (suspended, detour): nothing composites');
  third();
});

test('forgetSessionReport clears what a halted session reported, and never touches a live one', () => {
  const api = load('app/g2/ios-preview-controller.ts', { require: () => ({}), console, setTimeout, clearTimeout });
  const host = Object.create(api.IosPreviewController.prototype);
  let emitted = 0;
  host.emitState = () => emitted++;
  const halted = { phase: 'error', status: 'Incompatible firmware', battery: 60, charging: false, ring: true, frames: 3,
    capabilities: '', leftVersion: '2.3.0.24', rightVersion: '2.3.0.24', firmwareWarning: 'The glasses report stock firmware' };
  host.communicator = {}; host.state = { ...halted };
  host.forgetSessionReport(); assert.deepEqual([host.state, emitted], [halted, 0]);
  host.communicator = null; host.forgetSessionReport();
  assert.deepEqual(JSON.parse(JSON.stringify(host.state)), { ...halted, phase: 'disconnected', status: 'Preview only',
    battery: null, charging: null, ring: false, leftVersion: '', rightVersion: '', firmwareWarning: '' }, 'the halt reason goes with it');
  assert.equal(emitted, 1);
});

test('iOS configures an in-process surface before submitting constructor-triggered frames', async () => {
  const submitted = [], surfaces = new Set();
  const shell = { getWindows: () => [], configure() {}, registerWindow() {}, focusWindow() {}, foregroundWindow: () => null };
  const api = load('app/g2/ios-preview-controller.ts', {
    require: name => ({
      '../ui/shell/shell': { shell },
      '../ui/shell/geometry': { appViewportRect: () => ({ x: 0, y: 0, width: 2, height: 1 }) },
      '../graphics/plane': { flattenPlanesWithDraws: planes => ({ image: planes[0], draws: [] }), planesFingerprint: () => 'fp' },
      '../graphics/glyph-wire': { prepareFrameDraws: () => null },
    })[name] ?? {},
    console,
  });
  // Exercise the real launch method with a strict display boundary. App
  // construction paints synchronously, as Nightscout's tray subscription does.
  const controller = Object.create(api.IosPreviewController.prototype);
  controller.inProcessApps = new Map();
  controller.requestShellRender = () => {};
  controller.schedulePreviewUpdate = () => {};
  controller.communicator = null;
  controller.previewTarget = {
    async configureSurface(id) { surfaces.add(id); }, async setSurfaceVisible() {},
    async removeSurface(id) { surfaces.delete(id); },
    async submitSurfaceFrame(id, pixels) { assert.ok(surfaces.has(id), `unconfigured ${id}`); submitted.push([...pixels]); },
  };
  let plumbing, early;
  const fresh = [{ pixels: new Uint8Array([30, 40]), width: 2, height: 1 }];
  await controller.launchInProcessApp('nightscout', 'window:nightscout', options => {
    plumbing = options;
    early = options.submitFrame([{ pixels: new Uint8Array([10, 20]), width: 2, height: 1 }]);
    return { window: { windowId: 'nightscout', surfaceId: 'window:nightscout', appId: 'nightscout' },
      requestRender: () => options.submitFrame(fresh) };
  });
  await early;
  assert.deepEqual(submitted, [[30, 40]]);
  plumbing.removeSurface();
  await plumbing.submitFrame(fresh);
  assert.deepEqual(submitted, [[30, 40]], 'late callbacks cannot submit to a removed surface');
});

test('iOS compositor rejects missing and removed surfaces before crossing into Kotlin', () => {
  let nativeSubmissions = 0;
  const native = { configureIdXYWidthHeightZOrderTransparent() {}, removeId() {}, submitDrawsIdDataXYWidthHeightDraws() { nativeSubmissions++; } };
  const api = load('app/graphics/surface-compositor.ios.ts', {
    require: () => ({ toData: data => data }),
    FaceclawKitIosSurfaceCompositor: { alloc: () => ({ initWithWidthHeight: () => native }) },
  });
  const c = new api.SurfaceCompositor(2, 1), pixels = new Uint8Array([1, 2]);
  const rect = { x: 0, y: 0, width: 2, height: 1 };
  assert.throws(() => c.submitSurfaceFrame('nightscout', pixels, rect), /Unknown surface/);
  c.configureSurface('nightscout', { ...rect, zOrder: 0, transparency: 'opaque' });
  c.submitSurfaceFrame('nightscout', pixels, rect);
  c.removeSurface('nightscout');
  assert.throws(() => c.submitSurfaceFrame('nightscout', pixels, rect), /Unknown surface/);
  assert.equal(nativeSubmissions, 1);
});

test('iOS opens the on-glasses onboarding on a new acknowledged frame, once per run while due', () => {
  const settings = new Map();
  const progress = load('app/apps/onboarding/onboarding-progress.ts', {
    require: id => ({
      '../../native/settings-store': {
        getStringSetting: (key, fallback) => settings.get(key) ?? fallback,
        setStringSetting: (key, value) => settings.set(key, value),
      },
      '../../version': { FACECLAW_VERSION: '9.9.9' },
    })[id],
  });
  const launched = [];
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', {
    require: id => ({ '../apps/onboarding/onboarding-progress': progress })[id] ?? {},
  });
  const host = Object.create(IosPreviewController.prototype);
  host.acknowledgedFrames = 0;
  host.launchApp = id => { launched.push(id); return Promise.resolve(); };
  host.maybeLaunchOnboarding({ phase: 'connecting', frames: 0 });
  host.maybeLaunchOnboarding({ phase: 'connected', frames: 0 });
  assert.deepEqual(launched, []);
  host.maybeLaunchOnboarding({ phase: 'connected', frames: 1 });
  assert.deepEqual(launched, ['onboarding']);
  // Still unfinished, but a reconnect in the same run doesn't reopen it.
  host.maybeLaunchOnboarding({ phase: 'connected', frames: 2 });
  assert.deepEqual(launched, ['onboarding']);
  assert.equal(progress.isGlassesOnboardingDue(), true);
  progress.markGlassesOnboardingFinished();
  assert.equal(progress.isGlassesOnboardingDue(), false);
  settings.set('onboarding.glassesFinishedVersion', '9.9.8');
  assert.equal(progress.isGlassesOnboardingDue(), true, 'an upgrade makes onboarding due again');
});

test('iOS preview voice uses the phone microphone, while connected capture stays on glasses', async () => {
  const calls = [];
  const bridge = { prepare: async (foreground, phone, voice) => { calls.push(['prepare', foreground, phone, voice.provider]); return true; },
    startPhoneCapture: async (voice, _log, endpointing) => calls.push(['phone', voice.provider, endpointing]),
    startGlassesCapture: async (_session, voice, _log, endpointing) => calls.push(['glasses', voice.provider, endpointing]) };
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', {
    require: id => id === '../native/ios-voice-input' ? { iosVoiceInput: bridge } : id === '../ui/dashboard-settings' ? voiceSettings : {},
  });
  const host = Object.create(IosPreviewController.prototype);
  host.active = true; host.glassesLocked = false; host.communicator = null; host.state = { phase: 'disconnected' };
  assert.equal(await host.prepareVoiceCapture(), true);
  await host.startVoiceCapture(true);
  assert.deepEqual(calls, [['prepare', true, true, 'onboard'], ['prepare', true, true, 'onboard'], ['phone', 'onboard', true]]);
  calls.length = 0; host.communicator = {}; host.state = { phase: 'connected' };
  assert.equal(await host.prepareVoiceCapture(), true); await host.startVoiceCapture(false);
  assert.deepEqual(calls, [['prepare', true, false, 'onboard'], ['glasses', 'onboard', false]]);
  calls.length = 0; host.active = false; host.communicator = null; host.state = { phase: 'disconnected' };
  assert.equal(await host.prepareVoiceCapture(), false); await host.startVoiceCapture();
  assert.deepEqual(calls, []);
});

test('iOS keyboard action opens the shared destination session and remains blocked while locked', () => {
  let opened = 0;
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', {
    require: id => id === '../ui/shell/shell' ? { shell: { startKeyboardInput: () => opened++ } } : {},
  });
  const host = Object.create(IosPreviewController.prototype);
  host.active = true; host.glassesLocked = false; host.typeIntoApp(); assert.equal(opened, 1);
  host.glassesLocked = true; host.typeIntoApp(); assert.equal(opened, 1);
  host.glassesLocked = false; host.active = false; host.typeIntoApp(); assert.equal(opened, 1);
});

test('iOS curve editor retains invalid draft and retries Save with a validation message', async () => {
  const prompts = [], errors = [], saved = [];
  const answers = [{ result: true, text: '0:0,5:' }, { result: true, text: '0:0,5:100' }];
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', { require: id => id === '@nativescript/core'
    ? { Dialogs: { prompt: async options => { prompts.push(options.defaultText); return answers.shift(); }, alert: async options => errors.push(options.message) } }
    : {} });
  const host = Object.create(IosPreviewController.prototype); host.active = true;
  const curve = require('../.test-build/app/g2/brightness-curve.js');
  assert.equal(await host.editSetting({ editorTitle: 'Auto light curve', get: () => '0:0,8:100',
    set: value => saved.push(value), validationError: curve.brightnessCurveError }), true);
  assert.deepEqual(prompts, ['0:0,8:100', '0:0,5:']);
  assert.equal(errors.length, 1);
  assert.deepEqual(saved, ['0:0,5:100']);
});

test('a glasses keyboard session under a detour opens Remote only once the detour closes', () => {
  const listeners = new Map(), navs = [];
  class Frame { navigate(entry) { navs.push(entry.moduleName); this.currentEntry = entry; } }
  class TabView { on() {} }
  const runtime = { inDetour: false, keyboardSession: null, start() {},
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); } };
  const shell = load('app/phone-ui/ios/shell.ts', { require: id => id === './runtime' ? { getRuntime: () => runtime }
    : { Color: class {}, Frame, TabView, TabViewItem: class {} } });
  const tabs = shell.createShell();
  tabs.selectedIndex = 3; navs.length = 0;
  // Navigating a tab frame would make it Frame.topmost(), stranding the detour's own Done/Back.
  runtime.inDetour = true; runtime.keyboardSession = { id: 1 }; listeners.get('keyboardSession')(runtime.keyboardSession);
  assert.deepEqual([navs, tabs.selectedIndex], [[], 3], 'no tab navigation under a detour');
  runtime.inDetour = false; listeners.get('detour')(false);
  assert.deepEqual([navs, tabs.selectedIndex], [['ocusmart/remote'], 0], 'the waiting session reaches Remote on the Glasses tab');
  listeners.get('keyboardSession')(runtime.keyboardSession);
  assert.deepEqual(navs, ['ocusmart/remote'], 'Remote already on top is not pushed again');
  runtime.keyboardSession = null; listeners.get('detour')(false);
  assert.equal(navs.length, 1, 'a detour closing with no session opens nothing');
});
