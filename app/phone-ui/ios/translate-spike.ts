// The Translate Tests page's fixtures and pure helpers (translate-tests-page.ts runs them).
// No NativeScript imports, so tests/translate-spike.test.cjs loads this file as is.

/** Languages T1 checks into English (and English into Spanish), as BCP 47 ids Translation takes. */
export const SOURCE_LANGUAGES = ['es', 'fr', 'de', 'it', 'pt', 'ja', 'zh-Hans', 'ko', 'ar', 'hi', 'ru'] as const
export const PAIRS: readonly string[] = [...SOURCE_LANGUAGES.map(lang => `${lang}>en`), 'en>es']

/** Ten short caption-like lines per source language (T3, T4). */
export const CAPTION_LINES: Readonly<Record<string, readonly string[]>> = {
  es: ['Hola, ¿cómo estás?', 'Llegamos en diez minutos.', '¿Dónde está la estación?', 'No entiendo lo que dices.', 'Me gustaría un café, por favor.',
    'Hace mucho frío hoy.', '¿Cuánto cuesta esto?', 'Mañana tengo una reunión temprano.', 'Gracias por tu ayuda.', 'Vamos a comer algo.'],
  fr: ['Bonjour, comment ça va ?', 'On arrive dans dix minutes.', 'Où est la gare ?', 'Je ne comprends pas ce que tu dis.', "Je voudrais un café, s'il vous plaît.",
    "Il fait très froid aujourd'hui.", 'Combien ça coûte ?', "J'ai une réunion tôt demain.", 'Merci pour ton aide.', 'Allons manger quelque chose.'],
  de: ["Hallo, wie geht's?", 'Wir sind in zehn Minuten da.', 'Wo ist der Bahnhof?', 'Ich verstehe nicht, was du sagst.', 'Ich hätte gern einen Kaffee, bitte.',
    'Heute ist es sehr kalt.', 'Wie viel kostet das?', 'Ich habe morgen früh ein Meeting.', 'Danke für deine Hilfe.', 'Lass uns etwas essen gehen.'],
  it: ['Ciao, come stai?', 'Arriviamo tra dieci minuti.', "Dov'è la stazione?", 'Non capisco cosa dici.', 'Vorrei un caffè, per favore.',
    'Oggi fa molto freddo.', 'Quanto costa?', 'Domani ho una riunione presto.', "Grazie per l'aiuto.", 'Andiamo a mangiare qualcosa.'],
  pt: ['Olá, tudo bem?', 'Chegamos em dez minutos.', 'Onde fica a estação?', 'Não entendo o que você diz.', 'Queria um café, por favor.',
    'Hoje está muito frio.', 'Quanto custa isto?', 'Amanhã tenho uma reunião cedo.', 'Obrigado pela ajuda.', 'Vamos comer alguma coisa.'],
  ja: ['こんにちは、元気ですか？', 'あと十分で着きます。', '駅はどこですか？', '何を言っているのか分かりません。', 'コーヒーをお願いします。',
    '今日はとても寒いです。', 'これはいくらですか？', '明日は朝早く会議があります。', '手伝ってくれてありがとう。', '何か食べに行きましょう。'],
  'zh-Hans': ['你好，最近怎么样？', '我们十分钟后到。', '火车站在哪里？', '我听不懂你在说什么。', '请给我一杯咖啡。',
    '今天很冷。', '这个多少钱？', '我明天一早有个会。', '谢谢你的帮助。', '我们去吃点东西吧。'],
  ko: ['안녕하세요, 잘 지내세요?', '십 분 후에 도착해요.', '역이 어디예요?', '무슨 말인지 모르겠어요.', '커피 한 잔 주세요.',
    '오늘 정말 추워요.', '이거 얼마예요?', '내일 아침 일찍 회의가 있어요.', '도와줘서 고마워요.', '뭐 좀 먹으러 가요.'],
  ar: ['مرحبا، كيف حالك؟', 'سنصل بعد عشر دقائق.', 'أين المحطة؟', 'لا أفهم ما تقول.', 'أريد قهوة من فضلك.',
    'الجو بارد جدا اليوم.', 'كم سعر هذا؟', 'عندي اجتماع مبكر غدا.', 'شكرا على مساعدتك.', 'لنذهب لنأكل شيئا.'],
  hi: ['नमस्ते, आप कैसे हैं?', 'हम दस मिनट में पहुँचेंगे।', 'स्टेशन कहाँ है?', 'मुझे समझ नहीं आया आप क्या कह रहे हैं।', 'एक कॉफ़ी दीजिए, प्लीज़।',
    'आज बहुत ठंड है।', 'यह कितने का है?', 'कल सुबह मेरी जल्दी मीटिंग है।', 'मदद के लिए धन्यवाद।', 'चलो कुछ खाने चलते हैं।'],
  ru: ['Привет, как дела?', 'Мы будем через десять минут.', 'Где вокзал?', 'Я не понимаю, что ты говоришь.', 'Мне кофе, пожалуйста.',
    'Сегодня очень холодно.', 'Сколько это стоит?', 'Завтра у меня рано встреча.', 'Спасибо за помощь.', 'Пойдём что-нибудь поедим.'],
  en: ['Hi, how are you doing?', "We'll be there in ten minutes.", 'Where is the train station?', "I don't understand what you're saying.", "I'd like a coffee, please.",
    "It's really cold today.", 'How much does this cost?', 'I have an early meeting tomorrow.', 'Thanks for your help.', "Let's go grab something to eat."],
}

