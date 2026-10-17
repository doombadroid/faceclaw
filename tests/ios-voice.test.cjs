const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function harness() {
  const native = { startWithEndpointing(endpointing) { this.endpointing = endpointing; return ''; }, startPhoneWithEndpointing(endpointing) { this.endpointing = endpointing; this.phone = true; return this.error ?? ''; },
    startPcmCaptureWithEndpointingPhone(endpointing, phone) { this.pcmCapture = { endpointing, phone }; return this.error ?? ''; },
    cancel() { this.cancels++; }, cancels: 0, finish() { this.finished = true; }, acceptPacket: p => audio.push(p) };
  const audio = [], timers = new Map(), commands = [], text = [], clouds = [], onboards = [];
  // Stands in for cloud-stt-provider: any provider but the on-device ones is a keyed cloud one.
  const local = ['onboard', 'onboard-moonshine', 'onboard-whisper'];
  const provider = {
    usesCloudStt: voice => !local.includes(voice.provider),
    createCloudSttClient(voice, options, continuous) {
      if (local.includes(voice.provider)) return null;
      const client = { options, continuous, pcm: [], started: false, finished: 0, stopped: false,
        start() { this.started = true; }, acceptPcm(bytes) { this.pcm.push([...bytes]); },
        finish() { this.finished++; }, stop() { this.stopped = true; } };
      clouds.push(client); return client;
    },
  };
  let authorization = 3, microphoneAuthorization = 3, microphoneRequests = 0, permissionRequests = 0, release, active = null, modelReady = true;
  // Stands in for onboard-stt.ios (the sherpa model as a CloudSttClient) and the reconnecting wrapper.
  const onboardStt = {
    onboardModel: p => ({ 'onboard-moonshine': 'moonshine', 'onboard-whisper': 'whisper-base-en' })[p] ?? null,
    onboardModelError: () => modelReady ? '' : 'Download the on-device voice model first (Settings > Voice).',
    createOnboardSttClient(model, options) {
      const client = { model, options, pcm: [], started: false, finished: 0, stopped: false,
        start() { this.started = true; }, acceptPcm(bytes) { this.pcm.push([...bytes]); }, finish() { this.finished++; }, stop() { this.stopped = true; } };
      onboards.push(client); return client;
    },
  };
  class ReconnectingSttClient {
    constructor(create, options, continuous) { this.client = create(options); this.client.continuous = continuous; this.client.wrapperOptions = options; }
    start() { this.client.start(); } acceptPcm(pcm) { this.client.acceptPcm(pcm); } finish() { this.client.finish(); } stop() { this.client.stop(); }
  }
  // Stands in for liblc3: a 205-byte packet decodes to 800 samples filled with its counter byte.
  const decoder = { new: () => ({ decodePacket: d => d.length === 205 ? Buffer.alloc(1600, d[204]) : null }) };
  const sandbox = { exports: {}, FaceclawSpeech: { new: () => native, authorizationStatus: () => authorization,
    requestAuthorization: done => { permissionRequests++; done(3); },
    microphoneAuthorizationStatus: () => microphoneAuthorization,
    requestMicrophoneAuthorization: done => { microphoneRequests++; done(3); } },
    setTimeout: fn => { timers.set(fn, fn); return fn; }, clearTimeout: fn => timers.delete(fn),
    NSData: { dataWithBytesLength: (b, n) => Buffer.from(b, 0, n) }, interop: { handleof: b => b, bufferFromData: d => d },
    FaceclawLc3Decoder: decoder,
    require: name => ({ './cloud-stt-provider': provider, './faceclaw-communicator.ios': { FaceclawCommunicatorBridge: { getActive: () => active } },
      './onboard-stt.ios': onboardStt, './reconnecting-stt': { ReconnectingSttClient },
      './kotlin-data': { toData: b => Buffer.from(b), fromData: d => new Uint8Array(d) } })[name] ?? {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/native/voice-control.ios.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  const bridge = new sandbox.exports.IosVoiceControlBridge();
  bridge.onTranscript(event => text.push({ ...event }));
  const session = { enabled: false, isSessionReady: () => true, isAudioCaptureActive() { return this.enabled; }, setMicrophone(enabled, fn) {
    commands.push(enabled); this.enabled = enabled;
    if (enabled) { this.packet = fn; return new Promise(resolve => { release = resolve; }); }
    return Promise.resolve();
  } };
  const onboard = { provider: 'onboard', elevenLabsApiKey: '', openAiApiKey: '', sonioxApiKey: '' };
  return { bridge, native, session, audio, commands, text, timers, clouds, onboards, modelReady: value => { modelReady = value; },
    release: () => release(), activate: s => { active = s; },
    onboard, cloud: { ...onboard, provider: 'soniox', sonioxApiKey: 'key' },
    microphoneAuthorization: value => { microphoneAuthorization = value; }, microphoneRequests: () => microphoneRequests,
    authorization: value => { authorization = value; }, permissionRequests: () => permissionRequests,
    event: event => native.eventHandler(JSON.stringify(event)) };
}
test('iOS speech permission is requested only in foreground and denial stays actionable', async () => {
  const h = harness(); h.authorization(0);
  assert.equal(await h.bridge.prepare(false, false, h.onboard), false); assert.equal(h.permissionRequests(), 0);
  assert.equal(await h.bridge.prepare(true, false, h.onboard), true); assert.equal(h.permissionRequests(), 1);
  h.authorization(2); assert.equal(await h.bridge.prepare(true, false, h.onboard), false);
  assert.match(h.bridge.statusText, /Settings/);
});
test('glasses speech sends PCM-source packets, replaces partials, and drains final text after manual release', async () => {
  const h = harness(); const start = h.bridge.startGlassesCapture(h.session, h.onboard, () => {});
  h.session.packet(new Uint8Array([1, 2, 3])); assert.deepEqual([...h.audio[0]], [1, 2, 3]);
  h.release(); await start;
  h.event({ kind: 'transcript', text: 'hello', final: false });
  h.event({ kind: 'transcript', text: 'hello world', final: false });
  h.bridge.stopPushToTalk(); assert.deepEqual(h.commands, [true, false]); assert.equal(h.native.finished, true);
  h.session.packet(new Uint8Array([4])); assert.equal(h.audio.length, 1);
  h.event({ kind: 'transcript', text: 'Hello world.', final: true });
  h.event({ kind: 'ended', message: 'Ready to send' });
  assert.deepEqual(h.text, [{ text: 'hello', isFinal: false }, { text: 'hello world', isFinal: false }, { text: 'Hello world.', isFinal: true }]);
  h.event({ kind: 'transcript', text: 'stale', final: true }); assert.equal(h.text.length, 3);
  assert.equal(h.timers.size, 0);
});
test('cancel and disconnect during enable cannot resurrect capture or leave its microphone listener active', async () => {
  for (const stop of ['stop', 'handleSessionEnded']) {
    const h = harness(); let ends = 0; h.bridge.onSpeechEnd(() => ends++);
    const start = h.bridge.startGlassesCapture(h.session, h.onboard, () => {});
    h.bridge[stop](); h.release(); await start;
    h.session.packet(new Uint8Array([9]));
    h.event({ kind: 'transcript', text: 'stale', final: true });
    assert.deepEqual(h.commands, [true, false]); assert.equal(h.audio.length, 0); assert.equal(h.text.length, 0);
    assert.equal(h.timers.size, 0); assert.equal(ends, stop === 'stop' ? 0 : 1);
  }
});
test('missing microphone data ends the session and disables the mic with an actionable status', async () => {
  const h = harness(); const start = h.bridge.startGlassesCapture(h.session, h.onboard, () => {}); h.release(); await start;
  for (const fn of h.timers.values()) fn();
  assert.deepEqual(h.commands, [true, false]); assert.match(h.bridge.statusText, /No microphone audio/);
});

test('hands-free endpointing releases the microphone and waits for the final transcript before completing', async () => {
  const h = harness(); let ends = 0, completed = false;
  h.bridge.onSpeechEnd(() => ends++);
  const start = h.bridge.startGlassesCapture(h.session, h.onboard, () => {}, true); h.release(); await start;
  assert.equal(h.native.endpointing, true);
  h.event({ kind: 'transcript', text: 'Set a timer', final: false });
  h.event({ kind: 'finishing' });
  const completion = h.bridge.stopPushToTalk().then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false); assert.equal(ends, 1);
  assert.deepEqual(h.commands, [true, false]);
  h.event({ kind: 'transcript', text: 'Set a timer for five minutes.', final: true });
  h.event({ kind: 'ended' }); await completion;
  assert.equal(completed, true);
  assert.equal(h.text.at(-1).text, 'Set a timer for five minutes.');
  const manual = h.bridge.startGlassesCapture(h.session, h.onboard, () => {}); h.release(); await manual;
  assert.equal(h.native.endpointing, false);
  const cancelled = h.bridge.stopPushToTalk(); h.bridge.stop(); await cancelled;
});

test('phone microphone permission is requested only for foreground preview capture', async () => {
  const h = harness(); h.microphoneAuthorization(0);
  assert.equal(await h.bridge.prepare(true, false, h.onboard), true);
  assert.equal(h.microphoneRequests(), 0, 'glasses input does not need phone microphone permission');
  assert.equal(await h.bridge.prepare(false, true, h.onboard), false);
  assert.equal(h.microphoneRequests(), 0);
  assert.equal(await h.bridge.prepare(true, true, h.onboard), true);
  assert.equal(h.microphoneRequests(), 1);
  h.microphoneAuthorization(2);
  assert.equal(await h.bridge.prepare(true, true, h.onboard), false);
  assert.match(h.bridge.statusText, /Microphone.*Settings/);
});

test('phone capture forwards endpointing and drains final text without touching Bluetooth', async () => {
  const h = harness();
  await h.bridge.startPhoneCapture(h.onboard, () => {}, true);
  assert.equal(h.native.phone, true); assert.equal(h.native.endpointing, true);
  h.bridge.handleSessionEnded();
  h.event({ kind: 'transcript', text: 'First line\nSecond line', final: false });
  assert.equal(h.text.length, 1, 'BLE state changes must not stop phone capture');
  h.event({ kind: 'finishing' });
  let finished = false;
  const completion = h.bridge.stopPushToTalk().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  h.bridge.handleSessionEnded();
  h.event({ kind: 'transcript', text: 'First line\nSecond line.', final: true });
  h.event({ kind: 'ended' }); await completion;
  assert.equal(h.text.at(-1).text, 'First line\nSecond line.');
  assert.deepEqual(h.commands, []);
});

test('background cleanup stops phone capture but preserves glasses capture', async () => {
  const h = harness(); let ends = 0; h.bridge.onSpeechEnd(() => ends++);
  await h.bridge.startPhoneCapture(h.onboard, () => {});
  h.bridge.stopPhoneCapture();
  assert.equal(ends, 1);
  h.event({ kind: 'transcript', text: 'stale', final: true }); assert.equal(h.text.length, 0);
  const start = h.bridge.startGlassesCapture(h.session, h.onboard, () => {}); h.release(); await start;
  h.bridge.stopPhoneCapture();
  h.event({ kind: 'transcript', text: 'on glasses', final: false });
  assert.equal(h.text.at(-1).text, 'on glasses');
  h.bridge.stop();
});

test('phone microphone startup errors end capture with an actionable status', async () => {
  const h = harness(); let ends = 0; h.bridge.onSpeechEnd(() => ends++);
  h.native.error = 'No phone microphone is available.';
  await h.bridge.startPhoneCapture(h.onboard, () => {});
  assert.equal(ends, 1); assert.match(h.bridge.statusText, /No phone microphone/);
  await h.bridge.stopPushToTalk();
});

test('a cloud provider needs no Speech Recognition permission, but phone capture still needs the microphone', async () => {
  const h = harness(); h.authorization(0); h.microphoneAuthorization(0);
  assert.equal(await h.bridge.prepare(false, false, h.cloud), true);
  assert.equal(await h.bridge.prepare(false, true, h.cloud), false);
  assert.equal(await h.bridge.prepare(true, true, h.cloud), true);
  assert.equal(h.permissionRequests(), 0); assert.equal(h.microphoneRequests(), 1);
});

test('the downloaded-model providers need no Speech Recognition permission', async () => {
  const h = harness(); h.authorization(0);
  for (const provider of ['onboard-moonshine', 'onboard-whisper']) assert.equal(await h.bridge.prepare(false, false, { ...h.onboard, provider }), true);
  assert.equal(h.permissionRequests(), 0);
  assert.equal(await h.bridge.prepare(false, false, h.onboard), false, "Apple's recognizer still needs it");
});

test('On-device (Whisper) runs the sherpa model on native PCM like a cloud provider, and a missing model is actionable', async () => {
  const h = harness(); const logs = [];
  const whisper = { ...h.onboard, provider: 'onboard-whisper' };
  const start = h.bridge.startGlassesCapture(h.session, whisper, message => logs.push(message));
  assert.deepEqual({ ...h.native.pcmCapture }, { endpointing: false, phone: false }, 'PCM capture, no Apple recognizer');
  assert.equal(h.clouds.length, 0);
  const client = h.onboards[0];
  assert.equal(client.model, 'whisper-base-en'); assert.equal(client.started, true); assert.equal(client.wrapperOptions.apiKey, '');
  assert.equal(client.continuous(), false);
  h.release(); await start;
  assert.match(logs.at(-1), /on-device whisper-base-en/);
  h.native.pcmHandler(new Uint8Array([3, 4]).buffer);
  client.options.onTranscript({ text: 'hi', isFinal: false });
  const completion = h.bridge.stopPushToTalk();
  h.event({ kind: 'ended', message: 'Ready to send' });
  assert.equal(client.finished, 1);
  client.options.onTranscript({ text: 'Hi there.', isFinal: true });
  await completion;
  assert.deepEqual(client.pcm, [[3, 4]]); assert.equal(client.stopped, true);
  assert.deepEqual(h.text, [{ text: 'hi', isFinal: false }, { text: 'Hi there.', isFinal: true }]);
  // Moonshine without its download: nothing starts and the status says where to get it.
  const m = harness(); m.modelReady(false); let ends = 0; m.bridge.onSpeechEnd(() => ends++);
  await m.bridge.startPhoneCapture({ ...m.onboard, provider: 'onboard-moonshine' }, () => {});
  assert.equal(m.native.pcmCapture, undefined); assert.equal(m.onboards.length, 0);
  assert.match(m.bridge.statusText, /Settings > Voice/); assert.equal(ends, 1);
});

test('glasses cloud capture streams native PCM and completes on the final after the drained audio', async () => {
  const h = harness();
  const start = h.bridge.startGlassesCapture(h.session, h.cloud, () => {});
  assert.deepEqual({ ...h.native.pcmCapture }, { endpointing: false, phone: false });
  const client = h.clouds[0]; assert.equal(client.started, true);
  client.options.onStatus('Listening (Soniox)...');
  h.session.packet(new Uint8Array([1, 2])); assert.equal(h.audio.length, 1, 'LC3 still decodes natively');
  h.release(); await start;
  h.native.pcmHandler(new Uint8Array([5, 6]).buffer);
  h.event({ kind: 'audio', seconds: 1, packets: 20, rms: 0.1, missing: 0, errors: 0 });
  assert.equal(h.bridge.statusText, 'Listening (Soniox)...', 'the provider status stays up');
  client.options.onTranscript({ text: 'hello', isFinal: false });
  let done = false;
  const completion = h.bridge.stopPushToTalk().then(() => { done = true; });
  assert.deepEqual(h.commands, [true, false]); assert.equal(h.native.finished, true);
  h.event({ kind: 'finishing' });
  assert.equal(client.finished, 0, 'commit waits for the native audio to drain');
  h.native.pcmHandler(new Uint8Array([7]).buffer);
  h.event({ kind: 'ended', message: 'Ready to send' });
  assert.deepEqual(client.pcm, [[5, 6], [7]]); assert.equal(client.finished, 1);
  await Promise.resolve(); assert.equal(done, false);
  client.options.onTranscript({ text: 'Hello there.', isFinal: true });
  await completion;
  assert.equal(client.stopped, true); assert.equal(h.bridge.statusText, 'Ready to send');
  assert.deepEqual(h.text, [{ text: 'hello', isFinal: false }, { text: 'Hello there.', isFinal: true }]);
  assert.equal(h.timers.size, 0);
});

test('cloud capture times out a missing final, keeps native errors, and ends on provider errors', async () => {
  const h = harness();
  await h.bridge.startPhoneCapture(h.cloud, () => {}, true);
  assert.deepEqual({ ...h.native.pcmCapture }, { endpointing: true, phone: true });
  const completion = h.bridge.stopPushToTalk();
  h.event({ kind: 'ended', message: 'Phone microphone interrupted.' });
  assert.equal(h.clouds[0].finished, 1); assert.equal(h.timers.size, 1);
  for (const fn of [...h.timers.values()]) fn();
  await completion;
  assert.equal(h.clouds[0].stopped, true); assert.equal(h.bridge.statusText, 'Phone microphone interrupted.');

  let ends = 0; h.bridge.onSpeechEnd(() => ends++);
  await h.bridge.startPhoneCapture(h.cloud, () => {});
  h.clouds[1].options.onError('Soniox: Invalid API key');
  assert.equal(h.clouds[1].stopped, true); assert.equal(ends, 1);
  assert.match(h.bridge.statusText, /Invalid API key/);
  h.clouds[1].options.onTranscript({ text: 'stale', isFinal: true });
  assert.equal(h.text.length, 0);

  h.native.error = 'No phone microphone is available.';
  await h.bridge.startPhoneCapture(h.cloud, () => {});
  assert.equal(h.clouds[2].started, false, 'no connection without audio');
  assert.match(h.bridge.statusText, /No phone microphone/);
});

test('continuous capture shares one stream with push-to-talk and stops only with its own release', async () => {
  const h = harness(); let ends = 0; h.bridge.onSpeechEnd(() => ends++);
  const start = h.bridge.startContinuousCapture(h.session, h.onboard, () => {}); h.release(); await start;
  assert.equal(h.native.continuous, true); assert.equal(h.native.endpointing, false);
  const cancels = h.native.cancels;
  await h.bridge.startGlassesCapture(h.session, h.onboard, () => {}, true);
  assert.deepEqual(h.commands, [true], 'push-to-talk joins the live stream'); assert.equal(h.native.cancels, cancels);
  h.event({ kind: 'transcript', text: 'joined', final: false });
  await h.bridge.stopPushToTalk(); h.bridge.stop();
  assert.deepEqual(h.commands, [true]); assert.equal(h.native.finished, undefined);
  h.event({ kind: 'finishing' }); assert.equal(ends, 0, 'continuous capture never finishes on an endpoint');
  h.event({ kind: 'transcript', text: 'Still here.', final: true });
  assert.deepEqual(h.text.map(event => event.text), ['joined', 'Still here.']);
  h.bridge.stopContinuousCapture();
  assert.deepEqual(h.commands, [true, false]); assert.equal(h.native.cancels, cancels + 1);
  h.event({ kind: 'transcript', text: 'stale', final: true }); assert.equal(h.text.length, 2);
  assert.equal(h.timers.size, 0);
});

test('continuous capture parks on a session end or lock and resumes on the next session', async () => {
  const h = harness(); let ends = 0; h.bridge.onSpeechEnd(() => ends++);
  const start = h.bridge.startContinuousCapture(h.session, h.onboard, () => {}); h.release(); await start;
  h.bridge.handleSessionEnded('Glasses locked.');
  assert.deepEqual(h.commands, [true, false]); assert.equal(h.bridge.hasSuspendedCapture(), true);
  assert.equal(h.bridge.statusText, 'Waiting for the glasses...');
  h.bridge.stop(); assert.equal(h.bridge.hasSuspendedCapture(), true, 'closing a voice dialog does not drop the parked capture');
  const resumed = h.bridge.resumeCapture(h.session, h.onboard, () => {});
  assert.equal(h.bridge.hasSuspendedCapture(), false); h.release(); await resumed;
  assert.deepEqual(h.commands, [true, false, true]); assert.equal(h.native.continuous, true);
  h.bridge.handleSessionEnded(); h.bridge.stopContinuousCapture();
  assert.equal(h.bridge.hasSuspendedCapture(), false, 'a capture released while parked is not resumed');
  await h.bridge.resumeCapture(h.session, h.onboard, () => {}); assert.deepEqual(h.commands, [true, false, true, false]);
  for (const fn of [...h.timers.values()]) fn();
});

test('continuous cloud capture tells the provider it is open-ended and pauses reach onSpeechPause', async () => {
  const h = harness(); let pauses = 0; h.bridge.onSpeechPause(() => pauses++);
  await h.bridge.startContinuousCapture(null, h.cloud, () => {});
  assert.deepEqual({ ...h.native.pcmCapture }, { endpointing: false, phone: true });
  assert.equal(h.clouds[0].continuous(), true);
  h.event({ kind: 'pause' }); assert.equal(pauses, 1);
  h.bridge.stopContinuousCapture(); assert.equal(h.clouds[0].stopped, true);
  assert.equal(h.clouds[0].continuous(), false);
});

test('continuous capture delivers one final per rolled utterance and keeps listening (Calculator)', async () => {
  const h = harness(); let ends = 0; h.bridge.onSpeechEnd(() => ends++);
  const start = h.bridge.startContinuousCapture(h.session, h.onboard, () => {}); h.release(); await start;
  for (const text of ['two plus two', 'five times six']) {
    h.event({ kind: 'transcript', text, final: false });
    h.event({ kind: 'transcript', text, final: true });
    h.event({ kind: 'pause' });
  }
  assert.deepEqual(h.text.filter(event => event.isFinal).map(event => event.text), ['two plus two', 'five times six']);
  assert.equal(ends, 0); assert.deepEqual(h.commands, [true]);
  // The Calculator's tap-to-talk joins and leaves without ending the stream.
  await h.bridge.startGlassesCapture(h.session, h.onboard, () => {});
  h.event({ kind: 'transcript', text: 'square root of nine', final: true });
  await h.bridge.stopPushToTalk();
  assert.equal(h.text.at(-1).text, 'square root of nine'); assert.deepEqual(h.commands, [true]);
  h.bridge.stopContinuousCapture(); assert.deepEqual(h.commands, [true, false]);
});

test('partials keep flowing across a roll, and the script tracker keeps its place (Teleprompter)', async () => {
  const { loader } = require('./helpers/load-typescript.cjs');
  const { ScriptTracker, tokenizeScript } = loader({}, {})('app/apps/teleprompter/script-tracker.ts');
  const tracker = new ScriptTracker(tokenizeScript('four score and seven years ago our fathers brought forth a new nation').words);
  const h = harness(); h.bridge.onTranscript(event => tracker.feed(event.text));
  const start = h.bridge.startContinuousCapture(h.session, h.onboard, () => {}); h.release(); await start;
  for (const partial of ['four score', 'four score and seven years ago']) h.event({ kind: 'transcript', text: partial, final: false });
  h.event({ kind: 'transcript', text: 'Four score and seven years ago.', final: true });
  h.event({ kind: 'pause' });
  const atRoll = tracker.position;
  // REPLACE semantics: the next utterance's partials start from empty text.
  for (const partial of ['our fathers', 'our fathers brought forth']) h.event({ kind: 'transcript', text: partial, final: false });
  assert.deepEqual(h.text.slice(-2).map(event => event.text), ['our fathers', 'our fathers brought forth']);
  assert.equal(atRoll, 6); assert.equal(tracker.position, 10);
  h.bridge.stopContinuousCapture();
});

test('saved voice recordings follow the provider selection into the native capture', async () => {
  const h = harness();
  await h.bridge.startPhoneCapture({ ...h.onboard, saveRecording: true }, () => {});
  assert.equal(h.native.saveRecording, true);
  h.bridge.stop(); await h.bridge.startContinuousCapture(null, h.cloud, () => {});
  assert.equal(h.native.saveRecording, false);
  h.bridge.stopContinuousCapture();
});

// A 205-byte stock packet: 200 LC3 bytes, SSR and angle (s16 LE), counter.
function micPacket(counter, angle, ssr) {
  const packet = new Uint8Array(205), view = new DataView(packet.buffer);
  view.setInt16(200, ssr, true); view.setInt16(202, angle, true); packet[204] = counter;
  return packet;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('the raw tap decodes glasses PCM with its DSP trailer, yields to STT, and comes back after it and after a session end', async () => {
  const h = harness(); const pcm = [], meta = [];
  h.bridge.onRawPcm(bytes => pcm.push(bytes)); h.bridge.onFrameMeta(m => meta.push(m));
  assert.equal(h.bridge.startRawCapture({ communicator: null, owner: 'evenhub' }), false, 'no session yet');
  h.activate(h.session);
  assert.equal(h.bridge.startRawCapture({ communicator: null, owner: 'evenhub' }), true);
  assert.equal(h.bridge.startRawCapture({ communicator: null, owner: 'microphones' }), true);
  h.bridge.resumeRawCapture();
  assert.deepEqual(h.commands, [true], 'single-flight: one enable while it awaits its ACK');
  assert.equal(h.bridge.isRawCaptureLive(), true, 'still coming up counts as live');
  h.release(); await flush();
  const rawPacket = h.session.packet;
  rawPacket(micPacket(7, -30, 12)); rawPacket(new Uint8Array(10));
  assert.equal(pcm.length, 1); assert.equal(pcm[0].length, 1600); assert.equal(pcm[0][0], 7);
  assert.deepEqual(meta.map(m => ({ ...m })), [{ angleDegrees: -30, ssr: 12 }]);
  // Push-to-talk preempts the tap on the same session and refuses a restart while it holds.
  const stt = h.bridge.startGlassesCapture(h.session, h.onboard, () => {});
  assert.equal(h.bridge.isRawCaptureLive(), false);
  rawPacket(micPacket(8, 0, 0)); assert.equal(pcm.length, 1);
  assert.equal(h.bridge.startRawCapture({ communicator: null, owner: 'evenhub' }), false);
  h.bridge.resumeRawCapture(); assert.deepEqual(h.commands, [true, true]);
  h.release(); await stt; h.bridge.stopPushToTalk(); h.event({ kind: 'ended' });
  h.bridge.resumeRawCapture(); assert.deepEqual(h.commands, [true, true, false, true]);
  h.release(); await flush();
  h.session.packet(micPacket(9, 5, 3)); assert.equal(pcm.length, 2);
  // A session end parks it with its owners; the next acked frame resumes it.
  h.bridge.handleSessionEnded(); assert.deepEqual(h.commands, [true, true, false, true, false]);
  assert.equal(h.bridge.isRawCaptureLive(), false);
  h.bridge.resumeRawCapture(); h.release(); await flush();
  assert.deepEqual(h.commands, [true, true, false, true, false, true]);
  h.bridge.stopRawCapture('evenhub'); assert.equal(h.commands.length, 6, 'another owner still wants it');
  h.bridge.stopRawCapture('microphones'); assert.equal(h.commands.at(-1), false);
  assert.equal(h.bridge.isRawCaptureLive(), false);
});
test('phone STT releases a glasses raw tap, and a parked continuous capture keeps the tap off', async () => {
  const h = harness(); h.activate(h.session);
  h.bridge.startRawCapture({ communicator: null, owner: 'evenhub' }); h.release(); await flush();
  await h.bridge.startPhoneCapture(h.onboard, () => {});
  assert.deepEqual(h.commands, [true, false]);
  h.bridge.stopPhoneCapture();
  const start = h.bridge.startContinuousCapture(h.session, h.onboard, () => {}); h.release(); await start;
  h.bridge.handleSessionEnded(); h.bridge.resumeRawCapture();
  assert.deepEqual(h.commands, [true, false, true, false], 'the parked holder owns the mic');
  h.bridge.stopContinuousCapture(); h.bridge.resumeRawCapture();
  assert.deepEqual(h.commands, [true, false, true, false, true]);
});
