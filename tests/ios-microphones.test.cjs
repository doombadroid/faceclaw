const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');
const { exportedNames } = require('./helpers/kotlin-export.cjs');

const KOTLIN = 'native/kotlin/shared/src';
const exported = exportedNames(`${KOTLIN}/commonMain/kotlin/com/faceclaw/app/audio/ConversationStoreCore.kt`,
  `${KOTLIN}/iosMain/kotlin/com/faceclaw/app/IosMicAudio.kt`,
  `${KOTLIN}/commonMain/kotlin/com/faceclaw/app/callbacks/FaceclawCaptionEngineListener.kt`);

function setup({ port = true, moonshine = false } = {}) {
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
    FaceclawSherpaDiarizer: { alloc: () => ({ initWithSegmentationModelEmbeddingModelWavPathNumClustersThreshold: (...args) => {
      calls.push(['diarizer', ...args]);
      return { startWithProgressCompletion: (progress, done) => calls.push(['diarize', progress, done]) };
    } }) },
  }, {
    '@nativescript/core': { knownFolders: { documents: () => ({ path: '/Docs' }), ios: { library: () => ({ path: '/Lib' }) } } },
    './kotlin-data': { toData: bytes => ({ data: [...bytes] }) },
    './kotlin-listener.ios': { kotlinListener: (protocol, methods) => { listener = { protocol, methods }; return methods; } },
    './asr-model': { isAsrModelReady: id => moonshine && id === 'moonshine', asrModelDir: id => `/Models/${id}` },
    './onboard-stt.ios': { sherpaLoader: () => 'sherpa-loader' },
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

test('caption callbacks arrive with Android types and their voice-print, and Speech is asked for in the foreground', () => {
  const { mic, calls, listener } = setup();
  const heard = [];
  mic.createCaptionListener({ onUtterance: (...args) => heard.push(['utterance', ...args]), onSpeechStart: ms => heard.push(['start', ms]),
    onStatus: status => heard.push(['status', status]), onStopped: error => heard.push(['stopped', error]) });
  const { protocol, methods } = listener();
  assert.equal(protocol, 'protocol');
  const print = { size: 3, getIndex: i => [0.5, -0.25, 1][i] };
  methods.onUtteranceTextEmbeddingStartMsEndMsPeakRms('hello', print, 10, 20, 0.5);
  methods.onUtteranceTextEmbeddingStartMsEndMsPeakRms('no model', null, 30, 40, 0.5);
  methods.onSpeechStartStartMs(5); methods.onStatusStatus(null); methods.onStoppedError(undefined);
  assert.deepEqual(heard, [['utterance', 'hello', print, 10, 20, 0.5], ['utterance', 'no model', null, 30, 40, 0.5], ['start', 5], ['status', ''], ['stopped', null]]);
  // The KotlinFloatArray becomes the Float32Array mic-session matches speakers with.
  assert.deepEqual([...mic.embeddingToFloat32(print)], [0.5, -0.25, 1]);
  // Without the Moonshine download, Apple's recognizer (and its permission).
  assert.equal(mic.captionAsrDir(), 'apple-speech');
  mic.prepareCaptions();
  assert.deepEqual(calls.filter(call => call[0] === 'speech'), [['speech']]);
  assert.equal(mic.recordingsDir(), '/Docs/mic-recordings');
});

test('captions use the downloaded Moonshine model through the sherpa loader, with no Speech prompt', () => {
  const { mic, calls } = setup({ moonshine: true });
  mic.createCaptionEngine();
  assert.deepEqual(calls.find(call => call[0] === 'engine'), ['engine', 'initWithSherpa', 'sherpa-loader']);
  assert.equal(mic.captionAsrDir(), '/Models/moonshine');
  mic.prepareCaptions();
  assert.equal(calls.filter(call => call[0] === 'speech').length, 0);
  // The Kotlin side tells the two apart by this sentinel.
  assert.match(fs.readFileSync(`${KOTLIN}/iosMain/kotlin/com/faceclaw/app/IosMicAudio.kt`, 'utf8'), /const val APPLE_SPEECH = "apple-speech"/);
});

test('iOS re-diarizes a saved WAV through FaceclawSherpaDiarizer, with its selectors from the header', () => {
  const { mic, calls } = setup();
  const events = [];
  mic.startDiarizer('/seg.onnx', '/emb.onnx', '/Docs/mic-recordings/a.wav', -1, 0.5, {
    onProgress: f => events.push(['progress', f]), onDone: json => events.push(['done', json]), onError: m => events.push(['error', m]) });
  assert.deepEqual(calls[0], ['diarizer', '/seg.onnx', '/emb.onnx', '/Docs/mic-recordings/a.wav', -1, 0.5]);
  const [, progress, done] = calls[1];
  progress(0.25); done('[{"startMs":0,"endMs":10,"cluster":0}]', null); done(null, 'Only 16 kHz mono recordings can be re-analyzed.');
  assert.deepEqual(events, [['progress', 0.25], ['done', '[{"startMs":0,"endMs":10,"cluster":0}]'], ['error', 'Only 16 kHz mono recordings can be re-analyzed.']]);
  const header = fs.readFileSync('App_Resources/iOS/src/FaceclawSherpa.h', 'utf8');
  assert.match(header, /initWithSegmentationModel:\(NSString \*\)segmentationModel embeddingModel:\(NSString \*\)embeddingModel\s+wavPath:\(NSString \*\)wavPath numClusters:\(NSInteger\)numClusters threshold:\(float\)threshold;/);
  assert.match(header, /- \(void\)startWithProgress:\(void \(\^\)\(double progress\)\)progress\s+completion:/);
});

test('iOS bundles the Conversations pages My Glasses and the list navigate to', () => {
  const register = fs.readFileSync('app/phone-ui/onboarding-register.ios.ts', 'utf8');
  for (const page of ['phone-ui/conversations-page', 'phone-ui/conversation-page']) {
    assert.match(register, new RegExp(`registerModule\\('${page}', `), page);
    assert.match(register, new RegExp(`registerModule\\('${page}.xml', `), `${page}.xml`);
  }
  assert.match(fs.readFileSync('app/phone-ui/conversations-view-model.ts', 'utf8'), /moduleName: "phone-ui\/conversation-page"/);
  // Ask and Speakers are not bundled, so the iOS list page drops their bar items.
  assert.doesNotMatch(register, /speakers-page|ask-page/);
});

function conversationPage() {
  const calls = [], store = {
    querySessions: () => JSON.stringify([{ id: 4, startedAt: 1000, endedAt: 9000, title: 'Lunch', audioPath: '/Docs/mic-recordings/a.wav',
      audioCodec: 'wav', avgSentiment: 0, segmentCount: 1, speakers: [] }]),
    querySegments: () => JSON.stringify([{ id: 1, speakerId: null, startedAt: 3000, endedAt: 4000, audioOffsetMs: 2500, text: 'hi',
      lang: '', translation: '', translationLang: '', sentiment: 0, emotion: '', angle: null }]),
    deleteSession: id => calls.push(['delete', id]),
  };
  class Observable { notifyPropertyChange() {} }
  const fromObject = values => ({ ...values, get(key) { return this[key]; }, set(key, value) { this[key] = value; } });
  class ActionItem { constructor() { this.ios = {}; this.handlers = {}; } on(event, fn) { this.handlers[event] = fn; } }
  const load = loader({ global: { isIOS: true } }, {
    '@nativescript/core': { Observable, fromObject, ActionItem, Utils: {}, Screen: {}, ImageSource: class {},
      Frame: { topmost: () => ({ goBack: () => calls.push(['back']) }) },
      action: async options => { calls.push(['action', options.actions]); return options.actions.at(-1); },
      confirm: async () => true },
    '../native/mic-native': { conversationStore: () => store, createRecordingPlayer: (path, done) => {
      calls.push(['player', path]);
      return { seekTo: ms => calls.push(['seek', ms]), start: () => calls.push(['play']), pause() {}, release() {}, done };
    } },
    '../apps/microphones/rediarize': {}, '../apps/microphones/sentiment': { summarize: () => ({ trend: [] }) },
    '../apps/microphones/speakers': { speakerRegistry: { all: () => [] } },
  });
  return { load, calls, ActionItem };
}

test('iOS conversation detail plays its recording and offers Delete from one More item', async () => {
  const { load, calls } = conversationPage();
  const items = ['Re-diarize', 'Split speaker...', 'Delete conversation'];
  const page = { actionBar: { actionItems: { getItems: () => [...items], removeItem: item => items.splice(items.indexOf(item), 1),
    addItem: item => items.push(item) } } };
  load('app/phone-ui/conversation-page.ts').navigatingTo({ object: page, context: { sessionId: 4 } });
  assert.equal(page.className, 'os-page');
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'More');
  assert.equal(items[0].ios.position, 'right');
  const model = page.bindingContext;
  assert.equal(model.emptyMessage, '');
  model.transcriptRows[0].onRowTap();
  assert.deepEqual(calls.slice(0, 3), [['player', '/Docs/mic-recordings/a.wav'], ['seek', 2500], ['play']]);
  assert.equal(model.transcriptRows[0].playIndicator, '⏸');
  await items[0].handlers.tap();
  await new Promise(resolve => setImmediate(resolve));
  // A recording offers Re-diarize; no speakers, so no Split; Delete removes the row and goes back.
  assert.deepEqual(calls.slice(3).map(call => JSON.stringify(call)), ['["action",["Re-diarize","Delete conversation"]]', '["delete",4]', '["back"]']);
});

test('iOS 4-mic forwarding runs through the session bridge and its capture-slot owner', () => {
  const { mic } = setup();
  const packets = [], bridge = { calls: [], startAudioForwarding(fn) { this.calls.push('start'); this.fn = fn; return this.free; },
    stopAudioForwarding() { this.calls.push('stop'); }, free: true };
  const listener = mic.createForwardingListener((packet, arm) => packets.push([[...packet], arm]));
  assert.equal(mic.startForwarding(bridge, listener), true);
  bridge.fn(new Uint8Array([1, 2]), 'L');
  assert.deepEqual(packets, [[[1, 2], 'L']]);
  bridge.free = false;
  assert.equal(mic.startForwarding(bridge, listener), false, 'refused while the voice mic holds the slot');
  mic.stopForwarding(bridge); mic.stopForwarding(null);
  assert.deepEqual(bridge.calls, ['start', 'start', 'stop']);
  // mic-session reaches the glasses only through the seam and the bridge lookup.
  assert.doesNotMatch(fs.readFileSync('app/apps/microphones/mic-session.ts', 'utf8'), /\bcom\.faceclaw|\bjava\.|Utils\.android|isAndroid/);
});
