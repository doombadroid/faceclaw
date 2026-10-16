// The OcuSmart Hub tab: its store button mapping, list paging, phone permission
// prompt and install/open action, plus the shared install pipeline's glasses
// path after the permission prompt became an injected callback.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const storeApp = (packageId, version = '1.0.0') => ({ packageId, name: packageId, version, iconPath: '', tagline: '', creatorName: '' });
const page = (ids, { total = 0, page = 1, pageSize = 40 } = {}) => ({ apps: ids.map((id) => storeApp(id)), total, page, pageSize });

// ---- store-install: glasses path ----------------------------------------

const loadStoreInstall = ({ permissions = [{ name: 'network' }], installedManifest = null } = {}) => {
  const calls = [];
  const load = loader({}, {
    '../../ui/layers': {},
    './even-api': { evenHubApi: {
      downloadApp: async (id) => { calls.push(['download', id]); return { bytes: new Uint8Array([1]), privacyPolicyUrl: 'https://example.com/p' }; },
      downloadPublicAsset: async () => ({ bytes: new Uint8Array([2]), extension: 'png' }),
    } },
    './installed-apps': {
      readEvenHubPackageManifestBytes: () => ({ name: 'Demo', permissions, privacyPolicyUrl: '' }),
      readEvenHubPackageManifest: () => installedManifest,
      installedEvenHubPackagePath: (id) => `/pkg/${id}`,
      installEvenHubPackageBytes: (_bytes, options) => { calls.push(['install', options.expectedPackageId]); return { packageId: options.expectedPackageId, version: '2.0.0' }; },
    },
    './manager': { closeRunningPackage: (id) => calls.push(['close', id]) },
    './permission-dialog': { EvenHubPermissionDialogLayer: class {
      constructor(name, perms, url, onConfirm, onCancel) { Object.assign(this, { name, perms, url, onConfirm, onCancel }); }
    } },
  });
  return { ...load('app/apps/evenhub/store-install.ts'), calls };
};

const glassesCtx = () => {
  const events = [];
  return { events, stack: { push: (layer) => events.push(['push', layer]) }, actions: { requestRender: () => events.push(['render']) } };
};

test('glasses installs still stack the permission layer, then clear the status and repaint', async () => {
  const { installStoreApp, confirmOnGlasses, calls } = loadStoreInstall();
  const ctx = glassesCtx(), statuses = [];
  const onStatus = (status) => { statuses.push(status); ctx.actions.requestRender(); };
  const pending = installStoreApp(storeApp('demo'), { appendLog() {}, onStatus, confirmPermissions: confirmOnGlasses(ctx, onStatus) });
  await new Promise((resolve) => setImmediate(resolve));
  const pushed = ctx.events.findIndex(([kind]) => kind === 'push');
  assert.ok(pushed >= 0, 'the glasses dialog is stacked');
  const layer = ctx.events[pushed][1], after = ctx.events.slice(pushed + 1);
  assert.deepEqual([layer.name, layer.perms, layer.url], ['Demo', [{ name: 'network' }], 'https://example.com/p']);
  assert.deepEqual(statuses, ['Downloading demo...', ''], 'status clears only once the dialog is stacked');
  assert.ok(after.some(([kind]) => kind === 'render'), 'the stacked dialog is painted');
  assert.deepEqual(calls, [['download', 'demo']], 'nothing installs before Allow');
  layer.onConfirm();
  const result = await pending;
  assert.equal(result.packageId, 'demo');
  assert.equal(statuses.at(-1), 'Installing...');
  assert.deepEqual(calls.slice(1), [['close', 'demo'], ['install', 'demo']], 'running copies close before the package is replaced');
});

test('declining the glasses dialog installs nothing', async () => {
  const { installStoreApp, confirmOnGlasses, calls } = loadStoreInstall();
  const ctx = glassesCtx();
  const pending = installStoreApp(storeApp('demo'), { appendLog() {}, onStatus() {}, confirmPermissions: confirmOnGlasses(ctx, () => {}) });
  await new Promise((resolve) => setImmediate(resolve));
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

const loadHub = ({ installed = {}, present = () => true, confirm = [], install } = {}) => {
  const calls = [];
  const installedApps = {
    getInstalledEvenHubApp: (id) => installed[id] ?? null,
    getInstalledEvenHubApps: () => Object.values(installed),
    getInstalledEvenHubFingerprint: () => '',
    installedEvenHubAppId: (id) => `evenhub-installed:${id}`,
    installedEvenHubPackagePath: (id) => `/pkg/${id}`,
  };
  class AuthError extends Error {}
  const evenApi = { evenHubApi: {}, EvenHubAuthenticationError: AuthError };
  const answers = [...confirm];
  const load = loader({}, {
    '@nativescript/core': {
      Dialogs: {
        confirm: async (options) => { calls.push(['confirm', options]); return answers.shift(); },
        alert: async (options) => { calls.push(['alert', options.title, options.message]); },
      },
    },
    './ui-kit': {},
    './runtime': { getRuntime: () => ({ controller: { launchApp: async (id) => calls.push(['launch', id]) } }) },
    './shell': {},
    '../../branding': { APP_NAME: 'OcuSmart' },
    '../../apps/evenhub/even-api': evenApi,
    './even-api': evenApi,
    '../../apps/evenhub/credentials': {},
    '../../apps/evenhub/installed-apps': installedApps,
    './installed-apps': installedApps,
    '../../native/file-access': { statPath: (path) => (present(path) ? { isDirectory: false, sizeBytes: 10 } : null) },
    '../../apps/evenhub/store-install': {
      cleanError: (error) => String(error?.message ?? error),
      installStoreApp: install ?? (async (app, options) => { calls.push(['install', app.packageId, options.confirmPermissions]); return { packageId: app.packageId }; }),
    },
    '../../apps/evenhub/privacy-policy': { openPrivacyPolicyOnPhone: (url) => calls.push(['policy', url]) },
    '../../apps/evenhub/ehpk': {},
    '../../native/svg-rasterizer': {},
    '../../native/gray-image-preview': {},
    '../../native/settings-store': {},
  });
  // Real updates.ts and permissions.ts, so the mapping and labels are production code.
  return { hub: load('app/phone-ui/ios/hub-page.ts'), calls, AuthError };
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
