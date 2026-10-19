// Listen's DirectionPicker (app/apps/translate/direction.ts): clustering the two transcribers' finals, scoring,
// hysteresis, the watermark/timeout/ended/flush release paths, and word counting with and without Intl.Segmenter.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const direction = loader()('app/apps/translate/direction.ts');
const noSegmenter = loader({ Intl: undefined })('app/apps/translate/direction.ts');

// Language ID stand-in: the share of known Spanish vs English words (empty when it knows none, like a short line).
const ES = new Set('hola cómo estás hoy amigo quiero un café por favor sí claro vale gracias muy bien la mesa'.split(' '));
const EN = new Set('hello how are you today friend i would like a coffee please yes of course okay sure thanks very good the table see'.split(' '));
function scorer(text) {
  const words = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  const es = words.filter(w => ES.has(w)).length;
  const en = words.filter(w => EN.has(w)).length;
  return es + en ? { es: es / (es + en), en: en / (es + en) } : {};
}

function picker(opts = {}) {
  const clock = { t: 0 };
  const p = new direction.DirectionPicker({ langs: ['es', 'en'], initial: 'es', scorer, waitMs: 1500, now: () => clock.t, ...opts });
  return { p, clock };
}
const fin = (text, start, end, conf = 0.9) => ({ text, conf, start, end });
const plain = value => JSON.parse(JSON.stringify(value));
// Results come from the module's vm realm, so compare them as plain JSON.
const eq = (actual, expected, message) => assert.deepEqual(plain(actual), expected, message);

test('a clean utterance in the current language is decided once both transcribers pass it', () => {
  const { p } = picker();
  eq(p.pushFinal('es', fin('hola cómo estás hoy amigo', 0, 2)), [], 'en has not reached the end yet');
  const [d, ...rest] = p.pushFinal('en', fin('Ola commo estas oi amigo', 0.1, 2.1, 0.4));
  eq(rest, []);
  assert.equal(d.lang, 'es');
  assert.equal(d.text, 'hola cómo estás hoy amigo');
  eq([d.start, d.end, d.words, d.switched], [0, 2, 5, false]);
  assert.ok(d.scores.es > d.scores.en, JSON.stringify(d.scores));
  assert.equal(p.current, 'es');
  // Within the pad counts as caught up; further behind waits for that transcriber.
  eq(p.pushFinal('es', fin('muy bien', 3, 4)), []);
  eq(p.pushFinal('en', fin('mui', 3, 3.7, 0.4)), [], '0.3 s short of the end');
  eq(p.pushFinal('en', fin('bien', 3.8, 4.2, 0.4)).map(d => d.text), ['muy bien']);
});

test('a 4+ word utterance in the other language with a clear lead switches at once', () => {
  const { p } = picker();
  p.pushFinal('es', fin('hola cómo estás hoy amigo', 0, 2));
  p.pushFinal('en', fin('Ola commo estas oi amigo', 0, 2, 0.4));
  p.pushFinal('en', fin('I would like a coffee please', 3, 5));
  const [d] = p.pushFinal('es', fin('ay wud laic a cofi plis', 3, 5, 0.3));
  eq([d.lang, d.text, d.switched, d.words], ['en', 'I would like a coffee please', true, 6]);
  assert.equal(p.current, 'en');
  // The new current language keeps winning without a further switch.
  p.pushFinal('en', fin('thanks very good', 6, 7));
  const [next] = p.pushFinal('es', fin('tanks beri gud', 6, 7, 0.3));
  eq([next.lang, next.switched], ['en', false]);
});

test('a lead below the margin does not switch, even with enough words', () => {
  const { p } = picker({ scorer: () => ({}) });
  p.pushFinal('es', fin('uno dos tres cuatro', 0, 2, 0.5));
  const [d] = p.pushFinal('en', fin('one two three four', 0, 2, 0.7)); // lead 0.1 < 0.15
  eq([d.lang, d.switched, p.current], ['es', false, 'es']);
  assert.equal(d.scores.en - d.scores.es > 0, true);
});

