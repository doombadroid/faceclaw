const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');

const REQUIRED = 37;
const session = (capabilities, left = '2.3.0.24', right = '2.3.0.24') => ({ phase: 'connected', status: '', battery: null, charging: null,
  ring: false, frames: 0, capabilities, leftVersion: left, rightVersion: right, firmwareWarning: '' });
const STOCK = session(''), CURRENT = session(`Faceclaw/${REQUIRED}`), OLDER = session('Faceclaw/30'),
  LEGACY = session('EVENCFW/1 caps'), OTHER = session('Homebrew/2'), UNREPORTED = session('', '', ''),
  NEWER = session(`Faceclaw/${REQUIRED + 1}`), NEWER_STOCK = session('', '2.3.3.0', '2.3.3.0'),
  // disconnect() keeps the last report; it is stale once the session drops.
  STALE = { ...CURRENT, phase: 'disconnected' },
  // Stock firmware halts the session; what it reported is why, so it stays current until the next connect().
  HALTED = { ...NEWER_STOCK, phase: 'error', status: 'Incompatible firmware', firmwareWarning: 'The glasses report stock firmware' };

test('firmware-info classifies reported firmware for the update, channel and alert screens', () => {
  const info = loader()('app/phone-ui/ios/firmware-info.ts');
  const compat = loader()('app/g2/firmware-compat.ts');
  assert.equal(compat.REQUIRED_FACECLAW_FIRMWARE_VERSION, REQUIRED, 'fixtures track the required revision');
  const ext = state => info.firmwareSummary(state).extension;
  assert.deepEqual([UNREPORTED, null, STOCK, CURRENT, OLDER, LEGACY, OTHER].map(s => info.updateStatus(ext(s))),
    ['unknown', 'unknown', 'available', 'current', 'available', 'available', 'available']);
  assert.equal(info.updateStatus(ext(NEWER)), 'newer', 'reinstalling the bundled revision would downgrade');
  assert.equal(info.reportedState(STALE), null);
  assert.equal(info.reportedState(CURRENT), CURRENT);
  assert.equal(info.reportedState(HALTED), HALTED);
  assert.equal(info.reportedState({ ...HALTED, firmwareWarning: '' }), null, 'a failed connect reports nothing');
  assert.equal(info.reportedState({ ...HALTED, phase: 'disconnected' }), null);
  assert.deepEqual([STOCK, CURRENT, NEWER, LEGACY, OTHER].map(s => info.firmwareKindLabel(ext(s))),
    ['Stock firmware', `Faceclaw r${REQUIRED}`, `Faceclaw r${REQUIRED + 1}`, 'Older Faceclaw', 'Third-party']);
  assert.deepEqual([UNREPORTED, STOCK, CURRENT, OLDER, LEGACY, OTHER].map(s => info.firmwareChannel(ext(s))),
    [null, 'even', 'faceclaw', 'faceclaw', 'faceclaw', null]);
  assert.deepEqual([STOCK, OLDER, LEGACY, OTHER].map(s => info.firmwareAlertTitle(ext(s))),
    ['Stock Firmware Detected', 'Firmware Update Needed', 'Firmware Update Needed', 'Unrecognized Firmware']);
});

