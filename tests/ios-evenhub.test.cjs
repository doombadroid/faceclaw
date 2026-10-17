const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { zstdCompressSync } = require('node:zlib');
const { loader } = require('./helpers/load-typescript.cjs');

function pack(files) {
  const key = Buffer.from('EVEN REALITIES');
  const xor = b => Buffer.from(b.map((v, i) => v ^ key[i % key.length]));
  const header = Buffer.alloc(20); header.write('EHPK'); header.writeUInt32LE(20, 8);
  return Buffer.concat([header, ...Object.entries(files).map(([name, value]) => {
    const text = Buffer.from(value), body = zstdCompressSync(text), path = Buffer.from(name), record = Buffer.alloc(16);
    record.writeUInt32LE(0xbaa9bae4); record.writeUInt32LE(body.length, 4); record.writeUInt32LE(text.length, 8); record.writeUInt16LE(path.length, 14);
    return Buffer.concat([record, xor(path), xor(body)]);
  })]);
}

test('EHPK entrypoints and extraction paths cannot escape their package directory', () => {
  const load = loader({}, { fzstd: require('fzstd') });
  const api = load('app/apps/evenhub/ehpk.ts');
  assert.equal(api.safeEhpkPath('dist/assets/game.js'), true);
  for (const path of ['../settings.json', '/private/file', 'dist/../../file', 'dist\\file', 'dist//x', '.', '..', 'x\0y', 'https://host/app']) {
    assert.equal(api.safeEhpkPath(path), false);
    assert.throws(() => api.parseManifest(JSON.stringify({ entrypoint: path })), /entrypoint/);
    assert.throws(() => api.parseEhpk(pack({ [path]: 'test' })), /invalid file path/);
  }
  const archive = api.parseEhpk(pack({ 'app.json': '{"package_id":"test.app"}', 'dist/index.html': '<html>test</html>' }));
  assert.ok(archive.files.has('dist/index.html'));
});

test('Files on iOS exposes Run app for EHPKs and passes the selected local path', () => {
  let browserOptions, actions, opened, installed;
  const load = loader({ global: { isIOS: true } }, {
    '../../native/file-access': {}, '../../native/font-files': { isFontFile: () => false },
    '../../graphics/installed-fonts': {}, '../../native/image-files': { isDecodableImageFile: name => name.endsWith('.heic') },
    '../../native/video-player': { isPlayableVideoFile: name => name.endsWith('.mp4') },
    '../evenhub/installed-apps': { readEvenHubPackageManifest: () => null }, '../evenhub/permission-dialog': {},
    './file-browser': { FileBrowserLayer: class { constructor(options) { browserOptions = options; } } },
    './file-info-dialog': { FileInfoDialogLayer: class { constructor(entry, value) { actions = value; } } },
    './font-previewer': {}, './image-viewer': {}, './text-viewer': {},
    '../../ui/shell/in-process-window': { createInProcessWindow: () => ({}) }, '../../ui/shell/shell': {},
  });
  load('app/apps/files/files-app.ts').createFilesAppWindow({ openEhpkApp: path => { opened = path; }, installEhpkApp: path => { installed = path; } });
  assert.equal(browserOptions.isSupportedFile('test.EHPK'), true);
  assert.equal(browserOptions.isSupportedFile('clip.mp4'), true);
  assert.equal(browserOptions.isSupportedFile('clip.mkv'), false);
  const ctx = { stack: { push() {}, pop() {} } };
  browserOptions.onFilePicked({ name: 'test.ehpk', path: '/Documents/test.ehpk' }, ctx);
  assert.deepEqual(Array.from(actions, a => a.label), ['Run app', 'Install']);
  actions[0].onSelect(ctx); assert.equal(opened, '/Documents/test.ehpk');
  actions[1].onSelect(ctx); assert.equal(installed, '/Documents/test.ehpk');
  assert.equal(browserOptions.isSupportedFile('photo.heic'), true);
  browserOptions.onFilePicked({ name: 'photo.heic', path: '/Documents/photo.heic' }, ctx);
  assert.deepEqual(Array.from(actions, a => a.label), ['View here', 'Open in new window']);
  browserOptions.onFilePicked({ name: 'clip.mp4', path: '/Documents/clip.mp4' }, ctx);
  assert.deepEqual(Array.from(actions, a => a.label), ['Play video']);
});

