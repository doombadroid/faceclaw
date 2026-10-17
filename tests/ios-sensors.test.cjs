const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

// A FaceclawKit native session that records every selector call.
function nativeSession(results = {}) {
  const calls = [];
  const native = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return results[name]; } });
  return { calls, native };
}
const bridgeModule = native => ({ FaceclawCommunicatorBridge: { getActive: () => native && { getNativeCommunicator: () => native } } });
const kotlinListener = (protocol, methods) => ({ protocol, ...methods });

test('iOS IMU keeps listeners and the desired stream across sessions and re-sends it when ready', () => {
  const api = loader()('app/native/imu.ios.ts');
  const readings = [], sent = [], nextSent = [];
  const off = api.addImuListener(r => readings.push({ ...r }));
  api.setImuReportEnabled(true, 199.6);
  api.bindImuSession({ setImuReportEnabled: (on, freq) => sent.push([on, freq]) });
  api.imuSessionReady();
  assert.deepEqual(sent, [[true, 200]], 'the enable sent before Connect is applied once the session is ready');
  api.bindImuSession({ setImuReportEnabled: (on, freq) => nextSent.push([on, freq]) });
  api.imuSessionReady();
  api.setImuReportEnabled(false, 0);
  assert.deepEqual(nextSent, [[true, 200], [false, 0]]);
  api.imuSessionReady();
  assert.equal(nextSent.length, 2, 'nothing to re-send while disabled');
  api.receiveImuReading({ x: 1, y: 2, z: 3, source: 2 });
  off(); api.receiveImuReading({ x: 4, y: 5, z: 6, source: 1 });
  assert.deepEqual(readings, [{ x: 1, y: 2, z: 3, source: 2 }]);
  assert.equal(api.imuSourceLabel(2), 'ring');
});

test('iOS bridge drives the Kotlin IMU stream and decodes readings', () => {
  const { calls, native } = nativeSession();
  const { FaceclawCommunicatorBridge: Bridge } = loader({
    setTimeout, NativeClass: () => c => c, NSObject: class { static new() { return new this(); } },
    FaceclawKitFaceclawBleCommunicatorListener: {}, FaceclawKitIosAncsListener: {}, FaceclawKitIosAudioPacketListener: {},
    FaceclawKitFaceclawCompassListener: {}, FaceclawKitFaceclawImuListener: 'imu',
    FaceclawKitIosGlassesSession: { alloc: () => ({ initWithRightAddressLeftAddressRingAddress: () => native }) },
  }, { '@nativescript/core': {}, './ios-graphics': {}, './ios-bluetooth': {}, './kotlin-listener.ios': { kotlinListener } })(
    'app/native/faceclaw-communicator.ios.ts');
  const bridge = new Bridge({ right: 'r', left: 'l' });
  bridge.setImuReportEnabled(true, 200.4);
  assert.deepEqual(calls.at(-1), ['setImuReportEnabledEnableReportFrq', true, 200]);
  const readings = [];
  const off = bridge.addImuListener(r => readings.push({ ...r }));
  const [name, proxy] = calls.at(-1);
  assert.equal(name, 'addImuListenerListener'); assert.equal(proxy.protocol, 'imu');
  proxy.onImuDataXYZEventSource(1, 2.5, -3, 2);
  assert.deepEqual(readings, [{ x: 1, y: 2.5, z: -3, source: 2 }]);
  off();
  assert.deepEqual(calls.at(-1), ['removeImuListenerListener', proxy]);
});

