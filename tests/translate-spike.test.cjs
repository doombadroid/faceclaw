// The Translate Tests page's pure half: log line format, language-ID scoring, glyph coverage and
// the fixtures (app/phone-ui/ios/translate-spike.ts). The native calls are checked on the phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');

const spike = loader()('app/phone-ui/ios/translate-spike.ts');

test('a log line is one JSON object with ts, test, step, ok, ms and detail', () => {
  const at = new Date('2026-10-17T12:00:00.000Z');
  const line = spike.spikeLine('T3', 'es>en lowLatency', true, 12.6, { rows: [1] }, at);
  assert.ok(!line.includes('\n'), 'one line');
  assert.deepEqual(Object.keys(JSON.parse(line)), ['ts', 'test', 'step', 'ok', 'ms', 'detail']);
  assert.deepEqual(JSON.parse(line), { ts: '2026-10-17T12:00:00.000Z', test: 'T3', step: 'es>en lowLatency', ok: true, ms: 13, detail: { rows: [1] } });
  assert.equal(JSON.parse(spike.spikeLine('T1', 'device', false, 0, undefined, at)).detail, null);
  assert.equal(JSON.parse(spike.spikeLine('T5', 'case 0', true, 0, 'a\nb "quoted"', at)).detail, 'a\nb "quoted"');
});

test('language-ID scoring is case-insensitive, split by kind, and lists the misses', () => {
  const score = spike.scoreLanguageId([
    { text: 'Hola amigos', expect: 'es', kind: 'medium', got: 'es' },
    { text: '谢谢你', expect: 'zh-Hans', kind: 'medium', got: 'zh-hans' },
    { text: 'Ciao', expect: 'it', kind: 'short', got: 'pt' },
    { text: 'Da', expect: 'ru', kind: 'short', got: null },
  ]);
  assert.deepEqual([score.correct, score.total, score.accuracy], [2, 4, 0.5]);
  assert.deepEqual([score.medium.accuracy, score.short.accuracy], [1, 0]);
  assert.deepEqual([...score.misses], ['Ciao → pt (want it)', 'Da → none (want ru)']);
  assert.equal(spike.scoreLanguageId([]).accuracy, 0);
});

test('missing glyphs skip whitespace, count each codepoint once and handle astral ones', () => {
  const has = cp => cp < 0x80;
  assert.deepEqual([...spike.missingGlyphs(has, 'Ça ça\tok')], [0xc7, 0xe7]);
  assert.deepEqual([...spike.missingGlyphs(has, '你你 好')], [0x4f60, 0x597d]);
  assert.deepEqual([...spike.missingGlyphs(has, 'a😀b')], [0x1f600]);
  assert.deepEqual([...spike.missingGlyphs(() => true, '你好')], []);
});

test('locale coverage matches a language and its regional ids, not a longer code', () => {
  const coverage = spike.localeCoverage({ supported: ['ja_JP', 'zh-Hans_CN', 'ko-KR', 'jv_ID'], installed: ['en_US'] }, ['ja', 'zh', 'ko', 'jv', 'en', 'j']);
  assert.deepEqual(JSON.parse(JSON.stringify(coverage)), {
    ja: { supported: true, installed: false }, zh: { supported: true, installed: false }, ko: { supported: true, installed: false },
    jv: { supported: true, installed: false }, en: { supported: false, installed: true }, j: { supported: false, installed: false },
  });
});

test('median and the pair cycle', () => {
  assert.equal(spike.median([]), 0);
  assert.equal(spike.median([5, 1, 3]), 3);
  assert.equal(spike.median([4, 1, 3, 2]), 2.5);
  assert.equal(spike.nextPair('es>en'), 'fr>en');
  assert.equal(spike.nextPair('en>es'), 'es>en', 'wraps');
  let pair = 'es>en';
  for (let i = 0; i < spike.PAIRS.length; i++) pair = spike.nextPair(pair);
  assert.equal(pair, 'es>en');
});

