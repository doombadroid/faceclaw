// The OcuSmart Hub tab: its store button mapping, list paging, phone permission
// prompt and install/open action, plus the shared install pipeline's glasses
// path after the permission prompt became an injected callback.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const storeApp = (packageId, version = '1.0.0') => ({ packageId, name: packageId, version, iconPath: '', tagline: '', creatorName: '', categories: [], fileSize: 0 });
const page = (ids, { total = 0, page = 1, pageSize = 40 } = {}) => ({ apps: ids.map((id) => storeApp(id)), total, page, pageSize });

// ---- store-install: glasses path ----------------------------------------

// `events` is one timeline: dialog pushes, status changes, renders, installs.
const loadStoreInstall = ({ permissions = [{ name: 'network' }], installedManifest = null, events = [], extra = {} } = {}) => {
  const calls = [];
  const load = loader({}, {
    '../../ui/layers': {},
    './even-api': { evenHubApi: {
      downloadApp: async (id) => { calls.push(['download', id]); return { bytes: new Uint8Array([1]), privacyPolicyUrl: 'https://example.com/p' }; },
      downloadPublicAsset: async () => ({ bytes: new Uint8Array([2]), extension: 'png' }),
      getStoreAppDetail: async () => null,
    } },
    './installed-apps': {
      readEvenHubPackageManifestBytes: () => ({ name: 'Demo', permissions, privacyPolicyUrl: '' }),
      readEvenHubPackageManifest: () => installedManifest,
      installedEvenHubPackagePath: (id) => `/pkg/${id}`,
      installEvenHubPackageBytes: (_bytes, options) => { calls.push(['install', options.expectedPackageId]); events.push(['install']); return { packageId: options.expectedPackageId, version: '2.0.0' }; },
      getInstalledEvenHubApp: () => null,
      installedEvenHubAppId: (id) => `evenhub-installed:${id}`,
    },
    './manager': { closeRunningPackage: (id) => { calls.push(['close', id]); events.push(['close']); } },
    './permission-dialog': { EvenHubPermissionDialogLayer: class {
      constructor(name, perms, url, onConfirm, onCancel) { Object.assign(this, { name, perms, url, onConfirm, onCancel }); }
    } },
    ...extra,
  });
  return { ...load('app/apps/evenhub/store-install.ts'), load, calls, events };
};