test('the advertised image size and revision come from the pinned patch set', () => {
  const info = loader()('app/phone-ui/ios/firmware-info.ts');
  const { CFW_PATCH_SET } = loader()('app/g2/firmware/cfw-patches.ts');
  const { BASE_STOCK_VERSION_TEXT } = loader()('app/g2/firmware-compat.ts');
  const append = CFW_PATCH_SET.patches.filter(op => op.old === '');
  assert.equal(append.length, 1);
  assert.equal(info.firmwareImageBytes(), append[0].offset + append[0].new.length / 2);
  assert.equal(info.firmwareImageBytes({ patches: [{ offset: 10, old: 'aa', new: 'bb' }, { offset: 4_550_000, old: '', new: 'ab'.repeat(50_000) }] }), 4_600_000);
  assert.throws(() => info.firmwareImageBytes({ patches: [] }));
  assert.equal(info.formatMegabytes(4_609_075), '4.6 MB');
  assert.equal(info.formatMegabytes(4_650_000), '4.7 MB');
  // "Faceclaw r37" on the update page names what the pinned image reports.
  assert.ok(CFW_PATCH_SET.patches.some(op => op.new.includes(Buffer.from(`Faceclaw/${REQUIRED}`).toString('hex'))));
  // Restore says it flashes BASE_STOCK_VERSION_TEXT; uninstall flashes the patch set's base.
  assert.ok(CFW_PATCH_SET.base.includes(BASE_STOCK_VERSION_TEXT));
  // The update page repeats the flash page's battery floor.
  const floor = /MIN_FLASH_BATTERY_PERCENT = (\d+)/.exec(fs.readFileSync('app/phone-ui/onboarding-flash-view-model.ts', 'utf8'))[1];
  assert.match(fs.readFileSync('app/phone-ui/ios/update-page.ts', 'utf8'), new RegExp(`at least ${floor}% battery`));
});

function uiHarness(state, extraMocks = {}) {
  const calls = [], confirms = [], built = [];
  let confirmAnswer = true;
  const listeners = new Map();
  const runtime = { controller: { connectionState: state }, on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); } };
  const rowKit = kind => options => ({ kind, ...options });
  class View { addChild() {} on() {} }
  const kit = {
    groupedPage({ build }) {
      const page = { events: new Map(), on(e, fn) { this.events.set(e, fn); }, frame: { navigate: entry => calls.push(['navigate', entry.moduleName]) } };
      const refresh = () => { const sections = []; build({ addChild: s => sections.push(s) }); built.push(sections); };
      refresh();
      return { page, refresh };
    },
    section: s => s, navRow: rowKit('nav'), buttonRow: rowKit('button'), valueRow: rowKit('value'), checkRow: rowKit('check'),
    customRow: view => ({ kind: 'custom', view }), tile: () => Object.assign(new View(), { className: 'os-tile' }),
  };
  const core = { Label: View, StackLayout: View, Image: View, GridLayout: Object.assign(class extends View {}, { setColumn() {}, setRow() {}, setColumnSpan() {} }),
    Dialogs: { confirm: async options => { confirms.push(options); return confirmAnswer; } } };
  const mocks = { '@nativescript/core': core, './ui-kit': kit, './runtime': { getRuntime: () => runtime },
    './detour': { presentDetour: async (name, context) => calls.push(['detour', name, JSON.parse(JSON.stringify(context))]) }, ...extraMocks };
  const load = loader({ global: { isIOS: true } }, mocks);
  return { load, calls, confirms, built, listeners, runtime, answer: value => { confirmAnswer = value; },
    rows: () => built.at(-1).flatMap(s => s.rows), last: () => built.at(-1) };
}
const titled = (rows, title) => rows.find(row => row.title === title);
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Software Update shows the truthful status and routes to the flash detour', async () => {
  const h = uiHarness(STOCK);
  const page = h.load('app/phone-ui/ios/update-page.ts').createPage();
  assert.equal(titled(h.rows(), 'Firmware Channel').value, 'Even Realities');
  assert.equal(titled(h.rows(), 'Left').value, '2.3.0.24');
  assert.equal(titled(h.rows(), 'Firmware').value, 'Stock firmware');
  assert.equal(titled(h.rows(), 'Uninstall Custom Firmware'), undefined, 'stock has nothing to restore');
  assert.match(h.last()[1].footer, /Keep both lenses powered on and nearby/);
  titled(h.rows(), 'Download and Install').onTap(); await settle();
  assert.deepEqual(h.calls.at(-1), ['detour', 'phone-ui/onboarding-flash-page', { mode: 'install', fromOnboarding: false }]);
  titled(h.rows(), 'Firmware Channel').onTap();
  assert.deepEqual(h.calls.at(-1), ['navigate', 'ocusmart/firmware-channel']);

  // Rebuild on firmware changes only, not on every frame ack.
  page.events.get('loaded')(); const builds = h.built.length;
  h.listeners.get('connection')({ ...STOCK, frames: 99 }); assert.equal(h.built.length, builds);
  h.runtime.controller.connectionState = CURRENT; h.listeners.get('connection')(CURRENT);
  assert.equal(h.built.length, builds + 1);
  assert.ok(titled(h.rows(), 'Reinstall'));
  assert.equal(titled(h.rows(), 'Firmware Channel').value, 'Faceclaw');
  h.answer(false); titled(h.rows(), 'Uninstall Custom Firmware').onTap(); await settle();
  assert.match(h.confirms.at(-1).message, /Even's stock firmware 2\.3\.0\.24/);
  assert.equal(h.calls.at(-1)[0], 'navigate', 'cancelled restore flashes nothing');
  h.answer(true); titled(h.rows(), 'Uninstall Custom Firmware').onTap(); await settle();
  assert.deepEqual(h.calls.at(-1), ['detour', 'phone-ui/onboarding-flash-page', { mode: 'uninstall', fromOnboarding: false }]);

  // A flash runs under the detour, which pauses the controller: closing it is the only news.
  const before = h.built.length;
  h.listeners.get('detour')(true); assert.equal(h.built.length, before);
  h.runtime.controller.connectionState = STOCK; h.listeners.get('detour')(false);
  assert.equal(h.built.length, before + 1);
  assert.ok(titled(h.rows(), 'Download and Install'));
  assert.equal(titled(h.rows(), 'Firmware Channel').value, 'Even Realities');

  // Disconnecting after a restore must not keep showing the old Faceclaw report.
  h.runtime.controller.connectionState = CURRENT; h.listeners.get('connection')(CURRENT);
  h.runtime.controller.connectionState = STALE; h.listeners.get('connection')(STALE);
  assert.equal(titled(h.rows(), 'Reinstall'), undefined);
  assert.equal(titled(h.rows(), 'Left').value, 'Not reported');
  assert.equal(titled(h.rows(), 'Firmware Channel').value, undefined);
  assert.ok(titled(h.rows(), 'Uninstall Custom Firmware'));
  page.events.get('unloaded')(); assert.equal(h.listeners.size, 0);
});

