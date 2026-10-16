const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
// Values built inside the vm sandbox carry its prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(setImmediate);

class View {
  constructor() { this.children = []; this.events = new Map(); }
  addChild(child) { this.children.push(child); }
  on(event, fn) { this.events.set(event, fn); }
}
class GridLayout extends View { static setColumn() {} }

function harness({ windows = [], installed = [], apps = [], whiteIcon = () => 'white' } = {}) {
  const calls = [], settingListeners = new Set(), windowListeners = new Set();
  let builds = 0, build, page, confirmAnswer = true;
  const controller = {
    launchApp: id => { calls.push(['launch', id]); return Promise.resolve(); },
    focusWindow: id => calls.push(['focus', id]),
    uninstallApp: id => { calls.push(['uninstall', id]); installed = installed.filter(app => `hub:${app.packageId}` !== id); return Promise.resolve(); },
    onWindowsChanged: fn => { windowListeners.add(fn); return () => windowListeners.delete(fn); },
    pause: () => calls.push(['pause']),
  };
  const row = options => ({ ...options, view: new View() });
  const load = loader({}, {
    '@nativescript/core': { GridLayout, Image: View, Label: View, StackLayout: View,
      Dialogs: { confirm: async options => { calls.push(['confirm', options.title]); return confirmAnswer; } } },
    './ui-kit': {
      groupedPage: options => {
        build = options.build;
        page = new View();
        const refresh = () => { builds++; page.sections = []; build({ addChild: s => page.sections.push(s) }); };
        refresh();
        return { page, refresh };
      },
      section: options => options, navRow: row,
    },
    './runtime': { getRuntime: () => ({ controller }) },
    './shell': { selectTab: name => calls.push(['tab', name]) },
    '../../ui/shell/shell': { shell: { getWindows: () => windows } },
    '../../ui/dashboard-settings': { onAnySettingChanged: fn => { settingListeners.add(fn); return () => settingListeners.delete(fn); } },
    '../../apps/all-apps': { ALL_APPS: apps },
    '../../apps/ios-availability': { iosAppUnavailableReason: id => id === 'music' ? 'Media-player integration is not available on iOS yet.' : null },
    '../../apps/onboarding/onboarding-progress': { ONBOARDING_APP_ID: 'onboarding' },
    '../../apps/evenhub/installed-apps': {
      getInstalledEvenHubApps: () => installed, getInstalledEvenHubFingerprint: () => JSON.stringify(installed),
      installedEvenHubAppId: id => `hub:${id}`, renderInstalledEvenHubIcon: () => null,
    },
    '../../graphics/icons': { renderIcon: (name, size) => ({ name, size }) },
    '../../graphics/image': { GrayImage: class { constructor(w, h) { this.size = w; } } },
    '../../native/gray-image-preview': { grayImageToWhiteIconSource: whiteIcon },
  });
  const api = load('app/phone-ui/ios/apps-page.ts');
  return { api, calls, settingListeners, windowListeners, controller,
    get page() { return page; }, get builds() { return builds; },
    setWindows: next => { windows = next; }, setInstalled: next => { installed = next; },
    set confirm(value) { confirmAnswer = value; } };
}

const builtins = [
  { appId: 'launcher', title: 'Apps', icon: 'layout-grid', showInLauncher: false },
  { appId: 'timer', title: 'Timer', icon: 'timer' },
  { appId: 'onboarding', title: 'Onboarding', icon: 'glasses' },
  { appId: 'music', title: 'Music', icon: 'music' },
  { appId: 'calendar', title: 'Calendar', icon: 'calendar', renderIcon: size => ({ date: true, size }) },
  { appId: 'settings', title: 'Settings', icon: 'settings' },
];
const win = (windowId, appId, title) => ({ windowId, appId, title, drawIcon: (image, x, y, size) => { image.drawn = size; } });

test('Apps tab tile colours are stable per app and spread across the palette', () => {
  const { api } = harness();
  const ids = ['timer', 'calendar', 'terminal', 'ai-chat', 'weather', 'navigate', 'compass', 'notifications', 'files', 'teleprompter'];
  const colors = ids.map(api.tileColor);
  assert.deepEqual(ids.map(api.tileColor), colors, 'same appId, same colour');
  for (const color of colors) assert.ok(['blue', 'red', 'purple', 'green', 'orange', 'gray', 'indigo', 'teal'].includes(color));
  assert.ok(new Set(colors).size >= 4, 'apps do not all share one colour');
  // Pinned: a changed hash would recolour every user's tiles between releases.
  assert.deepEqual([api.tileColor('timer'), api.tileColor('calendar'), api.tileColor('terminal')], ['purple', 'teal', 'red']);
});

test('Apps tab lists real windows, launchable built-ins, installed packages and iOS-unavailable apps', () => {
  const { api } = harness({ apps: builtins,
    windows: [win('launcher', 'launcher', 'Apps'), win('window:timer', 'timer', 'Timer'), win('evenhub:app:3', 'hub:dev.app', 'Dev App')],
    installed: [{ packageId: 'z.app', name: 'Zed', version: '2.0.1' }, { packageId: 'a.app', name: 'Alpha', version: '1.0.0' }] });
  const { open, builtIn, hub, unavailable } = api.listApps();
  assert.deepEqual(plain(open.map(w => w.windowId)), ['window:timer', 'evenhub:app:3'], 'the always-open launcher grid is not listed');
  assert.deepEqual(plain(builtIn.map(app => app.title)), ['Calendar', 'Settings', 'Timer'], 'alphabetical; no launcher, onboarding or unavailable apps');
  assert.deepEqual(plain(hub.map(app => [app.appId, app.title, app.version])), [['hub:a.app', 'Alpha', '1.0.0'], ['hub:z.app', 'Zed', '2.0.1']]);
  assert.deepEqual(plain(unavailable.map(app => [app.title, app.reason])), [['Music', 'Media-player integration is not available on iOS yet.']]);
  assert.deepEqual(plain(builtIn[0].draw(54)), { date: true, size: 54 }, "an app's own renderer wins over its Lucide name");
  assert.deepEqual(plain(builtIn[2].draw(54)), { name: 'timer', size: 54 });
  assert.equal(open[0].draw(54).drawn, 54, 'window icons are what the glasses sidebar draws');
});

