const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const { loader } = require('./helpers/load-typescript.cjs');

// The real dashboard-settings.ts (iOS) over an in-memory store, as in display-layout-setting.test.cjs.
function settingsFixture(store = new Map()) {
  const changed = new Set();
  const context = { exports: {}, global: { isIOS: true }, setTimeout: fn => fn(), require: id => {
    if (id.includes('settings-store')) return {
      onSettingsStoreChanged() {}, getStringSetting: (k, d) => store.get(k) ?? d,
      setStringSetting: (k, v) => store.set(k, v),
      getBooleanSetting: (k, d) => store.get(k) ?? d, setBooleanSetting: (k, v) => store.set(k, v),
    };
    if (id.includes('brightness-curve')) return require('../.test-build/app/g2/brightness-curve.js');
    if (id.includes('animation-speed')) return require('../.test-build/app/ui/animation-speed.js');
    return { Layer: class {}, ASSISTANT_MODEL_CHOICES: [] };
  }};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/ui/dashboard-settings.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return Object.assign(context.exports, { onAnySettingChanged: fn => { changed.add(fn); return () => changed.delete(fn); }, changed });
}

// Settings no iOS code reads, though the glasses Settings app still lists them.
const IOS_INERT = ['phoneRotationSetting', 'watchBatteryVisibilitySetting', 'ringBatteryVisibilitySetting'];

function harness() {
  const settings = settingsFixture();
  // Menu builders that remember their setting, so the glasses tree can be walked.
  const menuItem = setting => ({ label: setting.label, setting });
  const calls = [];
  const mocks = {
    '../dashboard-settings': { ...settings, enumSettingMenuItem: menuItem, toggleSettingMenuItem: menuItem, textSettingMenuItem: menuItem },
    '../../ui/dashboard-settings': settings,
    './settings-panel': { SettingsPanelLayer: class { constructor(sections) { this.sections = sections; } },
      openSettingsSubMenu: (ctx, _title, items) => ctx.opened.push(...items) },
    '../menu': { submenuItem: (label, onSelect) => ({ label, onSelect }), drawRightValueMenuItem() {}, openModalMenu() {} },
    './remote-input-menu': { remoteInputMenuItem: () => ({ label: 'Input tokens' }) },
    '../font-picker': { uiFontPickerMenuItem: () => ({ label: 'Font' }) },
    '@nativescript/core': { knownFolders: { currentApp: () => { throw new Error('no bundle'); } },
      Dialogs: { confirm: async options => { calls.push(['confirm', options.title]); return true; } } },
    '../../graphics/ui-fonts': {}, '../../graphics/logo': {}, '../../graphics/textwrap': {}, '../../version': { FACECLAW_VERSION: 'test' },
    '../../native/llama': { LOCAL_MODEL: { sizeBytes: 1e9, label: 'local' } },
    '../../native/asr-model': { ASR_MODELS: { moonshine: { totalBytes: 1e6, label: 'Moonshine' }, 'whisper-base-en': { totalBytes: 1e6, label: 'Whisper' } } },
    '../../apps/files/text-viewer': { TextViewerLayer: class {} },
    '../../analytics/privacy-disclosure': { IOS_PRIVACY_NOTICE: 'notice' },
    '../shell/shell': { shell: {} }, '../../native/wear-bridge': { wearBridge: {} },
    './widgets': { glanceWidgetSpans: () => false },
    '../../native/notification-sources': { readNotificationSources: () => [], setNotificationSourceEnabled() {} },
  };
  const load = loader({ global: { isIOS: true } }, mocks);
  return { settings, mocks, load, calls };
}

/** Every setting the glasses Settings app reaches on iOS, opening each submenu. */
function glassesSettings(load) {
  const { sections } = load('app/ui/dashboard/settings-menus.ts').createSettingsPanelLayer();
  const found = new Set();
  const walk = items => {
    for (const item of items) {
      if (item.setting) { found.add(item.setting); continue; }
      const ctx = { opened: [], stack: { push() {}, pop() {}, clearToBase() {} }, actions: { disconnect: async () => {}, requestRender() {} } };
      item.onSelect?.(ctx);
      walk(ctx.opened);
    }
  };
  for (const section of sections) walk(section.items);
  return found;
}

function catalogSettings(catalog, skip = new Set()) {
  return new Set(catalog.SETTINGS_CATEGORIES.filter(category => !skip.has(category.id))
    .flatMap(category => category.sections().flatMap(section => section.items.filter(item => item.kind === 'setting').map(item => item.setting))));
}

const labels = set => [...set].map(setting => setting.label).sort();