test('fixtures: every pair has ten caption lines, about 30 language-ID cases, one font sample per script', () => {
  assert.deepEqual([...spike.PAIRS], ['es>en', 'fr>en', 'de>en', 'it>en', 'pt>en', 'ja>en', 'zh-Hans>en', 'ko>en', 'ar>en', 'hi>en', 'ru>en', 'en>es']);
  for (const pair of spike.PAIRS) {
    const lines = spike.CAPTION_LINES[pair.split('>')[0]];
    assert.equal(lines?.length, 10, pair);
    assert.equal(new Set(lines).size, 10, `${pair}: distinct`);
    for (const line of lines) assert.ok(line.length > 0 && line.length <= 40, `${pair}: caption-sized: ${line}`);
  }
  assert.ok(spike.LID_CASES.length >= 28 && spike.LID_CASES.length <= 32, String(spike.LID_CASES.length));
  const languages = new Set(Object.keys(spike.CAPTION_LINES));
  for (const item of spike.LID_CASES) assert.ok(languages.has(item.expect), item.expect);
  for (const item of spike.LID_CASES.filter(c => c.kind === 'short')) {
    assert.ok(item.text.split(/\s+/).length <= 3, `1-3 words: ${item.text}`);
  }
  assert.ok(spike.LID_CASES.filter(c => c.kind === 'short').length >= 15, 'mostly noisy short lines');
  assert.deepEqual([...spike.FONT_SAMPLES.map(s => s.label)], ['zh', 'ja', 'ko', 'Latin', 'Cyrillic', 'Arabic']);
});

test('the page is registered and reached from General, and every test is on it', () => {
  assert.match(fs.readFileSync('app/phone-ui/ios/register.ts', 'utf8'), /registerModule\('ocusmart\/translate-tests', \(\) => require\('\.\/translate-tests-page'\)\)/);
  assert.match(fs.readFileSync('app/phone-ui/ios/about-page.ts', 'utf8'), /nameTaps >= 5 \? \[navRow\(\{ title: 'Translate Tests', onTap: \(\) => page\.frame\?\.navigate\(\{ moduleName: 'ocusmart\/translate-tests' \}\)/);
  const page = fs.readFileSync('app/phone-ui/ios/translate-tests-page.ts', 'utf8');
  for (let i = 1; i <= 8; i++) {
    assert.ok(new RegExp(`\\['T${i} [^']+', \\(\\) => \\{ void (run|confirmThen)\\('T${i}', (?:'[^']*', )?T${i}\\) \\}\\]`).test(page), `T${i} has a button`);
  }
});

test('the page rebuilds and runs a test without re-parenting a view (build 44 left every button grey)', async () => {
  const { loader } = require('./helpers/load-typescript.cjs');
  // Views that, like NativeScript's, refuse a second parent.
  class View { constructor() { this.parent = null; this.children = []; }
    addChild(child) { if (child.parent) throw new Error('View already has a parent.'); child.parent = this; this.children.push(child); }
    removeChildren() { this.children = []; } }
  class Label extends View {}
  const rows = [];
  let refresh = () => {};
  const uiKit = {
    groupedPage: ({ build }) => { const container = new View(); refresh = () => { container.removeChildren(); build(container); }; refresh(); return { page: {}, refresh }; },
    section: ({ rows: list }) => { const box = new View(); for (const row of list) box.addChild(row.view); return box; },
    customRow: view => ({ view }), buttonRow: o => { rows.push(o); return { view: new View() }; },
    navRow: () => ({ view: new View() }), valueRow: () => ({ view: new View() }),
  };
  const lines = [];
  const file = { appendTextSync: line => lines.push(line), readTextSync: () => lines.join(''), writeTextSync: () => {}, path: '/x' };
  const errors = [];
  const load = loader({ UIDevice: { currentDevice: { systemVersion: '27.0', model: 'iPhone' } }, setTimeout, clearTimeout }, {
    '@nativescript/core': { Dialogs: {}, knownFolders: { documents: () => ({ getFile: () => file }) }, Label },
    './ui-kit': uiKit, './runtime': { getRuntime: () => ({}) }, './present': { presentOnTop() {} },
    '../../native/error-reports': { reportError: (where, error) => errors.push(`${where}: ${error}`) },
    '../../native/callback-errors.ios': { guardCallback: (_w, fn) => fn() }, '../../native/kotlin-listener.ios': {},
    '../../native/faceclaw-communicator.ios': {}, '../../graphics/image': {}, '../../graphics/bdffont': {}, '../../graphics/evenhub-font': {},
    '../../graphics/ui-fonts': {}, '../../ui/shell/shell': {}, '../../apps/microphones/captions-layer': { wrapWords() {} },
  });
  load('app/phone-ui/ios/translate-tests-page.ts').createPage();
  refresh(); refresh();
  const t5 = rows.find(o => o.title.startsWith('T5'));
  t5.onTap();
  await new Promise(resolve => setTimeout(resolve, 50));
  // NLLanguageRecognizer is native, so T5 itself fails here; the page must still run it, log it and unlock.
  assert.ok(!errors.some(error => /parent/.test(error)), errors.join('\n'));
  assert.ok(lines.some(line => line.includes('"test":"T5"') && line.includes('"step":"done"')), 'T5 ran and logged done');
  assert.ok(rows.filter(o => o.title.startsWith('T5')).at(-1).enabled, 'buttons enabled again after the run');
});
