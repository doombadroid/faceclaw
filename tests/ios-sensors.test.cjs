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

test('iOS Developer debug tests enable the buzzer, accelerometer and light sensor demos', () => {
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
  for (const label of ['Buzzer demo', 'Accelerometer demo', 'Light sensor', 'BLE bandwidth']) {
    assert.ok(!byLabel[label].disabled, label); assert.equal(byLabel[label].description, undefined, label);
  }
});
