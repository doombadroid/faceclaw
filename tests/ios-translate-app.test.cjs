const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');
// Values built inside the vm sandbox carry its prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const read = file => fs.readFileSync(file, 'utf8');
// The session's timers (throttles, backoff) run 50x fast.
const SCALE = 50;
const fastTimers = {
  setTimeout: (fn, ms = 0) => setTimeout(fn, ms / SCALE), clearTimeout,
  setInterval: (fn, ms = 0) => setInterval(fn, ms / SCALE), clearInterval,
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Translate is registered as a phone page and linked from My Glasses', () => {
  assert.match(read('app/phone-ui/ios/register.ts'), /registerModule\('ocusmart\/translate', \(\) => require\('\.\/translate-page'\)\)/);
  assert.match(read('app/phone-ui/ios/glasses-page.ts'), /title: 'Translate', onTap: \(\) => pushInTab\('glasses', 'ocusmart\/translate'\)/);
});

function allApps(isIOS) {
  const source = read('app/apps/all-apps.ts');
  const mocks = {};
  for (const [, name, path] of source.matchAll(/^import (\w+) from "(\.\/[\w-]+)";$/gm)) mocks[path] = { default: { appId: name } };
  mocks['./app-definition'] = {};
  return loader({ global: { isIOS } }, mocks)('app/apps/all-apps.ts').ALL_APPS.map(app => app.appId);
}

test('ALL_APPS has Translate on iOS only', () => {
  assert.ok(allApps(true).includes('translateApp'));
  assert.ok(!allApps(false).includes('translateApp'), 'Android has no Apple Speech or Translation');
});

test('Translate settings default to Spanish (them) and English (me) over the nine languages', () => {
  const made = [];
  class ConfigSettingEnum { constructor(options) { this.options = options; made.push(options); } }
  const settings = loader({}, { '../../ui/dashboard-settings': { ConfigSettingEnum } })('app/apps/translate/translate-settings.ts');
  assert.equal(settings.translateTheirLanguageSetting.options.defaultValue, 'es');
  assert.equal(settings.translateMyLanguageSetting.options.defaultValue, 'en');
  const ids = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh-Hans'];
  assert.deepEqual(plain(settings.LISTEN_LANGUAGES.map(l => l.id)), ids);
  for (const options of made) assert.deepEqual(plain(options.values), ids);
  assert.notEqual(made[0].storageKey, made[1].storageKey);
  assert.equal(settings.languageName('zh-Hans'), 'Chinese (Simplified)');
  assert.equal(settings.languageCode('zh-Hans'), 'ZH');
  assert.equal(made[0].formatValue('ja'), 'Japanese');
});

// A failed assertion must not leave a session's intervals keeping the process alive.
const sessions = [];
test.afterEach(() => { for (const s of sessions.splice(0)) s.listenSession.stop(); });

