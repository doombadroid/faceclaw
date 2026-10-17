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
    if (id.includes('branding')) return { APP_NAME: 'OcuSmart' };
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
  const calls = [], messages = [], unavailable = new Set(['microphones']);
  const mocks = {
    '../../apps/ios-availability': { iosAppUnavailableReason: id => unavailable.has(id) ? 'not yet' : null },
    '../dashboard-settings': { ...settings, enumSettingMenuItem: menuItem, toggleSettingMenuItem: menuItem, textSettingMenuItem: menuItem },
    '../../ui/dashboard-settings': { ...settings, enumSettingMenuItem: menuItem, toggleSettingMenuItem: menuItem },
    './settings-panel': { SettingsPanelLayer: class { constructor(sections) { this.sections = sections; } },
      openSettingsSubMenu: (ctx, _title, items) => ctx.opened.push(...items) },
    '../menu': { submenuItem: (label, onSelect) => ({ label, onSelect }), drawRightValueMenuItem() {}, openModalMenu() {} },
    './remote-input-menu': { remoteInputMenuItem: () => ({ label: 'Input tokens' }) },
    '../font-picker': { uiFontPickerMenuItem: () => ({ label: 'Font' }) },
    '@nativescript/core': { knownFolders: { currentApp: () => { throw new Error('no bundle'); } },
      Dialogs: { confirm: async options => { calls.push(['confirm', options.title]); messages.push(options.message); return true; } } },
    '../../graphics/ui-fonts': {}, '../../graphics/logo': {}, '../../graphics/textwrap': {}, '../../version': { FACECLAW_VERSION: 'test' },
    '../../native/llama': { LOCAL_MODEL: { sizeBytes: 1e9, label: 'local' } },
    '../../native/asr-model': { ASR_MODELS: { moonshine: { totalBytes: 1e6, label: 'Moonshine' }, 'whisper-base-en': { totalBytes: 1e6, label: 'Whisper' } } },
    '../../apps/files/text-viewer': { TextViewerLayer: class {} },
    '../../analytics/privacy-disclosure': { IOS_PRIVACY_NOTICE: 'notice' },
    '../shell/shell': { shell: {} }, '../../native/wear-bridge': { wearBridge: {} },
    './widgets': { glanceWidgetSpans: () => false, findGlanceWidget: () => null },
    // glanceboard-app.ts: menus that keep their items, so its Settings page can be walked.
    '../../graphics/image': {}, '../../ui/metrics': {}, '../../ui/shell/in-process-window': { createInProcessWindow: options => options },
    '../../ui/font-picker': { uiFontOverridePickerMenuItem: () => ({ label: 'Glanceboard font' }) },
    '../../ui/menu': { MenuLayer: class { constructor(title, items) { this.items = items; } }, submenuItem: (label, onSelect) => ({ label, onSelect }), isMenuItemDisabled() {} },
    '../../ui/menu-core': { Menu: class { constructor({ items }) { this.items = items; } } },
    '../../ui/shell/shell': { shell: {} }, './board': { GlanceBoard: class {} }, './glance-font': { glanceFont: {} },
    '../../native/notification-sources': { readNotificationSources: () => [], setNotificationSourceEnabled() {} },
  };
  const load = loader({ global: { isIOS: true } }, mocks);
  return { settings, mocks, load, calls, messages, unavailable };
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
  const { settings, load, unavailable } = harness();
  const catalog = load('app/ui/dashboard/settings-catalog.ts');
  for (const [position, micsPorted] of [['left', false], ['right', false], ['bottom', true], ['popup', false]]) {
    settings.appSwitcherPositionSetting.set(position);
    if (micsPorted) unavailable.delete('microphones'); else unavailable.add('microphones');
    const glasses = glassesSettings(load);
    for (const name of IOS_INERT) assert.ok(glasses.has(settings[name]), `${name} is still listed on the glasses (else drop it from IOS_INERT)`);
    // The iOS filter in settings-menus.ts already removed these; the catalog must not bring them back.
    for (const name of ['watchRemoteEnabledSetting', 'suspendEvenHubWhenScreenOffSetting'])
      assert.ok(!glasses.has(settings[name]), name);
    // Mic control only drives the Microphones app, so it shows once that is ported.
    assert.equal(glasses.has(settings.useMicControlSetting), micsPorted, position);
    for (const name of ['screenTimeoutSetting', 'ringConnectionModeSetting', 'firmwareDebugFlagsSetting', 'saveVoiceRecordingsSetting'])
      assert.ok(glasses.has(settings[name]), name);
    assert.match(settings.saveVoiceRecordingsSetting.description, /Files app/);
    const expected = new Set([...glasses].filter(setting => !IOS_INERT.some(name => settings[name] === setting)));
    // Glanceboard's settings live in its app, not in the glasses Settings app.
    const phone = catalogSettings(catalog, new Set(['glanceboard']));
    assert.deepEqual(labels(phone), labels(expected), position);
    for (const setting of phone) assert.ok(expected.has(setting), `${setting.label} is the glasses' own object (${position})`);
  }
});