test('Software Update is honest about newer, third-party and unvalidated stock firmware', () => {
  const newer = uiHarness(NEWER);
  newer.load('app/phone-ui/ios/update-page.ts').createPage();
  assert.equal(titled(newer.rows(), 'Reinstall'), undefined);
  assert.ok(titled(newer.rows(), `Downgrade to r${REQUIRED}`));
  assert.equal(titled(newer.rows(), 'Firmware').value, `Faceclaw r${REQUIRED + 1}`);

  const other = uiHarness(OTHER);
  other.load('app/phone-ui/ios/update-page.ts').createPage();
  assert.equal(titled(other.rows(), 'Firmware').value, 'Third-party');
  assert.match(other.last().at(-1).footer, /report "Homebrew\/2"/);

  const stock = uiHarness(NEWER_STOCK);
  stock.load('app/phone-ui/ios/update-page.ts').createPage();
  assert.match(stock.last()[1].footer, /stock firmware 2\.3\.3\.0, newer than .* carries extra risk/);

  // The firmware warning's own page: stock firmware never stays connected, so the halted session is what it shows.
  const halted = uiHarness(HALTED);
  halted.load('app/phone-ui/ios/update-page.ts').createPage();
  assert.equal(titled(halted.rows(), 'Left').value, '2.3.3.0');
  assert.equal(titled(halted.rows(), 'Firmware').value, 'Stock firmware');
  assert.match(halted.last()[1].footer, /carries extra risk/);
  assert.doesNotMatch(JSON.stringify(halted.last()), /Connect your glasses/);
});