test('iOS image files decode through ImageIO and take the photo tone in Kotlin', () => {
  const calls = [];
  const packet = { bytes: [2, 0, 1, 0, 128, 255] };
  const api = loader({ global: { isIOS: true }, console,
    interop: { bufferFromData: d => new Uint8Array(d.bytes).buffer },
    FaceclawGraphics: { decodeImageFileMaxWidthMaxHeight: (...args) => { calls.push(['decode', ...args]); return args[0] === '/bad' ? null : packet; } },
    FaceclawKitIosProtocol: { new: () => ({ tonePacketGammaDither: (p, gamma, dither) => { calls.push(['tone', gamma, dither]); return { bytes: [2, 0, 1, 0, 9, 9] }; } }) },
  }, { '../graphics/image': { GrayImage: class { constructor(w, h) { this.width = w; this.height = h; this.pixels = new Uint8Array(w * h); } } } })(
    'app/native/image-files.ts');
  const photo = api.loadImageFileAsGray('/a.jpg', 635.6, 300, api.PHOTO_TONE);
  assert.deepEqual([photo.width, photo.height, [...photo.pixels]], [2, 1, [9, 9]]);
  const flat = api.loadImageFileAsGray('/b.png', 10, 10);
  assert.deepEqual([...flat.pixels], [128, 255], 'the flat tone skips the Kotlin call');
  assert.equal(api.loadImageFileAsGray('/bad', 10, 10), null);
  assert.deepEqual(calls, [['decode', '/a.jpg', 636, 300], ['tone', 2.2, true], ['decode', '/b.png', 10, 10], ['decode', '/bad', 10, 10]]);
});

test('local package runtimes unpack independently and clean up after closing or a failed launch', async () => {
  const files = new Map(), sessions = [];
  const manifest = { package_id: 'test.app', name: 'Test' };
  let archive = pack({ 'app.json': JSON.stringify(manifest), 'dist/index.html': '<html>test</html>' });
  class Session { constructor(manifest, distDir) { this.manifest = manifest; this.distDir = distDir; sessions.push(this); } attachWebView(handle) { this.handle = handle; } close() { this.handle.destroy(); } }
  const load = loader({ global: { isIOS: true } }, {
    '@nativescript/core': { Application: {} }, fzstd: require('fzstd'),
    '../../native/file-access': { appFilesDirPath: () => '/private/app', readBinaryFile: () => archive,
      writeBinaryFile: (path, bytes) => { files.set(path, bytes); return true; },
      deletePathRecursively: path => { for (const key of files.keys()) if (key.startsWith(path + '/')) files.delete(key); } },
    './session': { EvenHubSession: Session }, './evenhub-window': { createEvenHubWindow: () => ({}) },
    './webview': { createEvenHubWebView: () => ({ evaluateJs() {}, destroy() {} }) },
    '../../ui/shell/shell': {}, './installed-apps': { readEvenHubPackageManifest: () => ({ packageId: 'test.app' }) },
  });
  const manager = load('app/apps/evenhub/manager.ts'), ctx = { appendLog() {}, launchInProcessApp: async () => {} };
  await manager.launchPackage(ctx, '/test.ehpk'); await manager.launchPackage(ctx, '/test.ehpk');
  assert.notEqual(sessions[0].distDir, sessions[1].distDir); assert.equal(manager.runningAppCount(), 2);
  sessions[0].close(); assert.equal(manager.runningAppCount(), 1);
  assert.ok(files.has(sessions[1].distDir + '/index.html')); assert.ok(!files.has(sessions[0].distDir + '/index.html'));
  sessions[1].close(); assert.equal(files.size, 0);
  await assert.rejects(manager.launchPackage({ ...ctx, launchInProcessApp: async () => { throw new Error('test launch failed'); } }, '/test.ehpk'), /test launch failed/);
  assert.equal(files.size, 0); assert.equal(manager.runningAppCount(), 0);
  archive = pack({ 'app.json': JSON.stringify(manifest) });
  await assert.rejects(manager.launchPackage(ctx, '/bad.ehpk'), /entrypoint is missing/);
  assert.equal(files.size, 0);
});

