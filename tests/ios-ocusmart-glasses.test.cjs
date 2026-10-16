const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

// My Glasses (app/phone-ui/ios/glasses-page.ts) with NativeScript, the UI kit and
// the runtime stubbed; firmware-info, artwork, hardware identity and iOS
// availability run for real.
class View {
  constructor() { this.children = []; this.handlers = {}; this.width = 0; }
  addChild(child) { this.children.push(child); }
  getChildAt(i) { return this.children[i]; }
  on(event, fn) { this.handlers[event] = fn; }
  getActualSize() { return { width: this.width, height: 0 }; }
}
class GridLayout extends View { static setColumn() {} }

function setup({ state = null, configured = true, serial = '', apps = [], installed = [] } = {}) {
  const calls = [], listeners = new Map(), settingListeners = new Set();
  const settings = { brightness: 'auto', mirrorTouch: true }, env = { configured };
  let build = null, container = null, refreshes = 0;
  const page = { handlers: {}, on(event, fn) { this.handlers[event] = fn; } };
  const row = kind => options => ({ kind, ...options });
  const runtime = {
    connected: false, evenHubButton: null, frame: null,
    controller: { connectionState: state, connectionDetails: 'details', showEvenHubPhoneUi: id => calls.push(['phoneUi', id]),
      connect: () => calls.push(['connect']), disconnect: () => calls.push(['disconnect']) },
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); },
  };
  const load = loader({ setTimeout: fn => fn() }, {
    '@nativescript/core': { Dialogs: { alert: options => calls.push(['alert', options.message]) },
      GridLayout, StackLayout: View, Image: View, Label: View },
    './ui-kit': {
      groupedPage: options => {
        build = options.build;
        const refresh = () => { refreshes++; container = new View(); build(container); };
        refresh();
        return { page, refresh };
      },
      section: options => options,
      navRow: row('nav'), buttonRow: row('button'), switchRow: row('switch'),
      customRow: view => ({ kind: 'custom', view }),
      tile: (symbol, color) => { const box = new View(); box.symbol = symbol; box.color = color; box.addChild(new View()); return box; },
    },
    './runtime': { getRuntime: () => runtime },
    './detour': { presentDetour: (...args) => calls.push(['detour', ...args]) },
    './firmware-alert': { showFirmwareAlert: message => calls.push(['firmwareAlert', message]) },
    './shell': { pushInTab: (...args) => calls.push(['push', ...args]), selectTab: name => calls.push(['tab', name]) },
    '../onboarding-state': { isPreviewOnlyMode: () => false },
    '../../g2/reconnect-policy': { suppressAutoReconnect() {}, resumeAutoReconnect() {} },
    '../../g2/device-addresses': { loadDeviceAddresses: () => env.configured,
      loadPairedGlassesIdentityForAddresses: () => serial ? { serial } : null },
    '../../g2/ios-peripheral-identity': { deviceAddressError: ok => ok ? null : 'missing' },
    '../../ui/dashboard-settings': {
      brightnessSetting: { get: () => settings.brightness },
      brightnessLabel: value => value === 'auto' ? 'Auto' : value,
      mirrorTouchSetting: { get: () => settings.mirrorTouch, set: value => { settings.mirrorTouch = value; } },
      onAnySettingChanged: fn => { settingListeners.add(fn); return () => settingListeners.delete(fn); },
    },
    '../../apps/all-apps': { ALL_APPS: apps },
    '../../apps/evenhub/installed-apps': { getInstalledEvenHubApps: () => installed },
  });
  const api = load('app/phone-ui/ios/glasses-page.ts');
  api.createPage();
  page.handlers.loaded();
  const sections = () => container.children;
  const rows = () => sections().flatMap(section => section.rows);
  const find = title => rows().find(r => r.title === title);
  const texts = view => [view.text, ...view.children.flatMap(texts)].filter(Boolean);
  const card = () => sections()[0].rows[0].view;
  const mirror = () => sections().find(section => section.header === 'Lens').rows[0].view.children[0];
  const settingsChanged = () => { for (const fn of [...settingListeners]) fn(); };
  return { api, page, runtime, calls, listeners, settings, env, mirror, settingListeners, sections, rows, find, texts, card,
    settingsChanged, refreshes: () => refreshes,
    setState: next => { runtime.controller.connectionState = next; listeners.get('connection')(next); } };
}