test('a short "sí" in an English conversation does not switch', () => {
  const { p } = picker({ initial: 'en' });
  p.pushFinal('es', fin('sí', 0, 0.4, 0.95));
  const [d] = p.pushFinal('en', fin('see', 0, 0.4, 0.3));
  assert.ok(d.scores.es > d.scores.en, 'Spanish scored higher');
  eq([d.lang, d.text, d.switched, p.current], ['en', 'see', false, 'en']);
  // A run of one-word wins never builds a streak either.
  p.pushFinal('es', fin('vale', 1, 1.4, 0.95));
  const [again] = p.pushFinal('en', fin('valley', 1, 1.4, 0.3));
  eq([again.lang, again.switched, p.current], ['en', false, 'en']);
});

test('two short wins in a row for the other language switch', () => {
  const { p } = picker();
  p.pushFinal('en', fin('yes of course', 0, 1));
  const [first] = p.pushFinal('es', fin('jes off cors', 0, 1, 0.3));
  eq([first.lang, first.switched, p.current], ['es', false, 'es'], '3 words: not yet');
  p.pushFinal('en', fin('okay sure', 2, 3));
  const [second] = p.pushFinal('es', fin('oquei shur', 2, 3, 0.3));
  eq([second.lang, second.text, second.switched, p.current], ['en', 'okay sure', true, 'en']);
});

test('a win for the current language in between breaks the streak', () => {
  const { p } = picker();
  p.pushFinal('en', fin('yes of course', 0, 1));
  p.pushFinal('es', fin('jes off cors', 0, 1, 0.3));
  p.pushFinal('es', fin('muy bien gracias', 2, 3));
  const [mid] = p.pushFinal('en', fin('mui bien gracias', 2, 3, 0.3));
  assert.equal(mid.lang, 'es');
  p.pushFinal('en', fin('okay sure', 4, 5));
  const [last] = p.pushFinal('es', fin('oquei shur', 4, 5, 0.3));
  eq([last.lang, last.switched, p.current], ['es', false, 'es']);
});

test('only one transcriber produced a final: released by the timeout; a silent lagging one switches on the second', () => {
  const { p, clock } = picker();
  eq(p.pushFinal('en', fin('I would like a coffee', 0, 2)), []);
  clock.t = 1500;
  eq(p.tick(), [], 'waits strictly longer than waitMs');
  clock.t = 1501;
  const [d] = p.tick();
  eq([d.lang, d.switched, d.scores.es, p.current], ['en', false, 0, 'es'], 'es never reached it: absence is no evidence');
  eq(p.tick(), []);
  p.pushFinal('en', fin('thanks very good', 3, 4));
  clock.t = 3100;
  const [again] = p.tick();
  eq([again.lang, again.switched, p.current], ['en', true, 'en']);
  // When the current one has heard the cluster (an empty final) and said nothing, a long lead switches at once.
  const { p: q } = picker();
  q.pushFinal('es', fin('', 0, 2.2));
  eq(q.pushFinal('en', fin('I would like a coffee', 0, 2)).map(d => [d.lang, d.switched]), [['en', true]]);
});

test('a current transcriber that lags past the timeout does not flip the direction there and back', () => {
  const { p, clock } = picker();
  p.pushFinal('en', fin('Ola como estas oi amigo', 0, 2, 0.6));
  clock.t = 1600;
  const [early] = p.tick();
  eq([early.lang, early.switched, p.current], ['en', false, 'es']);
  const [late] = p.pushFinal('es', fin('hola cómo estás hoy amigo', 0, 2));
  eq([late.lang, late.switched, p.current], ['es', false, 'es']);
});

test("a short reply is not decided on the other transcriber's watermark from the previous utterance", () => {
  const { p } = picker({ initial: 'en' });
  p.pushFinal('en', fin('thanks very good', 0, 2.2));
  p.pushFinal('es', fin('tanks beri gud', 0, 2.2, 0.3));
  eq(p.pushFinal('es', fin('sí', 2.3, 2.45, 0.95)), [], 'en has not heard 2.3 s yet');
  const out = p.pushFinal('en', fin('see', 2.3, 2.5, 0.3));
  eq(out.map(d => [d.lang, d.text]), [['en', 'see']], 'one decision for the utterance');
});