/** The Glanceboard app's entry toggle and every setting on its Settings page (font and per-widget submenus stay on the glasses). */
function glanceboardAppSettings(load) {
  const home = load('app/apps/glanceboard/glanceboard-app.ts').createGlanceboardAppWindow({ actions: {} }).baseLayer.menu.items;
  const pushed = [];
  home.find(item => item.label === 'Settings').onSelect({ stack: { push: layer => pushed.push(layer), getBaseSize: () => ({ width: 576 }) } });
  assert.equal(pushed.length, 1);
  return new Set([...home, ...pushed[0].items].filter(item => item.setting).map(item => item.setting));
}

test('the Glanceboard category lists exactly the Glanceboard app\'s settings, plus its slots', () => {
  const { load } = harness();
  const catalog = load('app/ui/dashboard/settings-catalog.ts');
  const glance = load('app/apps/glanceboard/glanceboard-settings.ts');
  for (const layout of glance.glanceLayoutSetting.values) {
    glance.glanceLayoutSetting.set(layout);
    const glasses = glanceboardAppSettings(load);
    assert.ok(glasses.size >= 7, 'the walk reached the Settings page');
    const sections = catalog.settingsCategory('glanceboard').sections();
    // Slot settings are built per call, so they match by id: the board's slots, in order.
    const slots = sections.find(section => section.header === 'Slots').items.map(item => item.setting.id);
    assert.deepEqual(slots, glance.glanceSlotSettings(glance.glanceLayout()).map(setting => setting.id), layout);
    const phone = new Set([...catalogSettings({ SETTINGS_CATEGORIES: [catalog.settingsCategory('glanceboard')] })].filter(setting => !slots.includes(setting.id)));
    assert.deepEqual(labels(phone), labels(glasses), layout);
    for (const setting of glasses) assert.ok(phone.has(setting), `${setting.label} is the app's own object (${layout})`);
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

test('Glanceboard slots keep one widget per board, offer Music on iOS and ask for Apple Music access when it is chosen', () => {
  const { load, mocks } = harness();
  let prompts = 0;
  mocks['../../native/media-controller'] = { mediaControllerBridge: { openNotificationAccessSettings: () => prompts++ } };
  const catalog = load('app/ui/dashboard/settings-catalog.ts');
  const slots = catalog.settingsCategory('glanceboard').sections().find(section => section.header === 'Slots').items;
  assert.equal(slots.length, 4);
  assert.equal(catalog.itemTitle(slots[0]), 'Top Left');
  assert.equal(slots[0].unavailable, undefined);
  // Defaults: system-card, calendar, music, calendar. Calendar into slot 0 clears the others.
  slots[0].setting.set('calendar');
  slots[0].onChange('calendar');
  assert.deepEqual([...slots].map(slot => slot.setting.get()), ['calendar', 'none', 'music', 'none']);
  assert.equal(prompts, 0);
  slots[1].setting.set('music');
  slots[1].onChange('music');
  assert.deepEqual([...slots].map(slot => slot.setting.get()), ['calendar', 'music', 'none', 'none']);
  assert.equal(prompts, 1);
});

test('iOS keeps connecting to the ring directly unless the user picks glasses-only', () => {
  const { settings } = harness();
  assert.equal(settings.ringConnectionModeSetting.get(), 'direct');
  settings.ringConnectionModeSetting.set('glasses');
  assert.equal(settings.ringConnectionModeSetting.get(), 'glasses');
});

test('a phone Screen Timeout change restarts the idle timer, as on the glasses', () => {
  const { settings, mocks, load } = harness();
  let noted = 0;
  mocks['../shell/shell'].shell.noteUserActivity = () => noted++;
  const row = load('app/ui/dashboard/settings-catalog.ts').settingsCategory('display').sections()
    .flatMap(section => section.items).find(item => item.setting === settings.screenTimeoutSetting);
  row.onChange('30s');
  assert.equal(noted, 1);
});

test('every catalog row title is Title Case on the phone', () => {
  const { load, mocks } = harness();
  Object.assign(mocks, rootMocks(null));
  const catalog = load('app/ui/dashboard/settings-catalog.ts');
  for (const category of catalog.SETTINGS_CATEGORIES) for (const section of category.sections()) for (const item of section.items) {
    if (item.kind !== 'setting') continue;
    const title = catalog.itemTitle(item);
    assert.ok(title.split(' ').every(word => !/^[a-z]/.test(word) || ['on', 'to', 'of', 'and'].includes(word)), `${category.id}: ${title}`);
  }
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
  const edits = [], ancs = new Set();
  let ancsReady = false;
  mocks['@nativescript/core'].Label = class {};
  Object.assign(mocks, { './ui-kit': uiKit(), './runtime': { getRuntime: () => ({ controller: { editSetting: async setting => { edits.push(setting); return true; } } }) },
    '../../native/notification-access': { isNotificationListenerEnabled: () => ancsReady, notificationEmptyMessage: () => 'Connect glasses.' },
    '../../native/notification-icons': { onAndroidNotificationsChanged: fn => { ancs.add(fn); return () => ancs.delete(fn); } },
    '../../remote/service': { remoteTokens: { list: () => [] }, remoteInterfaceSelection: () => 'tailscale' },
    '../../remote/listeners': { isTunnelInterface: () => true }, '../../native/remote-input': { remoteInterfaces: () => [] } });
  const { createPage } = load('app/phone-ui/ios/settings-category-page.ts');
  const page = createPage();
  page.emit('navigatingTo', { context: { category: 'display' } });
  assert.equal(page.actionBar.title, 'Display & Brightness');
  const byTitle = Object.fromEntries(rows(page).map(row => [row.title, row]));
  const { phoneTitle } = load('app/ui/dashboard/settings-catalog.ts');
  // Title Case on the phone; the glasses keep the shared sentence-case labels.
  assert.equal(phoneTitle(settings.lockScreenEnabledSetting), 'Lock Screen');
  assert.equal(phoneTitle(settings.mirrorTouchSetting), 'Touch Mirror', 'the title My Glasses shows');
  const lock = byTitle[phoneTitle(settings.lockScreenEnabledSetting)];
  assert.equal(lock.type, 'switch');
  lock.onChange(!lock.value);
  assert.equal(settings.lockScreenEnabledSetting.get(), !lock.value);
  const brightness = byTitle[phoneTitle(settings.brightnessSetting)];
  assert.equal(brightness.type, 'nav'); assert.equal(brightness.value, settings.brightnessSetting.displayValue());
  brightness.onTap();
  assert.equal(page.navigations[0].moduleName, 'ocusmart/settings-choice');
  assert.equal(page.navigations[0].context.item.setting, settings.brightnessSetting);
  byTitle[phoneTitle(settings.autoBrightnessCurveSetting)].onTap();
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
  // ANCS readiness is session state, not a setting: its change alone must update the footer.
  notifications.emit('loaded');
  ancsReady = true; for (const fn of ancs) fn();
  assert.doesNotMatch(notifications.container.children[0].footer, /Connect glasses/);
  notifications.emit('unloaded');
  assert.equal(ancs.size, 0);
  // Documents open as an OcuSmart page (dark-aware), not the shared XML page.
  const privacy = createPage();
  privacy.emit('navigatingTo', { context: { category: 'privacy' } });
  rows(privacy).find(row => row.title === 'Privacy Policy').onTap();
  assert.equal(privacy.navigations[0].moduleName, undefined);
  assert.match(privacy.navigations[0].create().container.children[0].text, /PRIVACY is missing/);
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
    const { load, mocks, calls, messages } = harness();
    Object.assign(mocks, rootMocks(state, calls));
    const page = load('app/phone-ui/ios/settings-page.ts').createPage();
    return { calls, messages, rows: rows(page) };
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
  assert.match(faceclaw.messages[0], /OcuSmart needs Faceclaw firmware to work with your glasses/, 'the consequence Software Update states too');
  assert.ok(!build(session({ capabilities: 'Faceclaw/37', phase: 'disconnected' })).rows.some(row => row.title === 'Uninstall Custom Firmware'),
    'a disconnected session no longer reports what is installed');
  const update = state => build(state).rows.find(row => row.title === 'Software Update');
  assert.equal(update(session()).badge, undefined);
  assert.equal(update(session({ firmwareWarning: 'Install r37' })).badge, '1');
  update(session()).onTap();
  const general = build(session());
  general.rows.find(row => row.title === 'General').onTap();
  assert.deepEqual(general.calls, [['push', 'settings', 'ocusmart/about']]);
});

test('iOS offers the agent bridge backend and its connection rows on the glasses and the phone', () => {
  const { settings, load } = harness();
  assert.deepEqual([...settings.assistantBackendSetting.values], ['direct', 'external']);
  assert.match(settings.assistantBackendSetting.description, /bridge/);
  assert.match(settings.assistantBridgeHostSetting.description, /wss:\/\//);
  const glasses = glassesSettings(load), phone = catalogSettings(load('app/ui/dashboard/settings-catalog.ts'));
  for (const name of ['assistantBridgeHostSetting', 'assistantBridgePortSetting', 'assistantBridgeTokenSetting', 'assistantAllowProactiveSetting']) {
    assert.ok(glasses.has(settings[name]) && phone.has(settings[name]), name);
  }
});