const connected = { phase: 'connected', status: 'Connected', battery: 84, charging: true, ring: false, frames: 1,
  capabilities: 'Faceclaw/37', leftVersion: '2.3.0.24', rightVersion: '2.3.0.24', firmwareWarning: '' };

test('My Glasses card says what is known and nothing more', () => {
  const page = setup();
  const text = page.texts(page.card());
  assert.deepEqual(text, ['Even G2', 'Not Connected', 'Firmware not reported yet'], 'no battery before the glasses report one');
  assert.equal(page.card().children[0].src, '~/images/glasses/even_realities_g2.png');

  page.setState(connected);
  assert.deepEqual(page.texts(page.card()), ['Even G2', 'Connected', 'Faceclaw firmware r37 · base 2.3.0.24', 'Battery · Charging', '84%']);
  const battery = page.card().children.at(-1);
  assert.equal(battery.children[0].children[0].width.value, 0.84);
  page.setState({ ...connected, charging: false, battery: 50 });
  assert.deepEqual(page.texts(page.card()).slice(-2), ['Battery', '50%']);
  page.setState({ ...connected, battery: null });
  assert.equal(page.texts(page.card()).some(t => t.includes('%')), false);
});

test('My Glasses card shows the paired SKU art', () => {
  const page = setup({ serial: 'S211GBBC180304' });
  assert.notEqual(page.card().children[0].src, '~/images/glasses/even_realities_g2.png');
  assert.match(page.card().children[0].src, /^~\/images\/glasses\/.+\.png$/);
});

test('My Glasses rebuilds only when shown values change, and swaps mirror frames in place', () => {
  const page = setup({ state: connected });
  const before = page.refreshes();
  page.setState({ ...connected, frames: 99 });
  assert.equal(page.refreshes(), before, 'frame acks do not rebuild');
  const mirror = page.mirror();
  page.listeners.get('frame')({ image: 'frame-1', focus: '' });
  assert.equal(mirror.imageSource, 'frame-1');
  assert.equal(page.refreshes(), before, 'mirror frames never rebuild the page');
  page.setState({ ...connected, battery: 83 });
  assert.equal(page.refreshes(), before + 1);
  page.listeners.get('frame')({ image: 'frame-2', focus: '' });
  assert.equal(page.mirror().imageSource, 'frame-2', 'frames reach the rebuilt mirror');
  mirror.width = 400; mirror.handlers.layoutChanged();
  assert.equal(mirror.height, 300, 'mirror keeps the panel 4:3');
  mirror.handlers.tap();
  assert.deepEqual(page.calls.at(-1), ['push', 'glasses', 'ocusmart/remote']);
});

test('My Glasses mirror-touch switch writes the setting without rebuilding; other setting changes rebuild', () => {
  const page = setup();
  const toggle = page.rows().find(r => r.kind === 'switch');
  assert.equal(toggle.value, true);
  const before = page.refreshes();
  toggle.onChange(false); page.settingsChanged();
  assert.equal(page.settings.mirrorTouch, false);
  assert.equal(page.refreshes(), before);
  assert.equal(page.find('Display & Brightness').value, 'Auto');
  page.settings.brightness = '50'; page.settingsChanged();
  assert.equal(page.refreshes(), before + 1);
  assert.equal(page.find('Display & Brightness').value, '50');
});