function session({ their = 'es', mine = 'en', speech = {}, startFails = () => false } = {}) {
  const calls = [], logs = [], transcribers = [];
  let pcmListener = null;
  const names = { en: 'English', es: 'Spanish', fr: 'French' };
  const load = loader({ global: { isIOS: true }, ...fastTimers }, {
    '../../native/voice-control': { voiceControlBridge: {
      onRawPcm: fn => { pcmListener = fn; return () => { pcmListener = null; }; },
      startRawCapture: options => { calls.push(['mic-on', options.owner]); return true; },
      stopRawCapture: owner => calls.push(['mic-off', owner]),
      isRawCaptureLive: () => true,
    } },
    '../../native/audio-monitor': { audioMonitorCommunicator: () => ({ isSessionReady: () => true }) },
    '../../native/remote-log.ios': { remoteLog: (source, level, msg, data) => logs.push([level, msg, data]) },
    '../../native/live-transcriber': {
      liveTranscriberAvailable: () => true,
      speechLanguageStatus: async lang => ({ supported: true, installed: true, locale: lang, ...speech[lang] }),
      startLiveTranscriber: (lang, onEvent) => {
        if (startFails(lang)) return null;
        const t = { language: lang, emit: onEvent, pcm: 0, finished: false, cancelled: false,
          accept(pcm) { this.pcm += pcm.length; }, finish() { this.finished = true; }, cancel() { this.cancelled = true; } };
        transcribers.push(t);
        return t;
      },
    },
    '../../native/apple-translate': {
      appleTranslateAvailable: () => true,
      translateText: async (text, source, target) => ({ out: `${target}:${text}`, strategy: 'lowLatency', ms: 3 }),
    },
    './language-id': { scorePair: (text, langs) => /hola|como|estas|bien/i.test(text) ? { [langs[0]]: 0.9, [langs[1]]: 0.1 } : { [langs[0]]: 0.1, [langs[1]]: 0.9 } },
    './translate-settings': {
      translateTheirLanguageSetting: { get: () => their }, translateMyLanguageSetting: { get: () => mine },
      languageName: id => names[id] ?? id,
    },
  });
  const { listenSession } = load('app/apps/translate/listen-session.ts');
  const states = [];
  listenSession.onState(state => states.push(plain(state)));
  sessions.push({ listenSession });
  const live = lang => transcribers.filter(t => t.language === lang && !t.cancelled).at(-1);
  return { listenSession, calls, logs, transcribers, live, states, pcm: bytes => pcmListener?.(new Uint8Array(bytes)), get pcmListener() { return pcmListener; } };
}

const final = (t, text, start, end, conf = 0.9) => t.emit({ kind: 'final', text, conf, start, end });

test('Listen refuses a pair of one language and missing speech models', async () => {
  const same = session({ their: 'en', mine: 'en' });
  await same.listenSession.start();
  assert.equal(same.listenSession.state.status, 'error');
  assert.match(same.listenSession.state.message, /two different languages/);
  assert.equal(same.transcribers.length, 0);

  const missing = session({ speech: { es: { installed: false } } });
  await missing.listenSession.start();
  assert.equal(missing.listenSession.state.status, 'error');
  assert.equal(missing.listenSession.state.message, 'Open Translate on the phone to download Spanish.');
  assert.deepEqual(missing.calls, [], 'no mic tap without both models');
});

test('Listen feeds both transcribers, decides the language and translates into the other', async () => {
  const s = session();
  await s.listenSession.start();
  assert.deepEqual(s.transcribers.map(t => t.language), ['es', 'en']);
  assert.deepEqual(s.calls, [['mic-on', 'translate']]);
  assert.equal(s.listenSession.state.status, 'starting');
  s.live('es').emit({ kind: 'ready', locale: 'es-ES' });
  s.live('en').emit({ kind: 'ready', locale: 'en-US' });
  assert.equal(s.listenSession.state.status, 'listening');

  s.pcm(1600);
  assert.deepEqual(s.transcribers.map(t => t.pcm), [1600, 1600], 'every chunk reaches both');

  s.live('es').emit({ kind: 'partial', text: 'hola como', conf: -1, start: 0, end: 0.8 });
  s.live('en').emit({ kind: 'partial', text: 'ola Como', conf: -1, start: 0, end: 0.8 });
  const live = s.listenSession.state.live;
  assert.equal(live.lang, 'es', "only the current direction's partials are live");
  assert.equal(live.text, 'hola como');
  await sleep(10);
  assert.equal(s.listenSession.state.live.translation, 'en:hola como', 'partials of 2+ words are translated live');

  final(s.live('es'), 'hola como estas', 0, 1.2);
  final(s.live('en'), 'ola como is this', 0, 1.2, 0.4);
  await sleep(10);
  const { lines } = s.listenSession.state;
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], id: 0, atMs: 0 },
    { id: 0, lang: 'es', target: 'en', text: 'hola como estas', translation: 'en:hola como estas', final: true, mine: false, atMs: 0 });
  assert.equal(s.listenSession.state.live, null, 'the decided utterance replaces its live line');

  s.listenSession.stop();
  assert.equal(s.listenSession.state.status, 'idle');
  assert.ok(s.transcribers.every(t => t.cancelled));
  assert.deepEqual(s.calls.at(-1), ['mic-off', 'translate']);
  assert.equal(s.pcmListener, null);
});