test('only one transcriber produced a short final: its text is used without switching', () => {
  const { p, clock } = picker();
  p.pushFinal('en', fin('okay', 0, 0.5));
  clock.t = 2000;
  const [d] = p.tick();
  eq([d.lang, d.text, d.switched, p.current], ['en', 'okay', false, 'es']);
});

test('the watermark: an utterance waits for the slower transcriber, then each is released in order', () => {
  const { p } = picker();
  eq(p.pushFinal('en', fin('hello friend', 0, 1, 0.3)), []);
  eq(p.pushFinal('en', fin('the table', 2, 3, 0.3)), []);
  const first = p.pushFinal('es', fin('hola amigo', 0, 1.1));
  eq(first.map(d => d.text), ['hola amigo'], 'the second utterance still waits for es');
  const second = p.pushFinal('es', fin('la mesa', 2, 3));
  eq(second.map(d => d.text), ['la mesa']);
});

test('out-of-order arrival across transcribers still pairs the right finals', () => {
  const { p } = picker();
  for (const [s, text] of [[0, 'hola amigo'], [2, 'la mesa'], [4, 'muy bien']]) eq(p.pushFinal('es', fin(text, s, s + 1)), []);
  eq(p.pushFinal('en', fin('ola amigo', 0, 1, 0.3)).map(d => d.text), ['hola amigo']);
  const rest = p.pushFinal('en', fin('mui bien', 4, 5, 0.3)); // en skipped utterance 2 (heard nothing)
  eq(rest.map(d => [d.text, d.start]), [['la mesa', 2], ['muy bien', 4]], 'time order');
});

test('decisions stay in time order when a later cluster times out first', () => {
  const { p, clock } = picker();
  p.pushFinal('es', fin('muy bien', 5, 7));
  clock.t = 1000;
  p.pushFinal('es', fin('hola amigo', 0, 2));
  clock.t = 1600; // only the 5-7 s cluster has waited > 1500 ms
  eq(p.tick().map(d => d.start), [0, 5]);
});

test('finals of one language that overlap (with padding) join one cluster in time order', () => {
  const { p } = picker();
  p.pushFinal('es', fin('cómo estás', 1.2, 2));
  p.pushFinal('es', fin('hola', 0, 1)); // 0.2 s gap < 0.25 s pad
  const [d, ...rest] = p.pushFinal('en', fin('ola commo estas', 0, 2, 0.4));
  eq(rest, []);
  eq([d.text, d.start, d.end], ['hola cómo estás', 0, 2]);
  // A gap wider than the pad is a separate utterance.
  const { p: q } = picker();
  q.pushFinal('es', fin('hola', 0, 1));
  q.pushFinal('es', fin('cómo estás', 1.3, 2));
  assert.equal(q.ended('en').length, 2);
});

test('Japanese finals join without spaces', () => {
  const p = new direction.DirectionPicker({ langs: ['ja', 'en'], initial: 'ja', scorer: () => ({}) });
  p.pushFinal('ja', fin('こんにちは', 0, 1));
  p.pushFinal('ja', fin('元気ですか', 1.1, 2));
  const [d] = p.ended('en');
  assert.equal(d.text, 'こんにちは元気ですか');
});

test('ended() releases what was waiting for that transcriber', () => {
  const { p } = picker();
  eq(p.pushFinal('es', fin('hola amigo', 0, 1)), []);
  const [d] = p.ended('en');
  eq([d.lang, d.text], ['es', 'hola amigo']);
  // Afterwards the remaining transcriber decides alone, immediately.
  assert.equal(p.pushFinal('es', fin('la mesa', 2, 3)).length, 1);
  eq(p.ended('fr'), [], 'unknown language ignored');
});

test('flush() emits everything pending, once', () => {
  const { p } = picker();
  p.pushFinal('es', fin('hola amigo', 0, 1));
  p.pushFinal('en', fin('ola amigo', 0, 1, 0.3)); // decided now
  p.pushFinal('es', fin('la mesa', 2, 3));
  p.pushFinal('es', fin('muy bien', 5, 6));
  eq(p.flush().map(d => d.text), ['la mesa', 'muy bien']);
  eq(p.flush(), []);
  eq(p.tick(), []);
});