test('Software Update without a firmware report says so and keeps Uninstall reachable', () => {
  const h = uiHarness(UNREPORTED);
  h.load('app/phone-ui/ios/update-page.ts').createPage();
  assert.deepEqual(['Left', 'Right', 'Firmware'].map(title => titled(h.rows(), title).value), ['Not reported', 'Not reported', 'Not reported'], "General's empty state");
  assert.equal(titled(h.rows(), 'Firmware Channel').value, undefined);
  assert.ok(titled(h.rows(), 'Download and Install') && titled(h.rows(), 'Uninstall Custom Firmware'));
  assert.match(h.last().at(-1).footer, /report their versions after they connect/);
});

test('Firmware Channel checks the reported channel and confirms before switching', async () => {
  const h = uiHarness(CURRENT);
  h.load('app/phone-ui/ios/firmware-channel-page.ts').createPage();
  const rows = h.rows();
  assert.deepEqual(rows.map(r => [r.title, r.checked, r.enabled !== false]),
    [['Faceclaw', true, true], ['xeyes', false, false], ['Even Realities', false, true]]);
  assert.equal(titled(rows, 'xeyes').subtitle, 'Not built yet');
  assert.equal(titled(rows, 'Even Realities').subtitle, 'Installs stock firmware 2.3.0.24');
  titled(rows, 'Faceclaw').onTap(); await settle();
  assert.equal(h.confirms.length, 0, 'the current channel is not re-flashed');
  titled(rows, 'Even Realities').onTap(); await settle();
  assert.equal(h.confirms[0].title, 'Switch to Even Realities?');
  assert.equal(h.confirms[0].message, h.load('app/phone-ui/ios/update-page.ts').RESTORE_MESSAGE, 'what every uninstall route says');
  assert.deepEqual(h.calls.at(-1), ['detour', 'phone-ui/onboarding-flash-page', { mode: 'uninstall', fromOnboarding: false }]);
  assert.match(h.last()[0].footer, /always verified against pinned hashes/);

  const older = uiHarness(OLDER);
  older.load('app/phone-ui/ios/firmware-channel-page.ts').createPage();
  assert.equal(titled(older.rows(), 'Faceclaw').subtitle, 'Faceclaw firmware r30 · base 2.3.0.24', 'the checked row names what is installed');

  const stale = uiHarness(STALE);
  stale.load('app/phone-ui/ios/firmware-channel-page.ts').createPage();
  assert.ok(stale.rows().every(r => !r.checked));

  const none = uiHarness(UNREPORTED);
  none.load('app/phone-ui/ios/firmware-channel-page.ts').createPage();
  assert.ok(none.rows().every(r => !r.checked));
  assert.match(none.last()[0].footer, /^Connect your glasses/);
  titled(none.rows(), 'Faceclaw').onTap(); await settle();
  assert.deepEqual(none.calls.at(-1), ['detour', 'phone-ui/onboarding-flash-page', { mode: 'install', fromOnboarding: false }]);
});

test('Device > Uninstall Custom Firmware confirms with what every uninstall route says', async () => {
  const h = uiHarness(STOCK, {
    '../onboarding-state': { isPreviewOnlyMode: () => false }, '../../g2/reconnect-policy': {},
    '../../g2/device-addresses': { loadDeviceAddresses: () => null, loadPairedGlassesIdentityForAddresses: () => null },
    '../../g2/ios-peripheral-identity': { deviceAddressError: () => 'none' },
    '../../g2/glasses-hardware-identity': { GlassesHardwareIdentity: { decode: () => null } }, '../../g2/glasses-artwork': { glassesImagePath: () => '' },
  });
  const { RESTORE_MESSAGE } = h.load('app/phone-ui/ios/update-page.ts');
  h.load('app/phone-ui/ios/device-page.ts').createPage();
  titled(h.rows(), 'Uninstall Custom Firmware').onTap(); await settle();
  assert.deepEqual([h.confirms[0].title, h.confirms[0].message], ['Uninstall Custom Firmware?', RESTORE_MESSAGE]);
  assert.deepEqual(h.calls.at(-1), ['detour', 'phone-ui/onboarding-flash-page', { mode: 'uninstall', fromOnboarding: false }]);
});