test('Pause releases the mic and finishes the transcribers; their trailing finals still become lines', async () => {
  const s = session();
  await s.listenSession.start();
  for (const t of s.transcribers) t.emit({ kind: 'ready', locale: t.language });
  s.listenSession.pause();
  assert.equal(s.listenSession.state.status, 'paused');
  assert.deepEqual(s.calls.at(-1), ['mic-off', 'translate']);
  assert.ok(s.transcribers.every(t => t.finished && !t.cancelled));
  const [es, en] = s.transcribers;
  final(en, 'I think we should go now', 0, 1.5);
  final(es, 'ay tink we chud go nao', 0, 1.5, 0.3);
  es.emit({ kind: 'ended' }); en.emit({ kind: 'ended' });
  await sleep(10);
  const { lines } = s.listenSession.state;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].lang, 'en');
  assert.equal(lines[0].mine, true);
  assert.equal(lines[0].translation, 'es:I think we should go now');

  s.listenSession.resume();
  assert.equal(s.transcribers.length, 4, 'resume starts a fresh pair');
  assert.deepEqual(s.calls.at(-1), ['mic-on', 'translate']);
  s.listenSession.stop();
});

test('A failing transcriber is restarted with backoff, then the session reports the error', async () => {
  const s = session();
  await s.listenSession.start();
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = s.transcribers.length;
    s.live('en').emit({ kind: 'error', message: 'model went away' });
    assert.ok(s.transcribers.at(-1).cancelled, 'the failed one is dropped');
    await sleep((1000 * 2 ** attempt) / SCALE + 30);
    assert.equal(s.transcribers.length, before + 1, `restart ${attempt + 1}`);
    assert.equal(s.transcribers.at(-1).language, 'en');
  }
  s.live('en').emit({ kind: 'error', message: 'model went away' });
  assert.equal(s.listenSession.state.status, 'error');
  assert.equal(s.listenSession.state.message, 'English speech recognition stopped: model went away');
  assert.ok(s.transcribers.every(t => t.cancelled), 'both are dropped');
  assert.deepEqual(s.calls.at(-1), ['mic-off', 'translate']);
});

test('A restarted transcriber is shifted onto the session clock', async () => {
  const s = session();
  await s.listenSession.start();
  for (const t of s.transcribers) t.emit({ kind: 'ready', locale: t.language });
  s.pcm(96000); // 3 s
  s.live('en').emit({ kind: 'ended' });
  await sleep(1000 / SCALE + 30);
  const es = s.live('es'), en = s.live('en');
  assert.notEqual(en, s.transcribers[1], 'restarted');
  // Its 0-1 s is the session's 3-4 s, where the Spanish one heard the same utterance.
  final(es, 'hola que tal estas', 3, 4);
  final(en, 'ola kay tal', 0, 1, 0.3);
  await sleep(10);
  assert.deepEqual(plain(s.listenSession.state.lines.map(line => line.text)), ['hola que tal estas'], 'one utterance, one line');
  s.listenSession.stop();
});

