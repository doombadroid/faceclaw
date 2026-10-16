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
// Models NativeScript's Image on iOS: src is applied last and wraps an ImageSource in a
// copy; teardown nulls the native image of whatever imageSource the view holds.
class Image extends View {
  get src() { return this._src; }
  set src(value) { this._src = value; this.imageSource = typeof value === 'string' ? { symbol: value } : { ios: value.ios }; }
  dispose() { if (this.imageSource) this.imageSource.ios = null; }
}
// Sections and rows are plain options here; walk them to the views they hold.
const teardown = node => {
  if (!node) return;
  node.dispose?.();
  [...(node.children ?? []), ...(node.rows ?? []), node.view, node.tile].forEach(teardown);
};

function setup({ state = null, configured = true, serial = '', apps = [], installed = [], notifications = '2 of 3' } = {}) {
  const calls = [], listeners = new Map(), settingListeners = new Set();
  const settings = { brightness: 'auto', mirrorTouch: true, notifications }, env = { configured, installed };
  let build = null, container = null, refreshes = 0;
  const page = { handlers: {}, height: 800, on(event, fn) { this.handlers[event] = fn; }, getActualSize() { return { width: 0, height: this.height }; } };
  const row = kind => options => ({ kind, ...options });
  const runtime = {
    connected: false, evenHubButton: null, frame: null, mirrors: 0,
    acquireMirror() { this.mirrors++; return () => { this.mirrors--; }; },
    controller: { connectionState: state, connectionDetails: 'details', showEvenHubPhoneUi: id => calls.push(['phoneUi', id]),
      connect: () => calls.push(['connect']), disconnect: () => calls.push(['disconnect']) },
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); },
  };
  const load = loader({ setTimeout: fn => fn() }, {
    '@nativescript/core': { Dialogs: { alert: options => calls.push(['alert', options.message]) },
      GridLayout, StackLayout: View, Image, Label: View },
    './ui-kit': {
      groupedPage: options => {
        build = options.build;
        const refresh = () => { refreshes++; if (container) teardown(container); container = new View(); build(container); };
        refresh();
        return { page, refresh };
      },
      section: options => options,
      navRow: row('nav'), buttonRow: row('button'), switchRow: row('switch'),
      customRow: view => ({ kind: 'custom', view }),
      tile: (symbol, color) => { const box = new View(); box.symbol = symbol; box.color = color; const icon = new Image(); icon.src = `sys://${symbol}`; box.addChild(icon); return box; },
    },
    './runtime': { getRuntime: () => runtime },
    './detour': { presentDetour: (...args) => calls.push(['detour', ...args]) },
    './connection-details': { showConnectionDetails: () => calls.push(['details']) },
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
      mirrorTouchSetting: { label: 'Touch mirror', get: () => settings.mirrorTouch, set: value => { settings.mirrorTouch = value; } },
      onAnySettingChanged: fn => { settingListeners.add(fn); return () => settingListeners.delete(fn); },
    },
    '../../apps/all-apps': { ALL_APPS: apps },
    '../../apps/evenhub/installed-apps': { getInstalledEvenHubApps: () => env.installed, getInstalledEvenHubFingerprint: () => JSON.stringify(env.installed) },
    './settings-page': { categoryValue: id => id === 'notifications' ? settings.notifications : '' },
  });
  const api = load('app/phone-ui/ios/glasses-page.ts');
  api.createPage();
  page.handlers.loaded();
  const sections = () => container.children;
  const rows = () => sections().flatMap(section => section.rows);
  const find = title => rows().find(r => r.title === title);
  const texts = view => [view.text, ...view.children.flatMap(texts)].filter(Boolean);
  const card = () => sections()[0].rows[0].view;
  const slot = () => sections().find(section => section.header === 'Lens').rows[0].view.children[0];
  const mirror = () => slot().children[0];
  const settingsChanged = () => { for (const fn of [...settingListeners]) fn(); };
  return { api, page, runtime, calls, listeners, settings, env, mirror, slot, settingListeners, sections, rows, find, texts, card,
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

test('My Glasses lens footer only claims the glasses when they are connected', () => {
  const page = setup();
  const footer = () => page.sections().find(section => section.header === 'Lens').footer;
  assert.match(footer(), /preview while no glasses are connected/);
  page.setState(connected);
  assert.match(footer(), /A live copy of what the glasses show/);
});

test('My Glasses rebuilds only when shown values change, and swaps mirror frames in place', () => {
  const page = setup({ state: connected });
  const before = page.refreshes();
  page.setState({ ...connected, frames: 99 });
  assert.equal(page.refreshes(), before, 'frame acks do not rebuild');
  const mirror = page.mirror();
  const frame1 = { image: { ios: 'frame-1' }, focus: '' };
  page.runtime.frame = frame1; page.listeners.get('frame')(frame1);
  assert.equal(mirror.imageSource.ios, 'frame-1');
  assert.equal(page.refreshes(), before, 'mirror frames never rebuild the page');
  page.setState({ ...connected, battery: 83 });
  assert.equal(page.refreshes(), before + 1);
  assert.equal(frame1.image.ios, 'frame-1', 'tearing down the old mirror leaves the shared cached frame intact');
  assert.equal(page.mirror().imageSource.ios, 'frame-1', 'the rebuilt mirror shows the cached frame');
  page.listeners.get('frame')({ image: { ios: 'frame-2' }, focus: '' });
  assert.equal(page.mirror().imageSource.ios, 'frame-2', 'frames reach the rebuilt mirror');
  const slot = page.slot(), lens = slot.children[0];
  slot.width = 400; slot.handlers.layoutChanged();
  assert.deepEqual([lens.width, lens.height, lens.horizontalAlignment], [400, 300, 'center'], 'card-wide, 4:3 like the panel, centred');
  lens.handlers.tap();
  assert.deepEqual(page.calls.at(-1), ['push', 'glasses', 'ocusmart/remote']);
});

test('My Glasses caps the lens mirror to the visible height and 560pt, keeping 4:3', () => {
  const page = setup({ state: connected }), slot = page.slot(), lens = page.mirror();
  const size = (width, height) => { slot.width = width; page.page.height = height; slot.handlers.layoutChanged(); return [lens.width, lens.height]; };
  assert.deepEqual(size(337, 852), [337, 252.75], 'iPhone portrait: card-wide, as before');
  assert.deepEqual(size(694, 393), [310.6666666666667, 233], 'iPhone landscape: the page height minus 160pt, not 520pt tall');
  assert.deepEqual(size(895, 669), [560, 420], 'iPhone Duo inner display: 560pt wide, not 671pt tall in a 669pt window');
  page.setState({ ...connected, battery: 12 });
  const rebuilt = page.mirror();
  assert.notEqual(rebuilt, lens);
  assert.deepEqual([rebuilt.width, rebuilt.height], [560, 420], 'a rebuilt mirror starts capped, not card-wide for a frame');
  assert.equal(page.api.lensMirrorWidth(300, 100), 0, 'never negative');
  const before = [lens.width, lens.height];
  page.page.height = 0; slot.width = 100; slot.handlers.layoutChanged();
  assert.deepEqual([lens.width, lens.height], before, 'a page not laid out yet changes nothing');
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

test('My Glasses counts launchable apps that run on iOS, plus installed EvenHub packages, and follows installs', () => {
  // app-catalog's rule, the Apps tab's BUILT IN + FROM EVEN HUB: no launcher, onboarding, glasses Settings or iOS-unavailable apps.
  const apps = [{ appId: 'launcher', showInLauncher: false }, { appId: 'onboarding' }, { appId: 'settings' },
    { appId: 'timer' }, { appId: 'music' }, { appId: 'weather' }];
  const page = setup({ apps, installed: [{ packageId: 'a' }, { packageId: 'b' }] });
  assert.equal(page.find('Apps on Glasses').value, '4');
  page.find('Apps on Glasses').onTap();
  assert.deepEqual(page.calls.at(-1), ['tab', 'apps']);
  // An install from the glasses store writes a setting while this page is on screen.
  page.env.installed = [...page.env.installed, { packageId: 'c' }]; page.settingsChanged();
  assert.equal(page.find('Apps on Glasses').value, '5');
});

test('My Glasses routes rows to their pages', () => {
  const page = setup();
  // Calls carry objects from the vm realm; clone them into this one to compare.
  const tap = title => { page.find(title).onTap(); return structuredClone(page.calls.at(-1)); };
  assert.deepEqual(tap('Display & Brightness'), ['push', 'glasses', 'ocusmart/settings-category', { category: 'display' }]);
  assert.equal(page.find('Notifications').value, '2 of 3');
  assert.deepEqual(tap('Notifications'), ['push', 'glasses', 'ocusmart/settings-category', { category: 'notifications' }]);
  assert.deepEqual(tap('Remote & Touchpads'), ['push', 'glasses', 'ocusmart/remote']);
  assert.equal(page.find('Software Update').tile.symbol, 'arrow.down.circle.fill', 'the same glyph as on Settings');
  // The Set Up intro first, as from the Device page; its Back/Cancel closes the detour.
  assert.deepEqual(tap('Pair Glasses'), ['detour', 'ocusmart/setup']);
  assert.deepEqual(tap('Device Settings'), ['push', 'glasses', 'ocusmart/device']);
  tap('Connection Details');
  assert.deepEqual(page.calls.at(-1), ['details']);
  // One entry point per device action: Device Settings holds them.
  for (const title of ['Configure Devices', 'Check Firmware', 'Install Custom Firmware', 'Uninstall Custom Firmware', 'Permissions']) {
    assert.equal(page.find(title), undefined, title);
  }
  assert.equal(page.sections().some(section => section.header === 'Firmware & Devices'), false);
  assert.equal(page.rows().find(r => r.kind === 'switch').title, 'Touch mirror', "the setting's own name, as in Settings");
});

test('My Glasses shows firmware and battery only while the session still reports them', () => {
  const page = setup({ state: connected });
  // A user disconnect keeps the old values in the controller; they are not current any more.
  page.setState({ ...connected, phase: 'disconnected', status: 'Preview only' });
  assert.deepEqual(page.texts(page.card()), ['Even G2', 'Not Connected', 'Firmware not reported yet']);
  // Stock firmware halts the session: what it reported is why, and the warning pages show it.
  const halted = { ...connected, phase: 'error', status: 'Incompatible firmware', capabilities: '', firmwareWarning: 'Stock firmware' };
  page.setState(halted);
  assert.deepEqual(page.texts(page.card()), ['Even G2', 'Connection Failed', 'Stock firmware 2.3.0.24'], 'its battery froze when the link closed');
  assert.ok(page.find('Attention Needed'));
  assert.equal(page.find('Software Update').badge, '1');
  page.setState({ ...halted, phase: 'disconnected' });
  assert.equal(page.find('Attention Needed'), undefined, 'no warning once nothing reports it');
  assert.equal(page.find('Software Update').badge, undefined);
});

test('My Glasses offers Open <App> on iPhone only for a button with an icon', () => {
  const page = setup();
  page.runtime.evenHubButton = { windowId: 'w', title: 'Maps', icon: null };
  page.listeners.get('evenHubButton')(page.runtime.evenHubButton);
  assert.equal(page.find('Open Maps on iPhone'), undefined);
  const icon = { ios: 'icon' };
  page.runtime.evenHubButton = { windowId: 'w', title: 'Maps', icon };
  page.listeners.get('evenHubButton')(page.runtime.evenHubButton);
  const open = page.find('Open Maps on iPhone');
  assert.equal(open.tile.children[0].imageSource.ios, 'icon', 'the app icon replaces the sys:// placeholder');
  page.listeners.get('detour')(false);
  assert.equal(icon.ios, 'icon', 'a rebuild leaves the cached app icon intact');
  assert.equal(page.find('Open Maps on iPhone').tile.children[0].imageSource.ios, 'icon');
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

test('My Glasses counts its lens mirror as shown exactly while loaded', () => {
  // TabView unloads a hidden tab and pushing Remote unloads this page; both bring it back with loaded.
  const page = setup();
  assert.equal(page.runtime.mirrors, 1, 'loaded: the lens shows');
  page.listeners.get('detour')(false); page.setState(connected);
  assert.equal(page.runtime.mirrors, 1, 'rebuilding the lens keeps one count');
  page.page.handlers.loaded(); assert.equal(page.runtime.mirrors, 1, 'a repeated loaded holds one count');
  page.page.handlers.unloaded(); assert.equal(page.runtime.mirrors, 0, 'another tab, or Remote pushed over it');
  page.page.handlers.unloaded(); assert.equal(page.runtime.mirrors, 0, 'a repeated unloaded releases nothing more');
  page.page.handlers.loaded(); assert.equal(page.runtime.mirrors, 1, 'back on the tab, or Remote popped');
});