test('firmware alert is a native three-action alert titled by firmware kind', async () => {
  const calls = [], presented = [];
  const UIAlertActionStyle = { Default: 0, Cancel: 1 };
  const UIAlertController = { alertControllerWithTitleMessagePreferredStyle: (title, message, style) =>
    ({ title, message, style, actions: [], preferredAction: null, addAction(a) { this.actions.push(a); } }) };
  const UIAlertAction = { actionWithTitleStyleHandler: (title, style, handler) => ({ title, style, handler }) };
  let state = OLDER;
  // A detour is up over the root, and an alert over it is mid-dismissal. As UIKit does, a
  // controller still holding a presented one (dismissing or not) refuses to present.
  const timers = [];
  const host = (props, onPresent) => ({ beingDismissed: false, presentedViewController: null, ...props,
    presentViewControllerAnimatedCompletion(c) { if (this.presentedViewController) throw new Error('already presenting'); onPresent(c); } });
  const dismissing = host({ beingDismissed: true }, () => { throw new Error('being dismissed'); });
  const detour = host({ presentedViewController: dismissing }, alert => presented.push(alert));
  const root = host({ presentedViewController: detour }, () => { throw new Error('the root is already presenting'); });
  const load = loader({ UIAlertController, UIAlertAction, UIAlertActionStyle, UIAlertControllerStyle: { Alert: 1 }, Promise,
    setTimeout: fn => timers.push(fn) }, {
    // As core does: getRootViewController() walks to the leaf, dismissing or not.
    '@nativescript/core': { Utils: { getWindow: () => ({ rootViewController: root }), ios: { getRootViewController: () => dismissing } } },
    './detour': { presentDetour: async (name, context) => calls.push(['detour', name, JSON.parse(JSON.stringify(context))]) },
    './shell': { pushInTab: (tab, name) => calls.push(['push', tab, name]) },
    './runtime': { getRuntime: () => ({ controller: { get connectionState() { return state; } } }) },
  });
  const { showFirmwareAlert } = load('app/phone-ui/ios/firmware-alert.ts');
  const shown = async (s, pick) => {
    state = s;
    const done = showFirmwareAlert('warning text');
    const alert = presented.at(-1);
    alert.actions.find(a => a.title === pick).handler();
    await done;
    return alert;
  };
  // Shown once the dismissal ends, not dropped on a presenter still holding the dismissing alert.
  const pending = showFirmwareAlert('first');
  timers.shift()(); assert.equal(presented.length, 0, 'waits out the dismissal');
  detour.presentedViewController = null; timers.shift()();
  assert.deepEqual([presented.length, timers.length], [1, 0]);
  presented[0].actions.find(a => a.title === 'Not Now').handler(); await pending;
  const alert = await shown(OLDER, 'Install');
  assert.equal(alert.title, 'Firmware Update Needed'); assert.equal(alert.message, 'warning text');
  assert.deepEqual(alert.actions.map(a => [a.title, a.style]), [['Install', 0], ['What Changes?', 0], ['Not Now', 1]]);
  assert.equal(alert.preferredAction, alert.actions[0]);
  assert.deepEqual(calls.at(-1), ['detour', 'phone-ui/onboarding-flash-page', { mode: 'install', fromOnboarding: false }]);
  assert.equal((await shown(STOCK, 'What Changes?')).title, 'Stock Firmware Detected');
  assert.deepEqual(calls.at(-1), ['push', 'glasses', 'ocusmart/update']);
  const count = calls.length;
  assert.equal((await shown(OTHER, 'Not Now')).title, 'Unrecognized Firmware');
  assert.equal(calls.length, count, 'Not Now does nothing');
});

