const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');

// The JavaScript names NativeScript gives Kotlin/Native's ObjC export: the function name,
// then each parameter name capitalized (fun f(a, b) -> fA:b: -> fAB); constructors are
// initWith + parameters. Derived from the Kotlin sources so a renamed parameter fails here,
// not on the phone.
function exportedNames(...files) {
  const names = new Set();
  const cap = s => s[0].toUpperCase() + s.slice(1);
  const params = list => list.split(',').map(p => p.trim()).filter(Boolean).map(p => p.split(':')[0].trim().split(/\s+/).pop());
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [, name, list] of source.matchAll(/^\s*(?:override )?fun (\w+)\(([^)]*)\)/gm)) names.add(name + params(list).map(cap).join(''));
    for (const [, list] of source.matchAll(/^(?:open )?class \w+\(([^)]*)\)/gm)) names.add('initWith' + params(list).map(cap).join(''));
  }
  return names;
}
const KOTLIN = 'native/kotlin/shared/src';
const exported = exportedNames(`${KOTLIN}/commonMain/kotlin/com/faceclaw/app/audio/ConversationStoreCore.kt`,
  `${KOTLIN}/iosMain/kotlin/com/faceclaw/app/IosMicAudio.kt`,
  `${KOTLIN}/commonMain/kotlin/com/faceclaw/app/callbacks/FaceclawCaptionEngineListener.kt`);

function setup({ port = true } = {}) {
  const calls = [];
  // Every FaceclawKit object records the selectors called on it.
  const native = kind => {
    const self = new Proxy({}, { get: (_, name) => (...args) => {
      calls.push([kind, name, ...args]);
      return name.startsWith('init') ? self : name === 'isOpen' ? true : 7;
    } });
    return self;
  };
  const kotlinClass = kind => ({ alloc: () => native(kind), new: () => native(kind), companion: native(`${kind}.companion`) });
  let listener = null;
  const mic = loader({
    FaceclawKitIosConversationStore: kotlinClass('store'), FaceclawKitIosNoiseSuppressor: kotlinClass('suppressor'),
    FaceclawKitIosCaptionEngine: kotlinClass('engine'), FaceclawKitIosWavRecorder: kotlinClass('recorder'),
    FaceclawKitFaceclawCaptionEngineListener: 'protocol',
    FaceclawSqlite: { alloc: () => ({ initWithPath: path => { calls.push(['sqlite', path]); return port ? { port: true } : null; } }) },
    FaceclawSpeech: { authorizationStatus: () => 0, requestAuthorization: () => calls.push(['speech']) },
    UIApplication: { sharedApplication: { applicationState: 0 } }, UIApplicationState: { Active: 0 },
    NSFileManager: { defaultManager: { removeItemAtPathError: path => calls.push(['rm', path]) } },
  }, {
    '@nativescript/core': { knownFolders: { documents: () => ({ path: '/Docs' }), ios: { library: () => ({ path: '/Lib' }) } } },
    './kotlin-data': { toData: bytes => ({ data: [...bytes] }) },
    './kotlin-listener.ios': { kotlinListener: (protocol, methods) => { listener = { protocol, methods }; return methods; } },
  })('app/native/mic-native.ios.ts');
  return { mic, calls, listener: () => listener };
}

test('every FaceclawKit call the iOS mic seam makes is a name the Kotlin export has', () => {
  const { mic, calls, listener } = setup();
  const store = mic.conversationStore();
  for (const name of Object.keys(store)) store[name](1, 2, 3, 4, 5);
  const suppressor = mic.createNoiseSuppressor(16000);
  suppressor.process('pcm'); suppressor.reset();
  const engine = mic.createCaptionEngine();
  for (const name of ['setListener', 'setAsrModelDir', 'setSpeakerModelPath', 'start', 'stop', 'requestStop', 'acceptPcm']) engine[name]('x');
  const recorder = mic.createWavRecorder('/Docs/mic-recordings/a.wav', 16000, 1);
  for (const name of ['append', 'getDurationMs', 'finish', 'discard']) recorder[name]('x');
  assert.equal(mic.repairWavHeader('/a.wav', 16000, 1), 7);
  mic.createCaptionListener({});
  const used = new Set(calls.filter(call => call[0] !== 'sqlite').map(call => call[1]));
  for (const name of [...used, ...Object.keys(listener().methods)]) assert.ok(exported.has(name), `${name} is not exported by Kotlin`);
  // The store's adapter covers Android's whole store API.
  assert.equal(Object.keys(store).length, 26);
  assert.deepEqual(calls.filter(call => call[1] === 'startSessionStartedAtMsTitle')[0], ['store', 'startSessionStartedAtMsTitle', 1, 2, 3, 4, 5]);
});

test('the iOS store opens one Library database, and a failed open stays an error', () => {
  const { mic, calls } = setup();
  assert.equal(mic.conversationStore(), mic.conversationStore());
  assert.deepEqual(calls.filter(call => call[0] === 'sqlite'), [['sqlite', '/Lib/faceclaw-conversations.db']]);
  assert.deepEqual(calls.find(call => call[0] === 'store'), ['store', 'initWithPort', { port: true }]);
  assert.throws(() => setup({ port: false }).mic.conversationStore(), /could not open/);
});

test('caption callbacks arrive with Android types, never a voice-print, and Speech is asked for in the foreground', () => {
  const { mic, calls, listener } = setup();
  const heard = [];
  mic.createCaptionListener({ onUtterance: (...args) => heard.push(['utterance', ...args]), onSpeechStart: ms => heard.push(['start', ms]),
    onStatus: status => heard.push(['status', status]), onStopped: error => heard.push(['stopped', error]) });
  const { protocol, methods } = listener();
  assert.equal(protocol, 'protocol');
  methods.onUtteranceTextEmbeddingStartMsEndMsPeakRms('hello', { size: 3 }, 10, 20, 0.5);
  methods.onSpeechStartStartMs(5); methods.onStatusStatus(null); methods.onStoppedError(undefined);
  assert.deepEqual(heard, [['utterance', 'hello', null, 10, 20, 0.5], ['start', 5], ['status', ''], ['stopped', null]]);
  assert.equal(mic.captionAsrDir() !== null, true);
  mic.prepareCaptions();
  assert.deepEqual(calls.filter(call => call[0] === 'speech'), [['speech']]);
  assert.equal(mic.recordingsDir(), '/Docs/mic-recordings');
});
