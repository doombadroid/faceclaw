const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const { exportedNames } = require('./helpers/kotlin-export.cjs');

const KOTLIN = 'native/kotlin/shared/src';
const exported = exportedNames(`${KOTLIN}/iosMain/kotlin/com/faceclaw/app/net/IosModelDownloader.kt`,
  `${KOTLIN}/commonMain/kotlin/com/faceclaw/app/callbacks/FaceclawModelDownloaderListener.kt`);

function iosDownloader(files = new Map()) {
  const calls = [];
  let listener = null;
  const downloader = {
    alloc: () => ({ initWithUrlDestPathExpectedSha256ExpectedTotalBytesListener: (...args) => {
      calls.push(['init', ...args.slice(0, 4)]);
      return { start: () => calls.push(['start']), cancel: () => calls.push(['cancel']) };
    } }),
  };
  const fileManager = {
    createDirectoryAtPathWithIntermediateDirectoriesAttributesError: path => calls.push(['mkdir', path]),
    attributesOfItemAtPathError: path => {
      if (!files.has(path)) throw new Error('missing');
      return { objectForKey: key => key === 'NSFileSize' ? files.get(path) : null };
    },
    fileExistsAtPath: path => files.has(path),
    removeItemAtPathError: path => { calls.push(['rm', path]); files.delete(path); },
  };
  const load = loader({
    FaceclawKitIosModelDownloader: downloader, FaceclawKitFaceclawModelDownloaderListener: 'listener-protocol',
    NSFileManager: { defaultManager: fileManager }, NSFileSize: 'NSFileSize', NSURLIsExcludedFromBackupKey: 'backup',
    NSURL: { fileURLWithPath: path => ({ setResourceValueForKeyError: (value, key) => calls.push(['resource', path, value, key]) }) },
  }, {
    '@nativescript/core': { knownFolders: { ios: { library: () => ({ path: '/Lib' }) } } },
    './kotlin-listener.ios': { kotlinListener: (protocol, methods) => { listener = { protocol, methods }; return methods; } },
  });
  return { load, calls, files, listener: () => listener };
}

test('iOS model downloads go through FaceclawKit IosModelDownloader with names the Kotlin export has', () => {
  const { load, calls, listener } = iosDownloader();
  const md = load('app/native/model-downloader.ios.ts');
  assert.equal(md.modelsRoot(), '/Lib/Application Support/models');
  md.modelsRoot();
  // Created once and kept out of iCloud backup (the models re-download).
  assert.deepEqual(calls.splice(0), [['mkdir', '/Lib/Application Support/models'], ['resource', '/Lib/Application Support/models', true, 'backup']]);
  const events = [];
  const handle = md.startModelDownload('https://x/a.onnx', '/m/a.onnx', 'ab', 42, {
    onProgress: bytes => events.push(['progress', bytes]), onDone: () => events.push(['done']), onError: message => events.push(['error', message]),
  });
  assert.deepEqual(calls.splice(0), [['init', 'https://x/a.onnx', '/m/a.onnx', 'ab', 42], ['start']]);
  assert.ok(exported.has('initWithUrlDestPathExpectedSha256ExpectedTotalBytesListener'));
  assert.equal(listener().protocol, 'listener-protocol');
  for (const name of [...Object.keys(listener().methods), 'start', 'cancel']) assert.ok(exported.has(name), `${name} is not exported by Kotlin`);
  const { methods } = listener();
  methods.onProgressBytesDownloadedTotalBytes(7, 42); methods.onDonePath('/m/a.onnx'); methods.onErrorMessage(null);
  assert.deepEqual(events, [['progress', 7], ['done'], ['error', 'download failed']]);
  handle.cancel();
  assert.deepEqual(calls, [['cancel']]);
});

test('iOS model file checks: present means non-empty; delete removes files, .part files and the folder', () => {
  const files = new Map([['/m/a', 5], ['/m/b', 0], ['/m/a.part', 3], ['/m', 1]]);
  const { load, calls } = iosDownloader(files);
  const md = load('app/native/model-downloader.ios.ts');
  assert.equal(md.isModelFilePresent('/m/a'), true);
  assert.equal(md.isModelFilePresent('/m/b'), false);
  assert.equal(md.isModelFilePresent('/m/c'), false);
  md.deleteModelFiles('/m', ['a', 'c']);
  assert.deepEqual(calls.map(call => call[1]), ['/m/a', '/m/a.part', '/m']);
});

test('ASR models download on iOS file by file into modelsRoot, resume from present files, and delete', () => {
  const present = new Set(), started = [];
  let callbacks = null;
  const asr = loader({ global: { isIOS: true } }, {
    './model-downloader': {
      modelsRoot: () => '/Root',
      isModelFilePresent: path => present.has(path),
      startModelDownload: (url, dest, sha, size, cb) => { started.push([url, dest, sha, size]); callbacks = cb; return { cancel: () => started.push(['cancel']) }; },
      deleteModelFiles: (dir, names) => started.push(['delete', dir, names]),
    },
  })('app/native/asr-model.ts');
  const def = asr.ASR_MODELS.moonshine, dir = `/Root/faceclaw-voice-asr/${def.dirName}`;
  assert.equal(asr.asrModelDir('moonshine'), dir);
  assert.equal(asr.isAsrModelReady('moonshine'), false);
  present.add(`${dir}/${def.files[0].name}`);
  const states = [];
  asr.onAsrModelStateChanged('moonshine', state => states.push(state));
  asr.startAsrModelDownload('moonshine');
  // The first file is already there: the download starts at the second, counting the first.
  assert.deepEqual(started[0], [`${def.baseUrl}${def.files[1].name}`, `${dir}/${def.files[1].name}`, def.files[1].sha256, def.files[1].sizeBytes]);
  callbacks.onProgress(10);
  assert.equal(asr.asrModelState('moonshine').bytesDownloaded, def.files[0].sizeBytes + 10);
  present.add(`${dir}/${def.files[1].name}`); callbacks.onDone();
  assert.equal(started[1][1], `${dir}/${def.files[2].name}`);
  present.add(`${dir}/${def.files[2].name}`); callbacks.onDone();
  assert.equal(asr.asrModelState('moonshine').status, 'ready');
  assert.equal(states.at(-1).status, 'ready');
  asr.deleteAsrModel('moonshine');
  assert.deepEqual(started.at(-1), ['delete', dir, def.files.map(file => file.name)]);
});