test('iOS light sensor queries, polls and decodes field-105 KotlinByteArray reports', () => {
  const { calls, native } = nativeSession();
  let active = native;
  const load = loader({ FaceclawKitFaceclawAmbientLightListener: 'als' }, {
    './faceclaw-communicator.ios': { FaceclawCommunicatorBridge: { getActive: () => active && { getNativeCommunicator: () => active } } },
    './kotlin-listener.ios': { kotlinListener }, '../util/array-util': {},
  });
  const api = load('app/native/ambient-light.ios.ts');
  api.queryAmbientLight();
  api.setAmbientLightPolling(true);
  api.setAmbientLightPolling(false, { intervalMs: 250, minDelta: 3, heartbeatMs: 0, bindToLease: false });
  assert.deepEqual(calls, [['queryAmbientLight'],
    ['setAmbientLightPollingEnableIntervalMsMinDeltaHeartbeatMsBindToLease', true, 500, 1, 5000, true],
    ['setAmbientLightPollingEnableIntervalMsMinDeltaHeartbeatMsBindToLease', false, 250, 3, 0, false]]);
  const reports = [];
  const off = api.addAmbientLightListener(r => reports.push(r));
  const [name, proxy] = calls.at(-1);
  assert.equal(name, 'addAmbientLightListenerListener');
  // 'A','L',v1, reason poll, flags opened|passive|readOk, status 3, als 200, peak 300, target 0x0190, bright 0xC8, gear 2, scale 1024, tick 0x80000000
  const body = [0x41, 0x4c, 1, 2, 0x0b, 3, 200, 0, 0, 0, 0x2c, 1, 0, 0, 0x90, 1, 0xc8, 2, 0, 4, 0, 0, 0, 0x80]
    .map(b => (b << 24) >> 24);
  proxy.onAmbientLightBody({ size: body.length, getIndex: i => body[i] });
  proxy.onAmbientLightBody({ size: 3, getIndex: () => 0 });
  assert.equal(reports.length, 1);
  assert.deepEqual({ ...reports[0] }, { reason: 'poll', opened: true, passive: true, autoBrightness: false, readOk: true, status: 3,
    alsValue: 200, peak: 300, stockTarget: 400, brightness: 200, gear: 2, scaleQ10: 1024, tickMs: 0x80000000 });
  active = null;
  off();
  assert.deepEqual(calls.at(-1), ['removeAmbientLightListenerListener', proxy], 'unsubscribes from the session it joined');
  const none = api.addAmbientLightListener(() => {});
  none(); api.queryAmbientLight();
  assert.equal(calls.length, 5);
});

test('iOS bandwidth benchmark calls the Kotlin session and parses its status', () => {
  const status = { state: 'done', messageSize: 500, windowSize: 2, linkMode: 0, elapsedMs: 15000 };
  const { calls, native } = nativeSession({
    startBandwidthBenchmarkWithLinkModeMessageSizeWindowSizeDurationMsLinkMode: true,
    getBandwidthBenchmarkStatus: JSON.stringify(status),
  });
  const api = loader({}, { './faceclaw-communicator.ios': bridgeModule(native) })('app/native/bandwidth-benchmark.ios.ts');
  assert.equal(api.startBandwidthBenchmark(500.2, 2, 15000), true);
  assert.deepEqual(calls[0], ['startBandwidthBenchmarkWithLinkModeMessageSizeWindowSizeDurationMsLinkMode', 500, 2, 15000, 0]);
  assert.deepEqual({ ...api.getBandwidthBenchmarkStatus() }, status);
  api.cancelBandwidthBenchmark();
  assert.deepEqual(calls.at(-1), ['cancelBandwidthBenchmark']);
  const offline = loader({}, { './faceclaw-communicator.ios': bridgeModule(null) })('app/native/bandwidth-benchmark.ios.ts');
  assert.equal(offline.startBandwidthBenchmark(500, 2, 15000), false);
  assert.equal(offline.getBandwidthBenchmarkStatus(), null);
  offline.cancelBandwidthBenchmark();
});

test('iOS Developer debug tests enable the buzzer, accelerometer, light sensor and microphones demos', () => {
  let debugMenu;
  const MenuLayer = class { constructor(title, items) { this.title = title; this.items = items; } };
  const load = loader({ global: { isIOS: true } }, {
    '../../ui/menu': { MenuLayer, submenuItem: (label, onSelect) => ({ label, onSelect }) },
    './screen-test': {}, './input-events': {}, '../../ui/shell/shell': {}, './buzzer-demo': {}, './accelerometer-demo': {},
    './bandwidth-benchmark': {}, './light-sensor-demo': {}, './microphones-monitor': {}, './resource-usage': {},
    './load-app': {}, './unicode-test': {}, '../app-definition': {},
    '../../ui/shell/geometry': { appViewportSize: () => ({ height: 288 }) },
    '../../ui/shell/in-process-window': { createInProcessWindow: options => options.baseLayer.menu, YieldAtRootLayer: class { constructor(menu) { this.menu = menu; } } },
  });
  const root = load('app/apps/developer/developer-app.ts').createDeveloperAppWindow({}, {});
  root.items.find(i => i.label === 'Debug tests').onSelect({ stack: { push: layer => { debugMenu = layer; } } });
  const byLabel = Object.fromEntries(debugMenu.items.map(i => [i.label, i]));
  for (const label of ['Buzzer demo', 'Accelerometer demo', 'Light sensor', 'Microphones', 'BLE bandwidth']) {
    assert.ok(!byLabel[label].disabled, label); assert.equal(byLabel[label].description, undefined, label);
  }
});