function phonePage({ speech, packs, prepare }) {
  const calls = [];
  let page, settingListener = null;
  const listeners = new Map();
  const load = loader(fastTimers, {
    '@nativescript/core': {},
    './ui-kit': {
      groupedPage: ({ build }) => {
        page = { sections: [], on: (event, fn) => listeners.set(event, fn), frame: null };
        const refresh = () => { page.sections = []; build({ addChild: section => page.sections.push(section) }); };
        refresh();
        return { page, refresh };
      },
      section: options => options,
      buttonRow: options => ({ kind: 'button', ...options }),
      valueRow: options => ({ kind: 'value', ...options }),
    },
    './settings-category-page': { settingRows: item => [{ kind: 'choice', title: item.title, unavailable: item.unavailable }] },
    './runtime': { getRuntime: () => ({ controller: { launchApp: id => { calls.push(['launch', id]); return Promise.resolve(); } } }) },
    '../../ui/dashboard-settings': { onAnySettingChanged: fn => { settingListener = fn; return () => { settingListener = null; }; } },
    '../../native/live-transcriber': {
      speechLanguageStatus: async lang => ({ ...speech[lang], locale: lang }),
      installSpeechLanguage: async lang => { calls.push(['install', lang]); speech[lang].installed = true; return null; },
    },
    '../../native/apple-translate': {
      translationStatus: async (a, b) => ({ ...packs[`${a}>${b}`] }),
      prepareTranslation: (a, b) => { calls.push(['prepare', `${a}>${b}`]); return prepare(a, b); },
    },
    '../../apps/translate/translate-settings': {
      translateTheirLanguageSetting: { get: () => 'es' }, translateMyLanguageSetting: { get: () => 'en' },
      languageName: id => ({ en: 'English', es: 'Spanish' })[id],
    },
  });
  load('app/phone-ui/ios/translate-page.ts').createPage();
  const rows = () => page.sections.flatMap(section => section.rows);
  return { calls, rows, find: title => rows().find(row => row.title === title), get page() { return page; },
    load: () => listeners.get('loaded')(), get settingListener() { return settingListener; } };
}

test('Translate page shows what each language needs and Download Missing re-checks after every step', async () => {
  const speech = { es: { supported: true, installed: false }, en: { supported: true, installed: true } };
  const packs = { 'es>en': { lowLatency: 'supported', highFidelity: 'unsupported' }, 'en>es': { lowLatency: 'supported', highFidelity: 'unsupported' } };
  // Apple's prepare downloads the pack (both directions) and never calls back.
  const h = phonePage({ speech, packs, prepare: () => {
    setTimeout(() => { packs['es>en'].lowLatency = packs['en>es'].lowLatency = 'installed'; }, 5);
    return new Promise(() => {});
  } });
  assert.equal(h.find('Speech Recognition — Spanish').value, 'Checking…');
  h.load();
  await sleep(20);
  assert.equal(h.find('Speech Recognition — Spanish').value, 'Download needed');
  assert.equal(h.find('Speech Recognition — English').value, 'Ready');
  assert.equal(h.find('Translation Spanish → English').value, 'Download needed');
  assert.equal(h.find('They Speak').unavailable('en'), 'Chosen for I Speak', 'the two pickers exclude each other');

  h.find('Download Missing').onTap();
  await sleep(250);
  assert.deepEqual(plain(h.calls), [['install', 'es'], ['prepare', 'es>en']], 'en>es was installed by the same download, so not prepared again');
  assert.equal(h.find('Speech Recognition — Spanish').value, 'Ready');
  assert.equal(h.find('Translation Spanish → English').value, 'Fast (offline)');
  assert.equal(h.find('Translation English → Spanish').value, 'Fast (offline)');
  assert.equal(h.find('Download Missing').enabled, false, 'nothing left to download');
  assert.doesNotMatch(h.page.sections[1].footer, /Not finished/);

  h.find('Start on Glasses').onTap();
  assert.deepEqual(plain(h.calls.at(-1)), ['launch', 'translate']);
});

test('Translate page reports a translation download that did not stick', async () => {
  const speech = { es: { supported: true, installed: true }, en: { supported: true, installed: true } };
  const packs = { 'es>en': { lowLatency: 'supported', highFidelity: 'installed' }, 'en>es': { lowLatency: 'installed', highFidelity: 'installed' } };
  const h = phonePage({ speech, packs, prepare: async () => 'timeout' });
  h.load();
  await sleep(20);
  assert.equal(h.find('Translation Spanish → English').value, 'Apple Intelligence');
  h.find('Download Missing').onTap();
  await sleep(50);
  assert.deepEqual(plain(h.calls), [['prepare', 'es>en']]);
  assert.match(h.page.sections[1].footer, /Not finished:\nSpanish → English: not downloaded/);
});

