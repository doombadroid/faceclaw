const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');
const { exportedNames } = require('./helpers/kotlin-export.cjs');

const KOTLIN = 'native/kotlin/shared/src';
const SHERPA_KT = `${KOTLIN}/iosMain/kotlin/com/faceclaw/app/IosSherpa.kt`;
const read = file => fs.readFileSync(file, 'utf8');

/** The ObjC selectors Kotlin/Native gives an interface's funs: f(a, b) -> fA:b:, f() -> f. */
function protocolSelectors(source, name) {
  const body = source.match(new RegExp(`^interface ${name} \\{([\\s\\S]*?)^\\}`, 'm'))[1];
  return [...body.matchAll(/fun (\w+)\(([^)]*)\)/g)].map(([, fn, list]) => {
    const params = list.split(',').map(p => p.trim()).filter(Boolean).map(p => p.split(':')[0].trim());
    return params.length ? `${fn}${params[0][0].toUpperCase()}${params[0].slice(1)}:${params.slice(1).map(p => `${p}:`).join('')}` : fn;
  });
}

test('the ObjC shim implements every selector of the Kotlin protocols it conforms to', () => {
  const kotlin = read(SHERPA_KT), shim = read('App_Resources/iOS/src/FaceclawSherpa.m');
  const implemented = new Set([...shim.matchAll(/^- \([^)]*\)([^{;]+)\{/gm)].map(([, sig]) =>
    sig.trim().split(/\s+/).filter(part => part.includes(':') || !part.includes(')')).map(part => part.includes(':') ? part.split(':')[0] + ':' : part).join('')));
  for (const [protocol, selectors] of [['IosSherpaLoader', protocolSelectors(kotlin, 'IosSherpaLoader')], ['IosPcmRecognizer', protocolSelectors(kotlin, 'IosPcmRecognizer')]]) {
    assert.match(shim, new RegExp(`<FaceclawKit${protocol}>`), protocol);
    for (const selector of selectors) assert.ok(implemented.has(selector), `${protocol}: ${selector}`);
  }
  assert.deepEqual(protocolSelectors(kotlin, 'IosSherpaLoader'), ['recognizerModelDir:whisper:']);
});

test('NativeScript sees the ObjC shim, never sherpa\'s C headers', () => {
  const modulemap = read('App_Resources/iOS/src/module.modulemap');
  assert.match(modulemap, /header "FaceclawSherpa.h"/);
  assert.doesNotMatch(modulemap, /FaceclawSherpaCore|c-api/);
  assert.doesNotMatch(read('App_Resources/iOS/src/FaceclawSherpa.h'), /#(import|include) .*(sherpa|Core)/);
});

test('the on-device STT client drives IosOnDeviceTranscriber with names the Kotlin export has', () => {
  const calls = [];
  let listener = null;
  const transcriber = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return transcriber; } });
  const stt = loader({ FaceclawSherpa: { new: () => ({ loader: true }) }, FaceclawKitIosOnDeviceTranscriber: { alloc: () => transcriber },
    FaceclawKitIosTranscriptListener: 'listener-protocol' }, {
    './asr-model': { asrModelDir: id => `/Models/${id}`, isAsrModelReady: id => id === 'moonshine' },
    './kotlin-data': { toData: bytes => ({ data: [...bytes] }) },
    './kotlin-listener.ios': { kotlinListener: (protocol, methods) => { listener = { protocol, methods }; return methods; } },
  })('app/native/onboard-stt.ios.ts');
  assert.equal(stt.sherpaLoader(), stt.sherpaLoader(), 'one loader for the app');
  assert.equal(stt.onboardModel('onboard-whisper'), 'whisper-base-en');
  assert.equal(stt.onboardModel('onboard-moonshine'), 'moonshine');
  assert.equal(stt.onboardModel('onboard'), null);
  assert.equal(stt.onboardModelError('moonshine'), '');
  assert.match(stt.onboardModelError('whisper-base-en'), /Settings > Voice/);
  const events = [];
  const client = stt.createOnboardSttClient('whisper-base-en', { apiKey: '', onTranscript: event => events.push(['t', event.text, event.isFinal]),
    onStatus: status => events.push(['s', status]), onError: message => events.push(['e', message]), onReady: () => events.push(['ready']) });
  client.start(); client.acceptPcm(new Uint8Array([1, 2])); client.commitSegment(); client.finish(); client.stop();
  assert.deepEqual(calls.map(call => call[0]), ['initWithLoaderModelDirWhisperListener', 'start', 'acceptPcmPcm', 'commitSegment', 'finish', 'cancel']);
  assert.deepEqual(calls[0].slice(1, 4), [{ loader: true }, '/Models/whisper-base-en', true]);
  const exported = exportedNames(SHERPA_KT);
  for (const [name] of calls) assert.ok(exported.has(name), `${name} is not exported by Kotlin`);
  assert.equal(listener.protocol, 'listener-protocol');
  for (const name of Object.keys(listener.methods)) assert.ok(exported.has(name), `${name} is not exported by Kotlin`);
  listener.methods.onReady(); listener.methods.onTranscriptTextIsFinal('hi', false); listener.methods.onErrorMessage('boom');
  assert.deepEqual(events, [['s', 'Loading voice model…'], ['s', 'Listening…'], ['ready'], ['t', 'hi', false], ['e', 'boom']]);
});