test('the phone catalog lists exactly the settings the glasses offer on iOS, minus the iOS-inert ones', () => {
  const { settings, load } = harness();
  const catalog = load('app/ui/dashboard/settings-catalog.ts');
  for (const position of ['left', 'right', 'bottom', 'popup']) {
    settings.appSwitcherPositionSetting.set(position);
    const glasses = glassesSettings(load);
    for (const name of IOS_INERT) assert.ok(glasses.has(settings[name]), `${name} is still listed on the glasses (else drop it from IOS_INERT)`);
    // The iOS filter in settings-menus.ts already removed these; the catalog must not bring them back.
    assert.ok(!glasses.has(settings.screenTimeoutSetting) && !glasses.has(settings.watchRemoteEnabledSetting));
    const expected = new Set([...glasses].filter(setting => !IOS_INERT.some(name => settings[name] === setting)));
    // Glanceboard's settings live in its app, not in the glasses Settings app.
    const phone = catalogSettings(catalog, new Set(['glanceboard']));
    assert.deepEqual(labels(phone), labels(expected), position);
    for (const setting of phone) assert.ok(expected.has(setting), `${setting.label} is the glasses' own object (${position})`);
  }
});

test('categories have stable unique ids, including the ones other tabs link to, and all appear on the root page', () => {
  const { load, mocks } = harness();
  Object.assign(mocks, rootMocks(null));
  const ids = [...load('app/ui/dashboard/settings-catalog.ts').SETTINGS_CATEGORIES].map(category => category.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['display', 'notifications']) assert.ok(ids.includes(id), id);
  const root = load('app/phone-ui/ios/settings-page.ts');
  assert.deepEqual([...root.ROOT_GROUPS.flat()].sort(), ids.sort());
});

test('Glanceboard slots keep one widget per board and dim widgets iOS cannot run', () => {
  const { load } = harness();
  const catalog = load('app/ui/dashboard/settings-catalog.ts');
  const slots = catalog.settingsCategory('glanceboard').sections().find(section => section.header === 'Slots').items;
  assert.equal(slots.length, 4);
  assert.match(slots[0].unavailable('music'), /not available on iOS/);
  assert.equal(slots[0].unavailable('calendar'), null);
  // Defaults: system-card, calendar, music, calendar. Calendar into slot 0 clears the others.
  slots[0].setting.set('calendar');
  slots[0].onChange('calendar');
  assert.deepEqual([...slots].map(slot => slot.setting.get()), ['calendar', 'none', 'music', 'none']);
});

function uiKit() {
  const kind = type => options => ({ type, ...options });
  return { navRow: kind('nav'), switchRow: kind('switch'), buttonRow: kind('button'), valueRow: kind('value'), checkRow: kind('check'),
    customRow: view => ({ type: 'custom', view }), tile: (symbol, color) => ({ symbol, color }), section: options => options,
    groupedPage: ({ build }) => {
      const handlers = {}, navigations = [];
      const container = { children: [], addChild(child) { this.children.push(child); }, removeChildren() { this.children = []; } };
      const page = { actionBar: {}, container, navigations, frame: { navigate: entry => navigations.push(entry) },
        on: (event, fn) => { handlers[event] = fn; }, emit: (event, args) => handlers[event]?.(args) };
      const refresh = () => { container.removeChildren(); build(container); };
      refresh();
      return { page, refresh };
    } };
}
const rows = page => page.container.children.flatMap(section => section.rows);

test('category rows: bool → switch, enum → choice page, string → the controller prompt', () => {
  const { load, mocks, settings } = harness();
  const edits = [];
  Object.assign(mocks, { './ui-kit': uiKit(), './runtime': { getRuntime: () => ({ controller: { editSetting: async setting => { edits.push(setting); return true; } } }) },
    '../../native/notification-access': { isNotificationListenerEnabled: () => false, notificationEmptyMessage: () => 'Connect glasses.' },
    '../../remote/service': { remoteTokens: { list: () => [] }, remoteInterfaceSelection: () => 'tailscale' },
    '../../remote/listeners': { isTunnelInterface: () => true }, '../../native/remote-input': { remoteInterfaces: () => [] } });
  const { createPage } = load('app/phone-ui/ios/settings-category-page.ts');
  const page = createPage();
  page.emit('navigatingTo', { context: { category: 'display' } });
  assert.equal(page.actionBar.title, 'Display & Brightness');
  const byTitle = Object.fromEntries(rows(page).map(row => [row.title, row]));
  const lock = byTitle[settings.lockScreenEnabledSetting.label];
  assert.equal(lock.type, 'switch');
  lock.onChange(!lock.value);
  assert.equal(settings.lockScreenEnabledSetting.get(), !lock.value);
  const brightness = byTitle[settings.brightnessSetting.label];
  assert.equal(brightness.type, 'nav'); assert.equal(brightness.value, settings.brightnessSetting.displayValue());
  brightness.onTap();
  assert.equal(page.navigations[0].moduleName, 'ocusmart/settings-choice');
  assert.equal(page.navigations[0].context.item.setting, settings.brightnessSetting);
  byTitle[settings.autoBrightnessCurveSetting.label].onTap();
  assert.deepEqual(edits, [settings.autoBrightnessCurveSetting]);
  // Rebuild only when something shown changed, and stop listening once unloaded.
  page.emit('loaded');
  assert.equal(settings.changed.size, 1);
  const before = page.container.children;
  [...settings.changed][0]();
  assert.equal(page.container.children, before, 'an unrelated store change keeps the rows');
  settings.brightnessSetting.set('50'); [...settings.changed][0]();
  assert.notEqual(page.container.children, before);
  page.emit('unloaded');
  assert.equal(settings.changed.size, 0);
  // Notifications explain an empty list instead of showing nothing.
  const notifications = createPage();
  notifications.emit('navigatingTo', { context: { category: 'notifications' } });
  assert.match(notifications.container.children[0].footer, /Connect glasses\.[\s\S]*post a notification/);
});