test('nothing is emitted twice across a long interleaved stream', () => {
  const { p, clock } = picker();
  const out = [];
  const utterances = 30;
  const enQueue = [];
  for (let i = 0; i < utterances; i++) {
    const s = i * 2;
    const enLeads = Math.floor(i / 5) % 2 === 1; // five es utterances, five en, ...
    out.push(...p.pushFinal('es', fin(enLeads ? 'ai wud laic a cofi' : `hola amigo cómo estás ${i}`, s, s + 1.5, enLeads ? 0.3 : 0.9)));
    enQueue.push(fin(enLeads ? `I would like a coffee ${i}` : 'ola amigo commo estas', s + 0.1, s + 1.6, enLeads ? 0.9 : 0.3));
    if (i % 3 === 2) while (enQueue.length) out.push(...p.pushFinal('en', enQueue.shift())); // en lags, then bursts
    clock.t += 300;
    out.push(...p.tick());
  }
  while (enQueue.length) out.push(...p.pushFinal('en', enQueue.shift()));
  out.push(...p.flush());
  assert.equal(out.length, utterances, 'one decision per utterance');
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start > out[i - 1].end, `time order at ${i}`);
  assert.equal(new Set(out.map(d => d.start)).size, utterances);
  const langs = out.map(d => d.lang).join('');
  assert.ok(langs.includes('en') && langs.startsWith('es'), langs);
  assert.equal(out.filter(d => d.switched).length >= 2, true, 'switched there and back');
});

test('unknown confidence and missing or broken language ID score neutral', () => {
  const p = new direction.DirectionPicker({ langs: ['es', 'en'], initial: 'es', scorer: () => ({}) });
  p.pushFinal('es', fin('hola amigo', 0, 1, -1));
  const [d] = p.pushFinal('en', fin('ola amigo', 0, 1, -1));
  eq(d.scores, { es: 0.5, en: 0.5 });
  const q = new direction.DirectionPicker({ langs: ['es', 'en'], initial: 'es', scorer: () => { throw new Error('native gone'); } });
  q.pushFinal('es', fin('hola', 0, 1, 1));
  eq(plain(q.ended('en')[0].scores), { es: 0.75, en: 0 });
  // Confidence is word-weighted across a language's finals.
  const r = new direction.DirectionPicker({ langs: ['es', 'en'], initial: 'es', scorer: () => ({ es: 0.5 }) });
  r.pushFinal('es', fin('uno dos tres', 0, 1, 1));
  r.pushFinal('es', fin('cuatro', 1.1, 2, 0));
  assert.equal(r.ended('en')[0].scores.es, 0.5 * 0.75 + 0.25);
});

test('empty finals advance the watermark but are never emitted; bad times do not poison it', () => {
  const { p } = picker();
  p.pushFinal('es', fin('hola amigo', 0, 1));
  const [d] = p.pushFinal('en', fin('   ', 0, 1.2));
  eq([d.text, d.lang], ['hola amigo', 'es']);
  eq(p.pushFinal('en', fin('hello', NaN, NaN)), [], 'pinned to the en watermark (1.2): waits for es (1.0)');
  eq(p.pushFinal('es', fin('hola', 3, 4)).map(d => [d.text, d.start, d.end]), [['hello', 1.2, 1.2]], 'es passed it; hola waits for en');
  eq(p.pushFinal('en', fin('ola', 3, 4, 0.3)).map(d => d.text), ['hola']);
  eq(p.pushFinal('fr', fin('bonjour', 0, 1)), [], 'unknown language ignored');
});

test('the constructor rejects a pair of one language or an initial outside the pair', () => {
  assert.throws(() => new direction.DirectionPicker({ langs: ['en', 'en'], initial: 'en', scorer }), /bad pair/);
  assert.throws(() => new direction.DirectionPicker({ langs: ['es', 'en'], initial: 'fr', scorer }), /bad pair/);
  assert.equal(new direction.DirectionPicker({ langs: ['es', 'en'], initial: 'en', scorer }).current, 'en');
});