test('fonts alert explains the download and offers the firmware-check detour', async () => {
  const calls = [], presented = [];
  const UIAlertController = { alertControllerWithTitleMessagePreferredStyle: (title, message, style) =>
    ({ title, message, style, actions: [], preferredAction: null, addAction(a) { this.actions.push(a); } }) };
  const UIAlertAction = { actionWithTitleStyleHandler: (title, style, handler) => ({ title, style, handler }) };
  const root = { presentedViewController: null, presentViewControllerAnimatedCompletion: c => presented.push(c) };
  const { showFontsAlert } = loader({ UIAlertController, UIAlertAction, UIAlertActionStyle: { Default: 0, Cancel: 1 }, UIAlertControllerStyle: { Alert: 1 }, Promise }, {
    '@nativescript/core': { Utils: { getWindow: () => ({ rootViewController: root }) } },
    './detour': { presentDetour: async (...args) => calls.push(['detour', ...args]) },
    './shell': { pushInTab() {} }, './runtime': { getRuntime: () => ({ controller: {} }) },
  })('app/phone-ui/ios/firmware-alert.ts');
  const pick = async title => { const done = showFontsAlert(); presented.at(-1).actions.find(a => a.title === title).handler(); await done; return presented.at(-1); };
  const alert = await pick('Prepare G2 Fonts');
  assert.equal(alert.title, 'G2 Fonts Missing');
  assert.match(alert.message, /fallback fonts.*not reflashed/s);
  assert.deepEqual(alert.actions.map(a => [a.title, a.style]), [['Prepare G2 Fonts', 0], ['Not Now', 1]]);
  assert.equal(alert.preferredAction, alert.actions[0]);
  assert.deepEqual(calls, [['detour', 'phone-ui/onboarding-firmware-check-page']]);
  await pick('Not Now');
  assert.equal(calls.length, 1, 'Not Now does nothing');
});

test('Device, Settings and General read firmware and battery through the same rule as Software Update', () => {
  const live = { ...CURRENT, battery: 80, charging: false };
  const device = uiHarness(live, {
    '../onboarding-state': { isPreviewOnlyMode: () => false }, '../../g2/reconnect-policy': {},
    '../../g2/device-addresses': { loadDeviceAddresses: () => null, loadPairedGlassesIdentityForAddresses: () => null },
    '../../g2/ios-peripheral-identity': { deviceAddressError: () => 'none' },
  }).load('app/phone-ui/ios/device-page.ts');
  assert.equal(device.deviceLine(live), `Connected · 80% · Faceclaw firmware r${REQUIRED} · base 2.3.0.24`);
  assert.equal(device.deviceLine({ ...live, phase: 'disconnected' }), 'Not Connected · Firmware not reported yet', 'no hours-old battery or firmware');
  assert.equal(device.deviceLine({ ...HALTED, battery: 50 }), 'Connection Failed · Stock firmware 2.3.3.0', 'a halted link froze its battery reading');
  assert.equal(device.deviceLine({ ...OTHER, battery: 80 }), 'Connected · 80% · Third-party firmware · base 2.3.0.24', "Software Update's word for the kind");

  const general = uiHarness(OTHER, { './settings-category-page': { documentPage() {} }, '../../version': { FACECLAW_VERSION: 'test' } });
  general.load('app/phone-ui/ios/about-page.ts').createPage();
  assert.equal(titled(general.rows(), 'Firmware').value, 'Third-party', "Software Update's word for it");
  const stale = uiHarness({ ...OTHER, phase: 'disconnected' }, { './settings-category-page': { documentPage() {} }, '../../version': { FACECLAW_VERSION: 'test' } });
  stale.load('app/phone-ui/ios/about-page.ts').createPage();
  assert.deepEqual(['Left', 'Right', 'Firmware'].map(title => titled(stale.rows(), title).value), ['Not reported', 'Not reported', 'Not reported']);
});