test('Apps tab rows open apps, focus windows, and fall back to an initial when a glyph will not render', () => {
  const h = harness({ apps: builtins, windows: [win('window:timer', 'timer', 'Timer')],
    whiteIcon: image => image.name === 'settings' ? null : 'white' });
  h.api.createPage();
  const [onGlasses, builtIn, fromHub, unavailable] = h.page.sections;
  assert.deepEqual([onGlasses.header, builtIn.header, fromHub.header, unavailable.header], ['On Glasses Now', 'Built In', 'From Even Hub', 'Not Available on iPhone']);
  onGlasses.rows[0].onTap(); builtIn.rows[0].onTap();
  assert.deepEqual(h.calls, [['focus', 'window:timer'], ['launch', 'calendar']]);
  const settingsTile = builtIn.rows.find(r => r.title === 'Settings').tile;
  assert.equal(settingsTile.children[0].text, 'S');
  assert.equal(builtIn.rows.find(r => r.title === 'Timer').tile.children[0].imageSource, 'white');
  assert.ok(unavailable.rows[0].view.className.includes('os-disabled'));
  assert.equal(unavailable.rows[0].view.events.size, 0, 'unavailable rows are not tappable');
  fromHub.rows[0].onTap(); assert.deepEqual(h.calls.at(-1), ['tab', 'hub'], 'empty Hub section points at the Hub tab');
  for (const section of h.page.sections) assert.doesNotMatch(section.footer ?? '', /drag|order/i);
});

test('Apps tab uninstalls only after confirmation, through the controller, then rebuilds', async () => {
  const h = harness({ apps: builtins, installed: [{ packageId: 'a.app', name: 'Alpha', version: '1.0.0' }] });
  h.api.createPage();
  const hubRow = () => h.page.sections[2].rows[0];
  assert.equal(hubRow().value, '1.0.0');
  h.confirm = false;
  hubRow().view.events.get('longPress')(); await settle();
  assert.deepEqual(h.calls, [['confirm', 'Uninstall Alpha?']]);
  h.confirm = true;
  const before = h.builds;
  hubRow().view.events.get('longPress')(); await settle();
  assert.deepEqual(h.calls.slice(1), [['confirm', 'Uninstall Alpha?'], ['uninstall', 'hub:a.app']]);
  assert.equal(h.builds, before + 1);
  assert.equal(h.page.sections[2].rows[0].title, 'Browse Even Hub');
});

test('Apps tab rebuilds only when windows or installs change, and subscribes only while loaded', () => {
  const h = harness({ apps: builtins });
  h.api.createPage();
  h.page.events.get('loaded')();
  assert.deepEqual([h.windowListeners.size, h.settingListeners.size], [1, 1]);
  const before = h.builds;
  for (const fn of h.windowListeners) fn();
  for (const fn of h.settingListeners) fn();
  assert.equal(h.builds, before, 'focus changes and unrelated settings do not rebuild');
  h.setWindows([win('window:timer', 'timer', 'Timer')]);
  for (const fn of h.windowListeners) fn();
  assert.equal(h.builds, before + 1);
  h.setInstalled([{ packageId: 'a.app', name: 'Alpha', version: '1.0.0' }]);
  for (const fn of h.settingListeners) fn();
  assert.equal(h.builds, before + 2, 'an install from the glasses store shows up');
  h.page.events.get('unloaded')();
  assert.deepEqual([h.windowListeners.size, h.settingListeners.size], [0, 0]);
  h.page.events.get('loaded')(); h.page.events.get('loaded')(); h.page.events.get('unloaded')();
  assert.deepEqual([h.windowListeners.size, h.settingListeners.size], [0, 0]);
  assert.equal(h.calls.some(c => c[0] === 'pause'), false, 'the runtime owns pause/resume');
});

test('iOS controller fans window changes out to phone pages and focuses only open windows', () => {
  const focused = [], windows = [{ windowId: 'w1', requestRender: () => focused.push('render') }];
  const load = loader({ UIApplication: {}, NSNotificationCenter: {} }, new Proxy({
    '../ui/shell/shell': { shell: { getWindows: () => windows, focusWindow: id => focused.push(id) } },
  }, { get: (mocks, name) => mocks[name] ?? {}, has: () => true }));
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts');
  const host = Object.create(IosPreviewController.prototype);
  let renders = 0, syncs = 0, heard = 0;
  host.windowListeners = new Set(); host.requestShellRender = () => renders++; host.syncEvenHubPhoneUi = () => syncs++;
  const off = host.onWindowsChanged(() => heard++);
  host.windowsChanged(); off(); host.windowsChanged();
  assert.deepEqual([renders, syncs, heard], [2, 2, 1]);
  host.focusWindow('gone'); host.focusWindow('w1');
  assert.deepEqual(focused, ['w1', 'render']);
  assert.equal(renders, 3);
});