function sessionHarness(overrides = {}, playBuzzer = () => {}, permissions = []) {
  const settings = new Map(), logs = [], renders = [], imu = [];
  const load = loader({ global: { isIOS: true }, setTimeout, clearTimeout, Promise }, {
    '@nativescript/core': { ApplicationSettings: { getString: (k, d) => settings.get(k) ?? d, setString: (k, v) => settings.set(k, v) } },
    'upng-js': require('upng-js'),
    '../../graphics/evenhub-font': { EvenHubFont: { get: () => ({ drawText() {}, drawTextWrapped() {}, lineHeight: 20 }) } },
    '../../ui/dashboard-settings': {}, '../../ui/sound-effects': {}, './api-key-dialog': {},
    './mic-router': { evenHubMicRouter: {} }, './imu-router': { evenHubImuRouter: { requestImu: (client, freq) => imu.push(freq), releaseImu: () => imu.push('off') } },
    './compass-router': { evenHubCompassRouter: {} }, '../../assistant/tool-registry': {},
    '../../native/location': {}, '../../native/location-tracker': {}, '../../native/location-permissions': {}, ...overrides,
  });
  const api = load('app/apps/evenhub/session.ts');
  const session = new api.EvenHubSession({ name: 'Probe', packageId: 'test.probe', permissions }, '/test/dist', line => logs.push(line), '', playBuzzer);
  session.attachWindow({ requestRender: () => renders.push(1), windowId: 'probe', closeWindow() {} });
  const web = vm.createContext({ Promise, Map, Date, console });
  web.window = web;
  web.__faceclawEvenHub = { postMessage: (name, args, id) => session.handleBridgeCall(name, args, id) };
  let destroyed = false;
  session.attachWebView({ evaluateJs: script => vm.runInContext(script, web), destroy: () => { destroyed = true; } });
  vm.runInContext(api.EVENHUB_BRIDGE_INJECT_SCRIPT, web);
  const call = (method, data = {}) => web.flutter_inappwebview.callHandler('evenAppMessage', JSON.stringify({ method, data }));
  return { session, call, web, logs, renders, imu, destroyed: () => destroyed };
}

test('injected EvenHub RPC creates, updates and composites an image page with no Android globals', async () => {
  const h = sessionHarness();
  assert.equal(await h.call('createStartUpPageContainer', { containerTotalNum: 1,
    imageObject: [{ containerID: 1, containerName: 'board', xPosition: 0, yPosition: 0, width: 2, height: 2 }] }), 0);
  assert.equal(await h.call('updateImageRawData', { containerID: 1, containerName: 'board', imageData: [0, 80, 160, 255] }), 0);
  const painted = h.session.paint({ width: 576, height: 288 }, true);
  assert.deepEqual([painted.pixels[0], painted.pixels[1], painted.pixels[576], painted.pixels[577]], [0, 80, 160, 255]);
  assert.equal(await h.call('setLocalStorage', { key: 'score', value: '42' }), true);
  assert.equal(await h.call('getLocalStorage', { key: 'score' }), '42');
  const events = [];
  h.web._listenEvenAppMessage = value => events.push(typeof value === 'string' ? JSON.parse(value) : value);
  h.session.handleGesture({ type: 'click', source: 'ring' });
  assert.ok(events.some(e => e.method === 'evenHubEvent'));
  assert.equal(await h.call('audioControl', { isOpen: true }), false, 'no microphone permission declared');
  assert.equal(await h.call('imuControl', { isOpen: true, reportFrq: 240 }), true);
  assert.equal(await h.call('imuControl', { isOpen: false }), true);
  assert.deepEqual(h.imu, [200, 'off']);
  assert.equal(await h.call('getAppLocation'), null);
  h.session.close(); await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(h.destroyed(), true);
});

test('iOS EvenHub audioControl registers with the mic router and PCM reaches the app as audioEvent', async () => {
  const mic = [];
  const router = { requestMic: client => mic.push(['request', client.windowId]), releaseMic: client => mic.push(['release', client.windowId]) };
  const h = sessionHarness({ './mic-router': { evenHubMicRouter: router } }, () => {}, [{ name: 'g2-microphone' }]);
  const events = [];
  h.web._listenEvenAppMessage = value => events.push(typeof value === 'string' ? JSON.parse(value) : value);
  assert.equal(await h.call('audioControl', { isOpen: true }), true);
  assert.equal(await h.call('audioControl', { isOpen: true }), true);
  h.session.deliverAudioPcm(new Uint8Array([1, 255]));
  assert.equal(await h.call('audioControl', { isOpen: false }), true);
  assert.deepEqual(mic, [['request', 'probe'], ['release', 'probe']]);
  const audio = events.filter(e => e.method === 'evenHubEvent').map(e => e.data ?? e.args ?? e).find(e => JSON.stringify(e).includes('audioEvent'));
  assert.match(JSON.stringify(audio), /"audioPcm":\[1,255\]/);
});