const glassesCtx = (events = [], status = () => undefined) =>
  ({ events, stack: { push: (layer) => events.push(['push', layer]) }, actions: { requestRender: () => events.push(['render', status()]) } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('confirmOnGlasses stacks the dialog, then clears the status, then repaints', async () => {
  const { confirmOnGlasses } = loadStoreInstall();
  const ctx = glassesCtx();
  void confirmOnGlasses(ctx, (status) => ctx.events.push(['status', status]))({ appName: 'Demo', permissions: [], privacyPolicyUrl: '' });
  assert.deepEqual(ctx.events.map(([kind, value]) => (kind === 'push' ? kind : [kind, value])), ['push', ['status', ''], ['render', undefined]]);
});

test('the glasses app page installs through the real pipeline: dialog first, status cleared after it, Installing painted', async () => {
  const events = [];
  const { load, calls } = loadStoreInstall({ events, extra: {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => ({}) },
    '../../graphics/image': { GrayImage: class {} },
    '../../graphics/textwrap': {},
    '../../ui/gestures': {},
    '../../ui/menu-core': { Menu: class {} },
    '../files/text-viewer': { TextViewerLayer: class {} },
    './updates': { describeUpdate: () => ({}) },
    '../../ui/metrics': {},
  } });
  const { EvenHubStoreDetailLayer } = load('app/apps/evenhub/store-detail-layer.ts');
  const layer = new EvenHubStoreDetailLayer(storeApp('demo'), { appendLog() {}, launchApp: async (id) => events.push(['launch', id]) });
  const ctx = glassesCtx(events, () => layer.status);
  const done = layer.install(ctx);
  await tick();
  const pushed = events.findIndex(([kind]) => kind === 'push');
  assert.ok(pushed >= 0, 'the glasses dialog is stacked');
  const dialog = events[pushed][1];
  assert.deepEqual([dialog.name, dialog.perms, dialog.url], ['Demo', [{ name: 'network' }], 'https://example.com/p']);
  assert.deepEqual(events.slice(0, pushed).at(-1), ['render', 'Downloading demo...'], 'the status is not cleared before the dialog is stacked');
  assert.deepEqual(events[pushed + 1], ['render', ''], 'the stacked dialog is painted with the status cleared');
  assert.deepEqual(calls, [['download', 'demo']], 'nothing installs before Allow');
  dialog.onConfirm();
  await done;
  const installing = events.findIndex(([kind, status]) => kind === 'render' && status === 'Installing...');
  assert.ok(installing > pushed && installing < events.findIndex(([kind]) => kind === 'close'), 'Installing... is painted before the package is replaced');
  assert.deepEqual(calls.slice(1), [['close', 'demo'], ['install', 'demo']], 'running copies close before the package is replaced');
  assert.ok(events.some(([kind, id]) => kind === 'launch' && id === 'evenhub-installed:demo'));
});

test('declining the glasses dialog installs nothing', async () => {
  const { installStoreApp, confirmOnGlasses, calls } = loadStoreInstall();
  const ctx = glassesCtx();
  const pending = installStoreApp(storeApp('demo'), { appendLog() {}, onStatus() {}, confirmPermissions: confirmOnGlasses(ctx, () => {}) });
  await tick();
  ctx.events.find(([kind]) => kind === 'push')[1].onCancel();
  assert.equal(await pending, null);
  assert.deepEqual(calls, [['download', 'demo']]);
});

test('an update that declares no permissions skips the prompt', async () => {
  const { installStoreApp, calls } = loadStoreInstall({ permissions: [], installedManifest: { permissions: [] } });
  let asked = 0;
  const result = await installStoreApp(storeApp('demo'), { appendLog() {}, onStatus() {}, confirmPermissions: async () => { asked++; return true; } });
  assert.equal(asked, 0);
  assert.equal(result.packageId, 'demo');
  assert.deepEqual(calls.map(([kind]) => kind), ['download', 'close', 'install']);
});

// ---- hub-page: phone logic ----------------------------------------------

// Just enough of NativeScript and the UI kit to build the pages and fire their events.
class FakeView {
  constructor() { this.children = []; this.handlers = {}; this.className = ''; }
  on(event, fn) { (this.handlers[event] ??= []).push(fn); }
  emit(event, arg) { for (const fn of [...(this.handlers[event] ?? [])]) fn(arg); }
  addChild(child) { this.children.push(child); }
  removeChildren() { this.children = []; }
  dismissSoftInput() {}
}
class FakeGrid extends FakeView { static setColumn() {} }
const descendants = (view) => [view, ...(view?.children ?? []).flatMap(descendants)];
const findClass = (view, className) => descendants(view).filter((child) => child.className?.split(' ').includes(className));
const shownText = (view) => descendants(view).flatMap((child) => [child.text, child.button?.title, child.section?.footer]).filter(Boolean);

const loadHub = ({ installed = {}, present = () => true, confirm = [], install, api = {}, alert, signedIn = true, fingerprint = () => '', updates } = {}) => {
  const calls = [];
  const kit = { builds: 0 };
  const installedApps = {
    getInstalledEvenHubApp: (id) => installed[id] ?? null,
    getInstalledEvenHubApps: () => Object.values(installed),
    getInstalledEvenHubFingerprint: () => fingerprint(),
    installedEvenHubAppId: (id) => `evenhub-installed:${id}`,
    installedEvenHubPackagePath: (id) => `/pkg/${id}`,
    readEvenHubPackageManifest: () => null,
  };
  class AuthError extends Error {}
  const evenApi = { evenHubApi: api, EvenHubAuthenticationError: AuthError };
  const answers = [...confirm];
  const load = loader({}, {
    '@nativescript/core': {
      Button: FakeView, GridLayout: FakeGrid, Image: FakeView, ImageSource: class {}, Label: FakeView, StackLayout: FakeView,
      SearchBar: FakeView, SegmentedBar: FakeView, SegmentedBarItem: FakeView,
      Dialogs: {
        confirm: async (options) => { calls.push(['confirm', options]); return answers.shift(); },
        alert: (options) => { calls.push(['alert', options.title, options.message]); return alert ? alert() : Promise.resolve(); },
      },
    },
    './ui-kit': {
      groupedPage: ({ build }) => {
        const page = new FakeView(), container = new FakeView();
        page.actionBar = {}; page.content = { content: container };
        const refresh = () => { kit.builds++; container.removeChildren(); build(container); };
        refresh();
        return { page, refresh };
      },
      section: (section) => Object.assign(new FakeView(), { section, children: section.rows.map((row) => row.view) }),
      buttonRow: (button) => ({ view: Object.assign(new FakeView(), { button }) }),
      valueRow: (value) => ({ view: Object.assign(new FakeView(), { value }) }),
      navRow: (nav) => ({ view: Object.assign(new FakeView(), { nav }) }),
      customRow: (view) => ({ view }),
    },
    './runtime': { getRuntime: () => ({ controller: { launchApp: async (id) => calls.push(['launch', id]) } }) },
    './shell': { pushInTab() {} },
    '../../branding': { APP_NAME: 'OcuSmart' },
    '../../apps/evenhub/even-api': evenApi,
    './even-api': evenApi,
    '../../apps/evenhub/credentials': { hasEvenHubCredentials: () => signedIn, evenHubEmailSetting: { get: () => '' }, clearEvenHubSession() {} },
    '../../apps/evenhub/installed-apps': installedApps,
    './installed-apps': installedApps,
    '../../native/file-access': { statPath: (path) => (present(path) ? { isDirectory: false, sizeBytes: 10 } : null) },
    '../../apps/evenhub/store-install': {
      cleanError: (error) => String(error?.message ?? error),
      installStoreApp: install ?? (async (app, options) => { calls.push(['install', app.packageId, options.confirmPermissions]); return { packageId: app.packageId }; }),
    },
    '../../apps/evenhub/privacy-policy': { openPrivacyPolicyOnPhone: (url) => calls.push(['policy', url]) },
    '../../native/settings-store': { onSettingsStoreChanged: () => () => {} },
    // Real updates.ts unless a test replaces it, so the button mapping is production code.
    ...(updates ? { '../../apps/evenhub/updates': updates } : {}),
  });
  return { hub: load('app/phone-ui/ios/hub-page.ts'), load, calls, kit, AuthError };
};

test('the store button follows the installed copy', () => {
  const installed = { same: { packageId: 'same', version: '1.0.0' }, old: { packageId: 'old', version: '0.9.0' }, gone: { packageId: 'gone', version: '0.9.0' } };
  const { hub } = loadHub({ installed, present: (path) => path !== '/pkg/gone' });
  assert.equal(hub.hubAction(storeApp('fresh')), 'GET');
  assert.equal(hub.hubAction(storeApp('same')), 'OPEN');
  assert.equal(hub.hubAction(storeApp('old', '1.0.0')), 'UPDATE');
  assert.equal(hub.hubAction(storeApp('gone')), 'REINSTALL', 'a missing package outranks an update');
});

test('paging dedupes and stops when an endpoint ignores paging', () => {
  const { hub } = loadHub();
  let listing = hub.mergePage(hub.emptyListing(), page(['a', 'b'], { total: 3 }));
  assert.deepEqual([listing.apps.length, listing.nextPage, listing.exhausted], [2, 2, false]);
  listing = hub.mergePage(listing, page(['b', 'c'], { total: 3, page: 2 }));
  assert.deepEqual([...listing.apps.map((app) => app.packageId)], ['a', 'b', 'c']);
  assert.equal(listing.exhausted, true, 'the total is reached');
  const repeated = hub.mergePage(hub.mergePage(hub.emptyListing(), page(['a'], { pageSize: 1 })), page(['a'], { pageSize: 1, page: 2 }));
  assert.equal(repeated.exhausted, true, 'a page with nothing new ends the list');
  assert.equal(hub.mergePage(hub.emptyListing(), page(['a'], { pageSize: 40 })).exhausted, true, 'a short page with no total ends the list');
});

test('the phone prompt lists every permission and can show the policy before answering', async () => {
  const { hub, calls } = loadHub({ confirm: [undefined, true] });
  const accepted = await hub.confirmOnPhone({ appName: 'Demo', permissions: [{ name: 'network', whitelist: ['api.example.com'] }, { name: 'g2-microphone' }],
    privacyPolicyUrl: 'https://example.com/p' });
  assert.equal(accepted, true);
  const [first] = calls;
  assert.match(first[1].message, /Network access: api\.example\.com/);
  assert.match(first[1].message, /Glasses microphone: Listen through the glasses microphone/);
  assert.equal(first[1].neutralButtonText, 'View Privacy Policy');
  assert.deepEqual(calls.map(([kind]) => kind), ['confirm', 'policy', 'confirm'], 'viewing the policy asks again');
  assert.equal(calls[1][1], 'https://example.com/p');
});

test('the phone prompt without a policy resolves on Cancel', async () => {
  const { hub, calls } = loadHub({ confirm: [false] });
  assert.equal(await hub.confirmOnPhone({ appName: 'Demo', permissions: [], privacyPolicyUrl: '' }), false);
  assert.equal(calls[0][1].neutralButtonText, undefined);
});

test('GET installs with the phone prompt; OPEN launches the installed app', async () => {
  const installed = {};
  const { hub, calls } = loadHub({ installed });
  const statuses = [];
  await hub.runHubAction(storeApp('demo'), (status) => statuses.push(status));
  assert.equal(calls[0][0], 'install');
  assert.equal(calls[0][2], hub.confirmOnPhone, 'the phone prompt, not the glasses layer');
  assert.deepEqual(statuses, ['']);
  installed.demo = { packageId: 'demo', version: '1.0.0' };
  await hub.runHubAction(storeApp('demo'), () => {});
  assert.deepEqual(calls[1], ['launch', 'evenhub-installed:demo']);
});

test('a failed install is reported, and a second tap while busy is ignored', async () => {
  let release;
  const { hub, calls } = loadHub({ install: () => new Promise((_resolve, reject) => { release = reject; }) });
  const first = hub.runHubAction(storeApp('demo'), () => {});
  assert.equal(hub.isInstalling('demo'), true);
  await hub.runHubAction(storeApp('demo'), () => {});
  release(new Error('HTTP 500'));
  await first;
  assert.deepEqual(calls, [['alert', 'Could Not Install demo', 'HTTP 500']]);
  assert.equal(hub.isInstalling('demo'), false);
});

// ---- hub pages: flows ----------------------------------------------------

const noUpdates = { checkForEvenHubUpdates: async () => [], describeUpdate: () => ({}) };
const openHub = (hub) => {
  const page = hub.createPage();
  page.emit('loaded');
  const [search, tabs, body] = page.content.content.children;
  return { page, search, tabs, body };
};

test('a search sent while another is loading goes out at once, and the stale reply is dropped', async () => {
  const sent = [];
  const api = { listApps: async () => page([]), searchApps: (query) => new Promise((resolve) => sent.push({ query, resolve })) };
  const { hub } = loadHub({ api, updates: noUpdates });
  const { search, body } = openHub(hub);
  await tick();
  search.text = 'abc'; search.emit('submit');
  search.text = 'xyz'; search.emit('submit');
  assert.deepEqual(sent.map(({ query }) => query), ['abc', 'xyz'], 'the second search is sent without waiting');
  sent[0].resolve(page(['old'], { total: 1 }));
  await tick();
  assert.ok(shownText(body).includes('Results for “xyz”'));
  assert.ok(!shownText(body).includes('old'), 'the stale reply is dropped');
  assert.ok(shownText(body).includes('Loading…'), 'the newer search still shows as loading');
  sent[1].resolve(page(['new'], { total: 1 }));
  await tick();
  assert.ok(shownText(body).includes('new'));
  assert.ok(!shownText(body).includes('Loading…'));
});

test('the search field is never inside the rebuilt body, and a row keeps its pill reachable', async () => {
  const { hub, kit } = loadHub({ api: { listApps: async () => page(['a'], { total: 1 }) }, updates: noUpdates });
  const { search, tabs, body } = openHub(hub);
  await tick();
  assert.ok(kit.builds > 1, 'the body was rebuilt');
  assert.equal(search.className, 'os-hub-search');
  assert.equal(tabs.className, 'os-hub-segments');
  assert.ok(!descendants(body).includes(search) && !descendants(body).includes(tabs));
  const [row] = findClass(body, 'os-hub-row');
  assert.ok(row && !row.accessible, 'an accessible row would hide its pill from VoiceOver');
  assert.equal(findClass(row, 'os-hub-pill').length, 1);
});

test('an expired session alerts once, though the list and the update check both fail', async () => {
  const { hub, calls, AuthError } = loadHub({
    api: { listApps: async () => { throw new AuthError('expired'); } },
    updates: { checkForEvenHubUpdates: async () => { throw new AuthError('again'); }, describeUpdate: () => ({}) },
    alert: () => new Promise(() => {}),
  });
  openHub(hub);
  await tick();
  assert.deepEqual(calls.filter(([kind]) => kind === 'alert').map(([, title]) => title), ['Signed Out of Even Hub']);
});

test('a failed icon download is retried; an undrawable SVG keeps the initial without refetching', async () => {
  let downloads = 0;
  const api = { downloadPublicAsset: async () => { if (++downloads === 1) throw new Error('offline'); return { bytes: new Uint8Array([1]), extension: 'svg' }; } };
  const { hub } = loadHub({ api });
  const app = { ...storeApp('demo'), iconPath: 'icons/demo.svg' };
  hub.artworkTile(app, 56);
  await tick();
  const tile = hub.artworkTile(app, 56);
  await tick();
  hub.artworkTile(app, 56);
  await tick();
  assert.equal(downloads, 2);
  assert.deepEqual(tile.children.map((child) => child.className), ['os-hub-initial'], 'SVG falls back to the initial');
  assert.notEqual(tile.children[0].visibility, 'collapse');
});

test('the app page ignores its button while the list is installing the same app', async () => {
  const { hub, load } = loadHub({ install: () => new Promise(() => {}), updates: noUpdates, api: { getStoreAppDetail: async () => null } });
  void hub.runHubAction(storeApp('demo'), () => {});
  const detail = load('app/phone-ui/ios/hub-detail-page.ts').createPage();
  detail.emit('navigatingTo', { context: { app: storeApp('demo') }, isBackNavigation: false });
  const body = detail.content.content;
  const [pill] = findClass(body, 'os-hub-pill');
  assert.equal(pill.text, '…');
  pill.emit('tap');
  assert.ok(!shownText(body).includes('Starting…'), 'no install of its own was started');
});

test('the app page rechecks the installed copy when its tab loads again', async () => {
  let fingerprint = 'before';
  const { load, kit } = loadHub({ fingerprint: () => fingerprint, updates: noUpdates, api: { getStoreAppDetail: async () => null } });
  const detail = load('app/phone-ui/ios/hub-detail-page.ts').createPage();
  detail.emit('navigatingTo', { context: { app: storeApp('demo') }, isBackNavigation: false });
  detail.emit('loaded');
  const builds = kit.builds;
  detail.emit('unloaded');
  detail.emit('loaded');
  assert.equal(kit.builds, builds, 'nothing changed, nothing rebuilt');
  detail.emit('unloaded');
  fingerprint = 'after';
  detail.emit('loaded');
  assert.equal(kit.builds, builds + 1);
});
