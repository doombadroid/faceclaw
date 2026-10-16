const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const hex = bytes => bytes.map(b => b.toString(16).padStart(2, '0')).join('');
const ascii = s => hex([...s].map(c => c.charCodeAt(0)));
const wire = mac => hex(mac.split(':').map(h => parseInt(h, 16)).reverse());
const arm = (side, serial, mac) => [`Even G2_32_${side}_${mac.replace(/:/g, '').slice(-6)}`, '4552' + ascii(serial) + wire(mac) + '01'];

// iOS has no bond list: "Load Remembered Devices" rebuilds candidates from what past scans identified.
function fixture(store) {
  let scanListener = null;
  const native = { setScanListenerListener: listener => { scanListener = listener; } };
  const ApplicationSettings = { getAllKeys: () => [...store.keys()], getString: (k, d) => store.get(k) ?? d,
    setString: (k, v) => store.set(k, v), remove: k => store.delete(k) };
  const load = loader({ FaceclawKitIosBleCentral: { alloc: () => ({ initWithPlatform: () => native }) },
    FaceclawKitIosProtocolPlatform: { shared: {} }, FaceclawKitIosBleScanListener: {}, Date }, {
    '@nativescript/core': { ApplicationSettings }, './kotlin-listener.ios': { kotlinListener: (_protocol, methods) => methods },
    '../branding': { APP_NAME: 'OcuSmart' },
  });
  const ble = load('app/native/ios-bluetooth.ts').iosBluetooth();
  const advertise = (id, [name, data]) => scanListener.onAdvertisementIdentifierNameManufacturerDataHexRssiConnectable(id, name, data, -50, true);
  return { ble, advertise, discovery: load('app/native/device-discovery.ios.ts') };
}

test('Load Remembered Devices returns the pair a past scan identified, joined on its serial', async () => {
  const store = new Map();
  const first = fixture(store);
  first.advertise('11111111-1111-1111-1111-111111111111', arm('L', 'S211GBBC180304', 'E0:12:14:AC:D4:58'));
  first.advertise('22222222-2222-2222-2222-222222222222', arm('R', 'S211GBBC180304', 'E0:12:14:8D:6E:3C'));
  // Saved before names were kept: no manufacturer data, so nothing to classify.
  store.set('ios.ble.peripheral.E0:12:14:00:00:01', JSON.stringify({ identifier: '33333333-3333-3333-3333-333333333333', role: 'left' }));
  // A later launch: no live advertisements, only the persisted map.
  const later = fixture(store);
  assert.equal(later.ble.devices.size, 0);
  const candidates = await new later.discovery.DeviceDiscoveryBridge().getBondedCandidates();
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(candidate => candidate.source === 'paired' && candidate.bonded));
  const selection = later.discovery.buildAddressSet(candidates);
  assert.deepEqual([selection.left, selection.right], ['E0:12:14:AC:D4:58', 'E0:12:14:8D:6E:3C']);
  assert.match(selection.summary, /serial S211GBBC180304/);
  // Connect still finds the identifiers in the same entries.
  const resolved = await Object.assign(later.ble, { state: 5 }).resolveDevices({ left: 'E0:12:14:AC:D4:58', right: 'E0:12:14:8D:6E:3C', ring: '' });
  assert.deepEqual({ ...resolved }, { left: '11111111-1111-1111-1111-111111111111', right: '22222222-2222-2222-2222-222222222222' });
});

test('Configure Devices offers Load Remembered Devices on iOS', async () => {
  const noop = new Proxy(function () {}, { get: () => noop, apply: () => undefined });
  class Observable { notifyPropertyChange() {} }
  const known = {
    '@nativescript/core': { Observable, Frame: noop },
    '../native/ble-permissions': { ensureBlePermissions: async () => {} },
    '../g2/device-addresses': { loadDeviceAddresses: () => ({ right: '', left: '', ring: '' }),
      loadPairedGlassesIdentityForAddresses: () => null, normalizeMacAddress: value => value },
    '../native/device-discovery': { DeviceDiscoveryBridge: class { async getBondedCandidates() { return []; } },
      buildAddressSet: () => ({ left: 'E0:12:14:AC:D4:58', right: 'E0:12:14:8D:6E:3C', ring: '', summary: 'two arms' }) },
  };
  const mocks = new Proxy(known, { has: () => true, get: (modules, name) => modules[name] ?? noop });
  const { ConfigViewModel } = loader({ global: { isIOS: true } }, mocks)('app/phone-ui/config-view-model.ts');
  const model = new ConfigViewModel();
  assert.equal(model.loadLabel, 'Load Remembered Devices');
  assert.doesNotMatch(model.status, /paired/);
  await model.onLoadPairedTap();
  assert.equal(model.status, 'Loaded remembered devices.');
  assert.equal(model.leftAddress, 'E0:12:14:AC:D4:58');
});