test('iOS bridge exposes NSData audio forwarding, the passive audio monitor and mic status records', () => {
  const { calls, native } = nativeSession({ startG2AudioForwardingNsDataListener: true, sendFaceclawMicControlRecordLabelRightTempleLeftTemple: true });
  const { FaceclawCommunicatorBridge: Bridge } = loader({
    setTimeout, NativeClass: () => c => c, NSObject: class { static new() { return new this(); } },
    interop: { bufferFromData: d => d.buffer, handleof: b => b }, NSData: { dataWithBytesLength: (b, n) => new Uint8Array(b, 0, n) },
    FaceclawKitFaceclawBleCommunicatorListener: {}, FaceclawKitIosAncsListener: {}, FaceclawKitIosAudioPacketListener: {},
    FaceclawKitFaceclawCompassListener: {}, FaceclawKitFaceclawImuListener: 'imu', FaceclawKitFaceclawMicStatusListener: 'mic',
    FaceclawKitIosGlassesSession: { alloc: () => ({ initWithRightAddressLeftAddressRingAddress: () => native }) },
  }, { '@nativescript/core': {}, './ios-graphics': {}, './ios-bluetooth': {}, './kotlin-listener.ios': { kotlinListener } })(
    'app/native/faceclaw-communicator.ios.ts');
  const bridge = new Bridge({ right: 'r', left: 'l' });
  const packets = [];
  const data = { buffer: new Uint8Array([1, 2]).buffer };
  assert.equal(bridge.startAudioForwarding((p, arm, ms) => packets.push([...p, arm, ms])), true);
  const [startName, forwarder] = calls.at(-1);
  assert.equal(startName, 'startG2AudioForwardingNsDataListener');
  // The selector Kotlin/Native sends (build 37 crashed without it).
  forwarder.onAudioPacketDataArmArrivalMs_(data, 'R', 7);
  bridge.stopAudioForwarding();
  assert.deepEqual(calls.at(-1), ['stopG2AudioForwarding']);
  const off = bridge.addAudioMonitorListener((p, arm, ms) => packets.push([...p, arm, ms]));
  const [addName, monitor] = calls.at(-1);
  assert.equal(addName, 'addAudioMonitorListenerNsDataListener');
  monitor.onAudioPacketDataArmArrivalMs(data, 'L', 9);
  off();
  assert.deepEqual(calls.at(-1), ['removeAudioMonitorListenerNsDataListener', monitor]);
  assert.deepEqual(packets, [[1, 2, 'R', 7], [1, 2, 'L', 9]]);
  const records = [];
  const offStatus = bridge.addMicStatusListener((body, arm) => records.push([...body, arm]));
  const [statusName, status] = calls.at(-1);
  assert.equal(statusName, 'addMicStatusListenerListener'); assert.equal(status.protocol, 'mic');
  status.onMicStatusBodyArm({ size: 2, getIndex: i => [77, 67][i] }, 'L');
  offStatus();
  assert.deepEqual(calls.at(-1), ['removeMicStatusListenerListener', status]);
  assert.deepEqual(records, [[77, 67, 'L']]);
  assert.equal(bridge.sendFaceclawMicControl(new Uint8Array([1, 2, 3]).subarray(1), 'query', true, false), true);
  const [sendName, record, ...sendArgs] = calls.at(-1);
  assert.equal(sendName, 'sendFaceclawMicControlRecordLabelRightTempleLeftTemple');
  assert.deepEqual([[...record], ...sendArgs], [[2, 3], 'query', true, false]);
});