test('iOS webview adapter defers loading until handles attach and destroys a not-yet-loaded app', () => {
  const timers = new Map(), calls = [];
  const native = { startEntrypointScript: (...args) => calls.push(args), startURLScript: (...args) => calls.push(args), destroy: () => calls.push('destroy') };
  const load = loader({ FaceclawEvenHubWebView: { new: () => native },
    setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id) }, {
    './session': { EVENHUB_BRIDGE_INJECT_SCRIPT: 'BRIDGE', buildFaceclawExtensionsScript: () => 'EXT' }, '../../version': { FACECLAW_VERSION: 'test' },
  });
  const { createEvenHubWebView } = load('app/apps/evenhub/webview.ios.ts');
  const session = { manifest: { name: 'Probe', entrypoint: 'index.html' }, distDir: '/app/dist' };
  const host = createEvenHubWebView(session); assert.equal(calls.length, 0);
  timers.get(1)(); assert.equal(calls[0][0], '/app/dist'); assert.match(calls[0][2], /postMessage/); assert.match(calls[0][2], /BRIDGEEXT\n}$/, 'the extensions script ends the origin-scoped block');
  host.destroy(); assert.equal(timers.size, 0); assert.equal(calls.at(-1), 'destroy');
  const remote = createEvenHubWebView({ ...session, remoteUrl: 'https://example.test' });
  timers.get(1)(); assert.equal(calls.at(-1)[0], 'https://example.test');
  remote.destroy();
});

test('EvenHub location uses the platform boundary and closes its subscription', async () => {
  let permission = true, callback, starts = 0, stops = 0;
  const fix = { latitude: 12, longitude: 34, accuracyMeters: 5, timestampMs: 1234 };
  const h = sessionHarness({
    '../../native/location-permissions': { ensureFineLocationPermission: async () => permission },
    '../../native/location': { getCurrentLocation: async () => fix },
    '../../native/location-tracker': { LocationTracker: class {
      constructor(value) { callback = value; } start() { starts++; } stop() { stops++; }
    } },
  });
  assert.equal(await h.call('getAppLocation'), null); // No manifest permission.
  h.session.manifest.permissions.push({ name: 'location' });
  assert.deepEqual(JSON.parse(JSON.stringify(await h.call('getAppLocation'))), {
    latitude: 12, longitude: 34, accuracy: 5, timestamp: 1234,
  });
  permission = false;
  assert.equal(await h.call('startAppLocationUpdates'), false);
  permission = true;
  assert.equal(await h.call('startAppLocationUpdates'), true);
  assert.equal(starts, 1);
  const events = [];
  h.web._listenEvenAppMessage = value => events.push(typeof value === 'string' ? JSON.parse(value) : value);
  callback.onLocation(fix);
  assert.equal(events.at(-1).method, 'appLocationChanged');
  h.session.close();
  assert.equal(stops, 1);
});

test('iOS store terminal identity persists and signing crosses the native boundary', () => {
  const settings = new Map();
  const api = loader({ NSUUID: { UUID: () => ({ UUIDString: '12345678-1234-5678-90AB-123456789ABC' }) },
    FaceclawCrypto: { hmacSha256Message: (key, body) => require('node:crypto').createHmac('sha256', key).update(body).digest('base64') },
  }, { '../../native/settings-store': {
    getStringSetting: (key, fallback) => settings.get(key) ?? fallback,
    setStringSetting: (key, value) => settings.set(key, value),
  } })('app/apps/evenhub/even-platform.ios.ts');
  assert.equal(api.getPhoneOpenUdid(), '1234567812345678');
  assert.equal(api.getPhoneOpenUdid(), '1234567812345678');
  assert.equal(settings.size, 1);
  assert.equal(api.hmacSha256Base64('key', 'The quick brown fox jumps over the lazy dog'), '97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=');
});

test('store login and catalog requests use platform signing with the shared wire format', async () => {
  const requests = [], signatures = [];
  let token = '';
  const api = loader({ setTimeout, clearTimeout }, {
    './even-platform': { getPhoneOpenUdid: () => 'fixture-terminal', hmacSha256Base64: (_key, value) => { signatures.push(value); return 'fixture-signature'; } },
    './credentials': { getEvenHubToken: () => token, hasEvenHubCredentials: () => !!token,
      saveEvenHubSession: (_email, value) => { token = value; }, invalidateEvenHubToken() {} },
    '../../util/http': { fetchWithUserAgent: async (url, init) => {
      requests.push({ url, ...init });
      return { status: 200, json: async () => ({ code: 0, data: url.endsWith('/login') ? { token: 'fixture-token' } : { list: [], total: 0 } }) };
    } },
  })('app/apps/evenhub/even-api.ts');
  await api.evenHubApi.signIn('test@example.invalid', 'fixture-password', false);
  await api.evenHubApi.listApps();
  assert.equal(requests.length, 2);
  assert.match(requests[0].headers.common, /openUdid=fixture-terminal/);
  assert.equal(requests[1].headers.token, 'fixture-token');
  assert.equal(requests[1].headers.sign, 'fixture-signature');
  assert.equal(signatures[0], api.signingParts('POST', '/v2/g/login', requests[0].headers.common, '', '', requests[0].body));
});