test('Listen lens stacks captions bottom-up: translation bright over the original dim, mine dimmer, clipped under the header', () => {
  const rendered = [];
  let listener = null, state = null;
  const load = loader(fastTimers, {
    '../../graphics/installed-fonts': { ensurePreinstalledFonts() {}, installedFontPath: name => `/fonts/${name}` },
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../../native/font-files': { renderFontFileCaption: opts => {
      rendered.push(opts);
      // A solid 255 block 20 px tall per caption.
      const image = new GrayImage(opts.maxWidth, 20, 255);
      return image;
    } },
    './listen-session': { listenSession: {
      get state() { return state; },
      onState: fn => { listener = fn; fn(state); return () => { listener = null; }; },
      pause() {}, resume() {}, start() {},
    } },
    './translate-settings': { languageCode: id => id.toUpperCase() },
  });
  const { GrayImage } = load('app/graphics/image.ts');
  const font = { lineHeight: 12, ascent: 10, descent: 2, hasGlyph: () => true, getGlyph: () => undefined, measureText: text => text.length * 6, drawText() {} };
  const line = (id, extra) => ({ id, lang: 'es', target: 'en', text: `t${id}`, translation: `tr${id}`, final: true, mine: false, atMs: 0, ...extra });
  state = { status: 'listening', message: '', their: 'es', mine: 'en', current: 'es',
    lines: [line(1), line(2, { lang: 'en', target: 'es', mine: true }), line(3, { translation: '' })], live: null };
  const { ListenLayer } = load('app/apps/translate/listen-layer.ts');
  const layer = new ListenLayer();
  layer.start(() => {});
  const image = layer.paint({ stack: { getBaseSize: () => ({ width: 200, height: 120 }) } });
  // Newest at the bottom: line 3 has no translation yet, so only its original (dim 0.5).
  const at = y => image.pixels[y * 200 + 20];
  assert.ok(at(110) > 100 && at(110) < 160, `pending line shows the dim original (${at(110)})`);
  const mineTranslation = at(110 - 20 - 8 - 20 - 2 - 10);
  assert.ok(mineTranslation > 130 && mineTranslation < 180, `my line's translation is dimmed to ~0.6 (${mineTranslation})`);
  for (let y = 0; y < 4 + 12 + 6; y++) assert.equal(at(y), 0, `row ${y} is the header's`);
  assert.deepEqual(plain(rendered.find(r => r.text === 'tr2')), { path: '/fonts/Roboto-Light.ttf', text: 'tr2', sizePx: 18, maxWidth: 168, maxLines: 3, language: 'es' });
  assert.equal(rendered.find(r => r.text === 't2').language, 'en', 'the original renders in its own language');
  const count = rendered.length;
  layer.paint({ stack: { getBaseSize: () => ({ width: 200, height: 120 }) } });
  assert.equal(rendered.length, count, 'a repaint renders nothing new (LRU)');
  layer.onRemoved();
  assert.equal(listener, null);
});

test('A partial after its transcriber finalized starts a new live line, even before the picker decides', async () => {
  const s = session();
  await s.listenSession.start();
  for (const t of s.transcribers) t.emit({ kind: 'ready', locale: t.language });
  s.live('es').emit({ kind: 'partial', text: 'hola como', conf: -1, start: 0, end: 0.8 });
  await sleep(10);
  const first = s.listenSession.state.live;
  assert.equal(first.translation, 'en:hola como');
  final(s.live('es'), 'hola como estas', 0, 1.2); // the en twin has not finalized: undecided
  s.live('es').emit({ kind: 'partial', text: 'muy bien', conf: -1, start: 3, end: 3.6 });
  const next = s.listenSession.state.live;
  assert.notEqual(next.id, first.id);
  assert.equal(next.translation, '', "the previous utterance's translation does not carry over");
});

test('Pause and resume while the speech check is pending open exactly one pair of transcribers', async () => {
  const s = session();
  const starting = s.listenSession.start();
  s.listenSession.pause();
  s.listenSession.resume();
  await starting;
  assert.equal(s.transcribers.length, 2);
  assert.equal(s.listenSession.state.message, '', 'no "starting · Starting…"');
});