test('iOS forwarding and the voice mic share one capture slot: STT wins and neither release stops the other', async () => {
  const { calls, native } = nativeSession({ startG2AudioForwardingNsDataListener: true, isSessionReady: true,
    startG2AudioCaptureNsDataListener: true, isAudioCaptureActive: true });
  const { FaceclawCommunicatorBridge: Bridge } = loader({
    setTimeout, NativeClass: () => c => c, NSObject: class { static new() { return new this(); } },
    FaceclawKitFaceclawBleCommunicatorListener: {}, FaceclawKitIosAncsListener: {}, FaceclawKitIosAudioPacketListener: {},
    FaceclawKitFaceclawCompassListener: {},
    FaceclawKitIosGlassesSession: { alloc: () => ({ initWithRightAddressLeftAddressRingAddress: () => native }) },
  }, { '@nativescript/core': {}, './ios-graphics': {}, './ios-bluetooth': {}, './kotlin-listener.ios': { kotlinListener } })(
    'app/native/faceclaw-communicator.ios.ts');
  const bridge = new Bridge({ right: 'r', left: 'l' });
  const names = () => calls.map(([name]) => name).filter(name => /Audio(Capture|Forwarding)/.test(name));
  assert.equal(bridge.isAudioCaptureActive(), true);
  assert.equal(bridge.startAudioForwarding(() => {}), true);
  await bridge.setMicrophone(false);
  assert.deepEqual(names(), ['isAudioCaptureActive', 'startG2AudioForwardingNsDataListener'], 'a stale voice release leaves forwarding alone');
  await bridge.setMicrophone(true, () => {});
  assert.equal(bridge.startAudioForwarding(() => {}), false, 'refused while STT or the raw tap holds the mic');
  bridge.stopAudioForwarding();
  assert.deepEqual(names().slice(2), ['startG2AudioCaptureNsDataListener'], 'the preempted forwarder cannot stop the voice capture');
  await bridge.setMicrophone(false);
  assert.equal(bridge.startAudioForwarding(() => {}), true);
  bridge.stopAudioForwarding();
  assert.deepEqual(names().slice(3), ['stopG2AudioCapture', 'startG2AudioForwardingNsDataListener', 'stopG2AudioForwarding']);
});

test('an enable superseded while it waits for the native queue never takes the slot from forwarding', async () => {
  const { calls, native } = nativeSession({ startG2AudioForwardingNsDataListener: true, isSessionReady: true,
    startG2AudioCaptureNsDataListener: true });
  const { FaceclawCommunicatorBridge: Bridge } = loader({
    setTimeout, NativeClass: () => c => c, NSObject: class { static new() { return new this(); } },
    FaceclawKitFaceclawBleCommunicatorListener: {}, FaceclawKitIosAncsListener: {}, FaceclawKitIosAudioPacketListener: {},
    FaceclawKitFaceclawCompassListener: {},
    FaceclawKitIosGlassesSession: { alloc: () => ({ initWithRightAddressLeftAddressRingAddress: () => native }) },
  }, { '@nativescript/core': {}, './ios-graphics': {}, './ios-bluetooth': {}, './kotlin-listener.ios': { kotlinListener } })(
    'app/native/faceclaw-communicator.ios.ts');
  const bridge = new Bridge({ right: 'r', left: 'l' });
  const enable = bridge.setMicrophone(true, () => {});
  // Past the token check, parked on the native call timer.
  for (let i = 0; i < 20; i++) await null;
  const disable = bridge.setMicrophone(false);
  assert.equal(bridge.startAudioForwarding(() => {}), true);
  await enable; await disable;
  const names = calls.map(([name]) => name).filter(name => /Audio(Capture|Forwarding)/.test(name));
  assert.deepEqual(names, ['startG2AudioForwardingNsDataListener'], 'the stale enable stays off the glasses');
});

test('iOS audio monitor follows the active bridge and maps arms', () => {
  let active = null;
  const calls = [];
  const fake = {
    getNativeCommunicator: () => ({ isAudioCaptureActive: () => true }),
    addAudioMonitorListener: l => { calls.push(['packet', l]); return () => calls.push(['offPacket']); },
    addMicStatusListener: l => { calls.push(['status', l]); return () => { throw new Error('torn down'); }; },
  };
  const api = loader({}, { './faceclaw-communicator.ios': { FaceclawCommunicatorBridge: { getActive: () => active } } })(
    'app/native/audio-monitor.ios.ts');
  assert.equal(api.audioMonitorCommunicator(), null);
  assert.equal(api.isFaceclawAudioCaptureActive(), false);
  api.addAudioMonitorListeners(null, () => {}, () => {})();
  active = fake;
  assert.equal(api.audioMonitorCommunicator(), fake);
  assert.equal(api.isFaceclawAudioCaptureActive(), true);
  const got = [];
  const off = api.addAudioMonitorListeners(fake, (d, arm, ms) => got.push([d, arm, ms]), (b, arm) => got.push([b, arm]));
  calls[0][1]('pcm', 'R', 5); calls[0][1]('pcm', 'x', 6); calls[1][1]('st', 'L');
  assert.deepEqual(got, [['pcm', 'R', 5], ['pcm', '?', 6], ['st', 'L']]);
  off();
  assert.deepEqual(calls.at(-1), ['offPacket'], 'a torn-down session does not throw out of unsubscribe');
});