test('word counting: Latin by whitespace, CJK by Intl.Segmenter or ~2 characters a word', () => {
  for (const mod of [direction, noSegmenter]) {
    assert.equal(mod.countWords('Sí, claro — vale.', 'es'), 3);
    assert.equal(mod.countWords('  ', 'en'), 0);
    assert.equal(mod.countWords('谢谢', 'zh-Hans'), 1);
    assert.equal(mod.countWords('はい', 'ja'), 1);
    assert.equal(mod.countWords('네', 'ko'), 1);
    assert.ok(mod.countWords('我们明天早上九点在火车站门口见面', 'zh-Hans') >= 8, 'a CJK sentence is enough words to switch');
    assert.ok(mod.countWords('こんにちは、日本語の字幕テスト。', 'ja') >= 4);
    assert.ok(mod.countWords('안녕하세요, 한국어 자막 테스트.', 'ko') >= 4);
  }
  assert.equal(direction.countWords('안녕하세요, 한국어 자막 테스트.', 'ko'), 4, 'Segmenter');
  assert.equal(noSegmenter.countWords('我们明天早上九点在火车站门口见面', 'zh-Hans'), 8, 'fallback: 16 Han / 2');
  assert.equal(noSegmenter.countWords('iPhone 15 很好用', 'zh-Hans'), 4, 'fallback: spaced words plus Han pairs');
  assert.equal(noSegmenter.countWords('안녕하세요 감사합니다', 'ko'), 2, 'fallback: Korean is spaced, not syllable pairs');
});

test('a long Chinese utterance switches a zh-Hans/en pair; "谢谢" alone does not', () => {
  const p = new direction.DirectionPicker({ langs: ['zh-Hans', 'en'], initial: 'en', scorer: t => /[一-鿿]/.test(t) ? { 'zh-Hans': 0.95, en: 0.05 } : { en: 0.6, 'zh-Hans': 0.4 } });
  p.pushFinal('zh-Hans', fin('谢谢', 0, 0.5));
  const [short] = p.pushFinal('en', fin('shit shit', 0, 0.5, 0.3));
  eq([short.lang, short.switched], ['en', false]);
  p.pushFinal('zh-Hans', fin('我们明天早上九点在火车站门口见面', 1, 4));
  const [long] = p.pushFinal('en', fin('women ming tian zao shang', 1, 4, 0.3));
  eq([long.lang, long.switched, p.current], ['zh-Hans', true, 'zh-Hans']);
});

test('finalized() releases a cluster at once: the silent transcriber heard the stretch', () => {
  const { p } = picker();
  // Spanish speech: only es produced text; en finalized through the pause with nothing.
  assert.equal(p.pushFinal('es', fin('hola cómo estás hoy amigo', 0.5, 2.0)).length, 0);
  const out = p.finalized('en', 2.2);
  assert.equal(out.length, 1);
  assert.equal(out[0].lang, 'es');
  assert.equal(out[0].switched, false);
});

test('finalized() alone (no text from either) decides nothing; ignores unknown languages and NaN', () => {
  const { p } = picker();
  assert.equal(p.finalized('en', 3).length, 0);
  assert.equal(p.finalized('fr', 3).length, 0);
  assert.equal(p.finalized('es', NaN).length, 0);
  assert.equal(p.pushFinal('es', fin('hola amigo', 3.5, 4)).length, 0);
  assert.equal(p.finalized('en', 4.2).length, 1);
});

test('the default backstop waits 4 s, not 1.5 s', () => {
  const clock = { t: 0 };
  const p = new direction.DirectionPicker({ langs: ['es', 'en'], initial: 'es', scorer, now: () => clock.t });
  p.pushFinal('es', fin('hola cómo estás hoy amigo', 0.5, 2.0));
  clock.t = 2000;
  assert.equal(p.tick().length, 0);
  clock.t = 4100;
  assert.equal(p.tick().length, 1);
});
