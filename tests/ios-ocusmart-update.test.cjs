const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');

const REQUIRED = 37;
const session = (capabilities, left = '2.3.0.24', right = '2.3.0.24') => ({ phase: 'connected', status: '', battery: null, charging: null,
  ring: false, frames: 0, capabilities, leftVersion: left, rightVersion: right, firmwareWarning: '' });
const STOCK = session(''), CURRENT = session(`Faceclaw/${REQUIRED}`), OLDER = session('Faceclaw/30'),
  LEGACY = session('EVENCFW/1 caps'), OTHER = session('Homebrew/2'), UNREPORTED = session('', '', '');

test('firmware-info classifies reported firmware for the update, channel and alert screens', () => {
  const info = loader()('app/phone-ui/ios/firmware-info.ts');
  const compat = loader()('app/g2/firmware-compat.ts');
  assert.equal(compat.REQUIRED_FACECLAW_FIRMWARE_VERSION, REQUIRED, 'fixtures track the required revision');
  const ext = state => info.firmwareSummary(state).extension;
  assert.deepEqual([UNREPORTED, null, STOCK, CURRENT, OLDER, LEGACY, OTHER].map(s => info.updateStatus(ext(s))),
    ['unknown', 'unknown', 'available', 'current', 'available', 'available', 'available']);
  assert.equal(info.updateStatus({ kind: 'faceclaw', version: REQUIRED + 1 }), 'current', 'newer revisions only add to the contract');
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

function uiHarness(state) {
  const calls = [], confirms = [], built = [];
  let confirmAnswer = true;
  const listeners = new Map();
  const runtime = { controller: { connectionState: state }, on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); } };
  const rowKit = kind => options => ({ kind, ...options });
  class View { addChild() {} }
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
  const core = { Label: View, StackLayout: View, GridLayout: Object.assign(class extends View {}, { setColumn() {} }),
    Dialogs: { confirm: async options => { confirms.push(options); return confirmAnswer; } } };
  const mocks = { '@nativescript/core': core, './ui-kit': kit, './runtime': { getRuntime: () => runtime },
    './detour': { presentDetour: async (name, context) => calls.push(['detour', name, JSON.parse(JSON.stringify(context))]) } };
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
  assert.equal(titled(h.rows(), 'Restore Even Firmware'), undefined, 'stock has nothing to restore');
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
  h.answer(false); titled(h.rows(), 'Restore Even Firmware').onTap(); await settle();
  assert.match(h.confirms.at(-1).message, /Even's stock firmware 2\.3\.0\.24/);
  assert.equal(h.calls.at(-1)[0], 'navigate', 'cancelled restore flashes nothing');
  h.answer(true); titled(h.rows(), 'Restore Even Firmware').onTap(); await settle();
  assert.deepEqual(h.calls.at(-1), ['detour', 'phone-ui/onboarding-flash-page', { mode: 'uninstall', fromOnboarding: false }]);
  page.events.get('unloaded')(); assert.equal(h.listeners.size, 0);
});

test('Software Update without a firmware report asks to connect and keeps Restore reachable', () => {
  const h = uiHarness(UNREPORTED);
  h.load('app/phone-ui/ios/update-page.ts').createPage();
  assert.equal(titled(h.rows(), 'Left'), undefined);
  assert.equal(titled(h.rows(), 'Firmware Channel').value, undefined);
  assert.ok(titled(h.rows(), 'Download and Install') && titled(h.rows(), 'Restore Even Firmware'));
  assert.match(h.last().at(-1).footer, /Connect your glasses/);
});

test('Firmware Channel checks the reported channel and confirms before switching', async () => {
  const h = uiHarness(CURRENT);
  h.load('app/phone-ui/ios/firmware-channel-page.ts').createPage();
  const rows = h.rows();
  assert.deepEqual(rows.map(r => [r.title, r.checked, r.enabled !== false]),
    [['Faceclaw', true, true], ['Even Realities', false, true], ['xeyes', false, false]]);
  assert.equal(titled(rows, 'xeyes').subtitle, 'Not built yet');
  titled(rows, 'Faceclaw').onTap(); await settle();
  assert.equal(h.confirms.length, 0, 'the current channel is not re-flashed');
  titled(rows, 'Even Realities').onTap(); await settle();
  assert.equal(h.confirms[0].title, 'Switch to Even Realities?');
  assert.deepEqual(h.calls.at(-1), ['detour', 'phone-ui/onboarding-flash-page', { mode: 'uninstall', fromOnboarding: false }]);
  assert.match(h.last()[0].footer, /always verified against pinned hashes/);

  const none = uiHarness(UNREPORTED);
  none.load('app/phone-ui/ios/firmware-channel-page.ts').createPage();
  assert.ok(none.rows().every(r => !r.checked));
  assert.match(none.last()[0].footer, /^Connect your glasses/);
  titled(none.rows(), 'Faceclaw').onTap(); await settle();
  assert.deepEqual(none.calls.at(-1), ['detour', 'phone-ui/onboarding-flash-page', { mode: 'install', fromOnboarding: false }]);
});

test('firmware alert is a native three-action alert titled by firmware kind', async () => {
  const calls = [], presented = [];
  const UIAlertActionStyle = { Default: 0, Cancel: 1 };
  const UIAlertController = { alertControllerWithTitleMessagePreferredStyle: (title, message, style) =>
    ({ title, message, style, actions: [], preferredAction: null, addAction(a) { this.actions.push(a); } }) };
  const UIAlertAction = { actionWithTitleStyleHandler: (title, style, handler) => ({ title, style, handler }) };
  let state = OLDER;
  const load = loader({ UIAlertController, UIAlertAction, UIAlertActionStyle, UIAlertControllerStyle: { Alert: 1 }, Promise }, {
    '@nativescript/core': { Utils: { ios: { getRootViewController: () => ({ presentViewControllerAnimatedCompletion: alert => presented.push(alert) }) } } },
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