test('My Glasses firmware warning adds Attention Needed and the update badge', () => {
  const page = setup({ state: connected });
  assert.equal(page.find('Attention Needed'), undefined);
  assert.equal(page.find('Software Update').badge, undefined);
  page.setState({ ...connected, firmwareWarning: 'Stock firmware' });
  page.find('Attention Needed').onTap();
  assert.deepEqual(page.calls.at(-1), ['firmwareAlert', 'Stock firmware']);
  assert.equal(page.find('Software Update').badge, '1');
  page.find('Software Update').onTap();
  assert.deepEqual(page.calls.at(-1), ['push', 'glasses', 'ocusmart/update']);
});

test('My Glasses counts launchable apps that run on iOS, plus installed EvenHub packages', () => {
  const apps = [{ appId: 'launcher', showInLauncher: false }, { appId: 'timer' }, { appId: 'music' }, { appId: 'weather' }];
  const page = setup({ apps, installed: [{ packageId: 'a' }, { packageId: 'b' }] });
  assert.equal(page.api.appsOnGlassesCount(), 4);
  assert.equal(page.find('Apps on Glasses').value, '4');
  page.find('Apps on Glasses').onTap();
  assert.deepEqual(page.calls.at(-1), ['tab', 'apps']);
});

test('My Glasses routes rows to their pages', () => {
  const page = setup();
  // Calls carry objects from the vm realm; clone them into this one to compare.
  const tap = title => { page.find(title).onTap(); return structuredClone(page.calls.at(-1)); };
  assert.deepEqual(tap('Display & Brightness'), ['push', 'glasses', 'ocusmart/settings-category', { category: 'display' }]);
  assert.deepEqual(tap('Notifications'), ['push', 'glasses', 'ocusmart/settings-category', { category: 'notifications' }]);
  assert.deepEqual(tap('Remote & Touchpads'), ['push', 'glasses', 'ocusmart/remote']);
  assert.deepEqual(tap('Pair Glasses'), ['detour', 'ocusmart/setup']);
  assert.deepEqual(tap('Device Settings'), ['push', 'glasses', 'ocusmart/device']);
  assert.deepEqual(tap('Install Custom Firmware'), ['detour', 'phone-ui/onboarding-flash-page', { mode: 'install', fromOnboarding: false }]);
  assert.deepEqual(tap('Uninstall Custom Firmware'), ['detour', 'phone-ui/onboarding-flash-page', { mode: 'uninstall', fromOnboarding: false }]);
  assert.deepEqual(tap('Permissions'), ['detour', 'phone-ui/permissions-page', undefined, false]);
  for (const title of ['Configure Devices', 'Check Firmware', 'Connection Details']) assert.ok(page.find(title), title);
});

test('My Glasses offers Open <App> on iPhone only for a button with an icon', () => {
  const page = setup();
  page.runtime.evenHubButton = { windowId: 'w', title: 'Maps', icon: null };
  page.listeners.get('evenHubButton')(page.runtime.evenHubButton);
  assert.equal(page.find('Open Maps on iPhone'), undefined);
  page.runtime.evenHubButton = { windowId: 'w', title: 'Maps', icon: 'icon' };
  page.listeners.get('evenHubButton')(page.runtime.evenHubButton);
  const open = page.find('Open Maps on iPhone');
  assert.equal(open.tile.children[0].imageSource, 'icon');
  open.onTap();
  assert.deepEqual(page.calls.at(-1), ['phoneUi', 'w']);
});

test('My Glasses offers Connect as soon as a detour that saved devices closes', () => {
  const page = setup({ configured: false });
  assert.equal(page.find('Connect'), undefined, 'no Connect without saved devices');
  // Configure Devices saves inside a detour; the page stays loaded under it.
  page.env.configured = true;
  const before = page.refreshes();
  page.listeners.get('detour')(true); assert.equal(page.refreshes(), before);
  page.listeners.get('detour')(false); assert.equal(page.refreshes(), before + 1, 'it must rebuild when the detour closes');
  page.find('Connect').onTap();
  assert.deepEqual(page.calls.at(-1), ['connect']);
  page.page.handlers.unloaded();
  assert.equal(page.listeners.size, 0); assert.equal(page.settingListeners.size, 0);
});