test('EvenHub buzzer RPC uses the host action on iOS and chunks and paces long sequences', async () => {
  const sounds = loader()('app/ui/sound-effects.ts'), played = [];
  const h = sessionHarness({ '../../ui/sound-effects': sounds }, bytes => played.push([...bytes]));
  const steps = Array.from({ length: 49 }, () => ({ freq: 3000, ms: 1, duty: 25 }));
  await h.session.dispatchExtension('playBuzzer', [steps]);
  assert.equal(played.length, 2);
  assert.deepEqual(played[0], [...sounds.buildSoundSequencePayload(steps.slice(0, 48))]);
  assert.deepEqual(played[1], [...sounds.buildSoundSequencePayload(steps.slice(48))]);
  await h.session.dispatchExtension('playBuzzer', [[null, { freq: 'bad', ms: 10 }]]);
  assert.equal(played.length, 2);
  h.session.close();
});

test('iOS video player drives the Kotlin AVPlayer wrapper and decodes probes and frames', () => {
  const calls = [];
  const native = new Proxy({}, { get: (_, name) => (...args) => {
    calls.push([name, ...args]);
    if (name === 'probePath') return args[0] === '/bad.mov' ? '{"error":"No playable video track"}'
      : '{"width":360,"height":640,"rotation":90,"durationMs":1500,"hasAudio":true}';
    if (name === 'lastFrameWidthHeight') return args[0] === 2 ? { bytes: [7, 8] } : null;
    if (name === 'positionMs') return 1234.5;
    if (name === 'isPlaying') return 1;
  } });
  const api = loader({ console, interop: { bufferFromData: d => new Uint8Array(d.bytes).buffer },
    FaceclawKitIosVideoPlayer: { new: () => native }, FaceclawKitIosVideoListener: 'video' }, {
    './kotlin-listener.ios': { kotlinListener: (protocol, methods) => ({ protocol, ...methods }) },
    '../graphics/image': { GrayImage: class { constructor(w, h) { this.width = w; this.height = h; this.pixels = new Uint8Array(w * h); } } },
  })('app/native/video-player.ios.ts');
  assert.deepEqual(['a.MOV', 'b.mp4', 'c.m4v', 'd.mkv', 'e.webm'].map(api.isPlayableVideoFile), [true, true, true, false, false]);
  assert.deepEqual({ ...api.probeVideo('/a.mov') }, { width: 360, height: 640, durationMs: 1500, hasAudio: true });
  assert.deepEqual({ ...api.probeVideo('/bad.mov') }, { error: 'No playable video track' });
  const events = [];
  const player = new api.VideoPlayer({ onState: (s, ms) => events.push([s, ms]), onError: m => events.push(['error', m]),
    onFrame: () => events.push(['frame']) });
  const listener = calls.find(c => c[0] === 'setListenerListener')[1];
  assert.equal(listener.protocol, 'video');
  listener.onStateChangedStatePositionMs('ended', 1500); listener.onErrorMessage('bad'); listener.onFrame();
  assert.deepEqual(events, [['ended', 1500], ['error', 'bad'], ['frame']]);
  player.start({ path: '/a.mov', surfaceId: 's', rect: { x: 5, y: 6, width: 300.4, height: 168.6 }, monochrome: false, gamma: 2.2, audio: true, startMs: -3 });
  assert.deepEqual(calls.at(-1), ['startPathWidthHeightMonochromeGammaAudioStartMs', '/a.mov', 300, 169, false, 2.2, true, 0]);
  player.seekTo(-5); assert.deepEqual(calls.at(-1), ['seekToPositionMs', 0]);
  assert.equal(player.positionMs(), 1234.5); assert.equal(player.isPlaying(), true);
  assert.deepEqual([...player.lastFrame(2, 1).pixels], [7, 8]);
  assert.equal(player.lastFrame(4, 4), null);
  player.pause(); player.resume(); player.stop(); player.release();
  assert.deepEqual(calls.slice(-5).map(c => c[0]), ['pause', 'resume', 'stop', 'stop', 'setListenerListener']);
});