export type LidCase = { text: string; expect: string; kind: 'medium' | 'short' }

/** T5: one medium line per language, then 1-3 word lines of the kind speech recognition emits. */
export const LID_CASES: readonly LidCase[] = [
  ...Object.entries(CAPTION_LINES).map(([expect, lines]) => ({ text: lines[7]!, expect, kind: 'medium' as const })),
  ...([
    ['Hola', 'es'], ['Sí, claro', 'es'], ['mmm vale', 'es'], ['Merci', 'fr'], ['bon ben', 'fr'], ['Danke schön', 'de'], ['ja genau', 'de'],
    ['Ciao', 'it'], ['Obrigado', 'pt'], ['はい', 'ja'], ['そうですね', 'ja'], ['谢谢', 'zh-Hans'], ['对对对', 'zh-Hans'], ['네', 'ko'],
    ['شكرا', 'ar'], ['हाँ', 'hi'], ['Да', 'ru'], ['uh huh okay', 'en'],
  ] as const).map(([text, expect]) => ({ text, expect, kind: 'short' as const })),
]

/** T7: one line per script, drawn in each glasses font. */
export const FONT_SAMPLES: readonly { label: string; text: string }[] = [
  { label: 'zh', text: '你好，世界！中文字幕测试。' },
  { label: 'ja', text: 'こんにちは、日本語の字幕テスト。' },
  { label: 'ko', text: '안녕하세요, 한국어 자막 테스트.' },
  { label: 'Latin', text: 'Ça va? Ñandú, Größe, São Paulo, łódź' },
  { label: 'Cyrillic', text: 'Привет, мир! Съешь ещё булок.' },
  { label: 'Arabic', text: 'مرحبا بالعالم' },
]

/** T7: a caption-length translated line, wrapped the way the captions layer wraps (on spaces). */
export const WRAP_SAMPLE = { label: 'zh caption', text: '我们明天早上九点在火车站门口见面，然后一起坐地铁去博物馆参观新的摄影展览，中午在附近吃饭。' }

/** One JSON line of Documents/translate-spike.jsonl. */
export function spikeLine(test: string, step: string, ok: boolean, ms: number, detail: unknown, at = new Date()): string {
  return JSON.stringify({ ts: at.toISOString(), test, step, ok, ms: Math.round(ms), detail: detail ?? null })
}

/** Lower-cased language id ("zh-hans"), so "zh-Hans" and "zh-hans" score the same. */
const norm = (lang: string | null | undefined) => String(lang ?? '').toLowerCase()

export type LidResult = LidCase & { got: string | null }

/** T5's accuracy, overall and per kind, with the misses. */
export function scoreLanguageId(results: readonly LidResult[]) {
  const tally = (list: readonly LidResult[]) => {
    const correct = list.filter(r => norm(r.got) === norm(r.expect)).length
    return { correct, total: list.length, accuracy: list.length ? correct / list.length : 0 }
  }
  return {
    ...tally(results),
    medium: tally(results.filter(r => r.kind === 'medium')),
    short: tally(results.filter(r => r.kind === 'short')),
    misses: results.filter(r => norm(r.got) !== norm(r.expect)).map(r => `${r.text} → ${r.got ?? 'none'} (want ${r.expect})`),
  }
}

/** Codepoints of text (whitespace aside) the font has no glyph for. */
export function missingGlyphs(hasGlyph: (codePoint: number) => boolean, text: string): number[] {
  const missing: number[] = []
  for (const char of text) {
    const cp = char.codePointAt(0)!
    if (!/\s/.test(char) && !hasGlyph(cp) && !missing.includes(cp)) missing.push(cp)
  }
  return missing
}

/** For each language, whether a locale id of it ("ja_JP", "zh-Hans_CN") is in each list. */
export function localeCoverage(lists: Record<string, readonly string[]>, langs: readonly string[]): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {}
  for (const lang of langs) {
    out[lang] = {}
    for (const [name, list] of Object.entries(lists)) {
      out[lang][name] = list.map(norm).some(id => id === lang || id.startsWith(`${lang}-`) || id.startsWith(`${lang}_`))
    }
  }
  return out
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** The pair after `pair` in PAIRS (the page's pair row cycles). */
export function nextPair(pair: string): string {
  return PAIRS[(PAIRS.indexOf(pair) + 1) % PAIRS.length]!
}