test('choice rows honour isDisabled and unavailable values, and run the catalog onChange', () => {
  const { load, mocks, settings } = harness();
  mocks['./ui-kit'] = uiKit();
  const { choiceRows } = load('app/phone-ui/ios/settings-choice-page.ts');
  settings.appSwitcherPositionSetting.set('left');
  const layout = choiceRows({ kind: 'setting', setting: settings.displayLayoutSetting });
  assert.equal(layout.find(row => row.title === settings.displayLayoutSetting.displayValue('fullscreen')).enabled, false);
  assert.equal(layout.filter(row => row.checked).length, 1);
  const changes = [];
  let refreshed = 0;
  const slot = { kind: 'setting', setting: settings.timeFormatSetting, onChange: value => changes.push(value), unavailable: value => value === '12h' ? 'Not here' : null };
  const time = choiceRows(slot, () => refreshed++);
  const twelve = time.find(row => row.title === settings.timeFormatSetting.displayValue('12h'));
  assert.equal(twelve.enabled, false); assert.equal(twelve.subtitle, 'Not here');
  settings.timeFormatSetting.set('12h');
  choiceRows(slot, () => refreshed++).find(row => row.title === settings.timeFormatSetting.displayValue('24h')).onTap();
  assert.equal(settings.timeFormatSetting.get(), '24h');
  assert.deepEqual(changes, ['24h']); assert.equal(refreshed, 1);
});

function rootMocks(state, calls = []) {
  return {
    './ui-kit': uiKit(),
    './runtime': { getRuntime: () => ({ controller: { connectionState: state }, on: () => () => {} }) },
    './detour': { presentDetour: async (...args) => { calls.push(['detour', ...args]); } },
    './shell': { pushInTab: (...args) => calls.push(['push', ...args]) },
    './device-page': { deviceCell: (line, onTap) => ({ type: 'device', line, onTap }), deviceKey: () => '', deviceLine: () => 'line' },
  };
}

test('Settings root: Uninstall only on Faceclaw firmware (confirmed, then the flash detour), update badge on a warning', async () => {
  const build = state => {
    const { load, mocks, calls } = harness();
    Object.assign(mocks, rootMocks(state, calls));
    const page = load('app/phone-ui/ios/settings-page.ts').createPage();
    return { calls, rows: rows(page) };
  };
  const session = extra => ({ phase: 'connected', leftVersion: '2.3.0.24', rightVersion: '2.3.0.24', capabilities: '', firmwareWarning: '', ...extra });
  assert.ok(!build(session()).rows.some(row => row.title === 'Uninstall Custom Firmware'), 'stock firmware');
  assert.ok(!build(null).rows.some(row => row.title === 'Uninstall Custom Firmware'), 'not reported yet');
  const faceclaw = build(session({ capabilities: 'Faceclaw/37' }));
  const uninstall = faceclaw.rows.find(row => row.title === 'Uninstall Custom Firmware');
  assert.equal(uninstall.role, 'destructive');
  uninstall.onTap();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(faceclaw.calls)), [['confirm', 'Uninstall Custom Firmware?'],
    ['detour', 'phone-ui/onboarding-flash-page', { mode: 'uninstall', fromOnboarding: false }]]);
  const update = state => build(state).rows.find(row => row.title === 'Software Update');
  assert.equal(update(session()).badge, undefined);
  assert.equal(update(session({ firmwareWarning: 'Install r37' })).badge, '1');
  update(session()).onTap();
  const general = build(session());
  general.rows.find(row => row.title === 'General').onTap();
  assert.deepEqual(general.calls, [['push', 'settings', 'ocusmart/about']]);
});