test('iOS screen recording feeds composites to the Kotlin GIF recorder and saves under Documents', () => {
  const { calls, native } = nativeSession({ previewComposite: { pixels: 'gray', width: 640, height: 480 } });
  const added = [], written = [];
  let gif = 'gif-bytes';
  const recorder = { addGrayWidthHeightTimestampMs: (...args) => added.push(args), encode: () => gif };
  const core = { knownFolders: { documents: () => ({ path: '/docs' }) }, path: { join: (...parts) => parts.join('/') },
    File: { fromPath: p => ({ writeSync: data => written.push([p, data]) }) } };
  const { FaceclawCommunicatorBridge: Bridge } = loader({
    setTimeout, NativeClass: () => c => c, NSObject: class { static new() { return new this(); } },
    FaceclawKitFaceclawBleCommunicatorListener: {}, FaceclawKitIosAncsListener: {}, FaceclawKitIosAudioPacketListener: {},
    FaceclawKitFaceclawCompassListener: {}, FaceclawKitFaceclawImuListener: 'imu', FaceclawKitIosGifRecorder: { new: () => recorder },
    FaceclawKitIosGlassesSession: { alloc: () => ({ initWithRightAddressLeftAddressRingAddress: () => native }) },
  }, { '@nativescript/core': core, './ios-graphics': {}, './ios-bluetooth': {}, './kotlin-listener.ios': { kotlinListener } })(
    'app/native/faceclaw-communicator.ios.ts');
  const bridge = new Bridge({ right: 'r', left: 'l' });
  bridge.recordScreenFrame();
  assert.equal(calls.filter(c => c[0] === 'previewComposite').length, 0, 'idle: nothing composites');
  assert.equal(bridge.stopScreenRecording(), '');
  bridge.startScreenRecording(); bridge.recordScreenFrame();
  assert.deepEqual(added.map(a => a.slice(0, 3)), [['gray', 640, 480]]);
  const saved = bridge.stopScreenRecording();
  assert.match(saved, /^\/docs\/recording-\d{8}-\d{6}-\d{3}\.gif$/);
  assert.deepEqual(written, [[saved, 'gif-bytes']]);
  bridge.startScreenRecording(); gif = null;
  assert.equal(bridge.stopScreenRecording(), '', 'no frames: no file');
  assert.equal(written.length, 1);
});

test('iOS mic control queries both temples through the active bridge and decodes their status records', () => {
  const sent = [], offs = [];
  let active = null, listener = null;
  const bridgeFor = name => ({
    sendFaceclawMicControl: (record, ...rest) => { sent.push([name, record instanceof Uint8Array, record[0], ...rest]); return true; },
    addMicStatusListener: fn => { listener = fn; return () => offs.push(name); },
  });
  const { micArrayController } = loader({ global: { isIOS: true } }, {
    '../../native/settings-store': {}, '../../ui/dashboard-settings': { useMicControlSetting: { get: () => false } },
    '../../native/cloud-stt': { toJavaBytes: () => { throw new Error('Android only'); } },
    '../../util/array-util': {}, '../../native/audio-monitor': { audioMonitorCommunicator: () => active },
  })('app/apps/microphones/mic-control.ts');
  assert.equal(micArrayController.query(), false, 'no session');
  active = bridgeFor('first');
  assert.equal(micArrayController.query(), true);
  const statuses = [];
  micArrayController.onStatus(s => statuses.push(s));
  const body = new Uint8Array(21); body.set([0x4d, 0x43, 1, 1]); body[14] = 2;
  listener(body, 'L');
  assert.equal(statuses.at(-1).left.active, true); assert.equal(statuses.at(-1).left.side, 'left');
  active = bridgeFor('second'); micArrayController.query();
  assert.deepEqual(offs, ['first'], 'a new session moves the status listener');
  assert.deepEqual(sent.map(([name, bytes, magic, label, right, left]) => [name, bytes, label, right, left]),
    [['first', true, 'query', true, true], ['second', true, 'query', true, true]]);
});
