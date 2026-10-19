/**
 * Listen's direction picker. Two SpeechTranscribers (one per language of the pair) hear the same audio, so every
 * utterance arrives as finals from both, with different text. Overlapping finals are grouped into clusters; each
 * language is scored on its own text (transcription confidence + language ID) and one wins per cluster, with
 * hysteresis so a stray "sí" in an English conversation does not flip the direction.
 * Pure (no NativeScript imports) so it runs under plain node for the tests.
 */
import { LETTER_CLASS, NUMBER_CLASS } from '../../util/unicode-class'

/** One transcriber final. Times are audio seconds from the first sample; conf 0..1, -1 unknown. */
export interface SpeechFinal { text: string; conf: number; start: number; end: number }
/** Probabilities for the pair's two languages (may be empty). */
export type LanguageScorer = (text: string) => Record<string, number>
export interface Decision { lang: string; text: string; start: number; end: number; scores: Record<string, number>; switched: boolean; words: number }

/** Finals closer than this (seconds) belong to the same utterance. */
const PAD = 0.25
const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]/g // BMP only, so no /u
/** Languages written without spaces between words: finals join with ''. */
const UNSPACED = /^(ja|zh)\b/i

type WordSegmenter = { segment(text: string): Iterable<{ isWordLike?: boolean }> }
type SegmenterCtor = new (lang: string, opts: { granularity: 'word' }) => WordSegmenter
const segmenters = new Map<string, WordSegmenter | null>()

/** Intl.Segmenter for `lang`, or null where the runtime has none (or rejects the locale). */
function segmenter(lang: string): WordSegmenter | null {
  if (!segmenters.has(lang)) {
    const Ctor = typeof Intl === 'undefined' ? undefined : (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter
    let seg: WordSegmenter | null = null
    try { seg = Ctor ? new Ctor(lang, { granularity: 'word' }) : null } catch { seg = null }
    segmenters.set(lang, seg)
  }
  return segmenters.get(lang)!
}

// Not `\p{L}`: Android's ICU-less V8 cannot parse it (unicode-class.ts).
const WORDISH = new RegExp(`[${LETTER_CLASS}${NUMBER_CLASS}]`)
const spacedWords = (text: string) => text.split(/\s+/).filter(w => WORDISH.test(w)).length

/** Words in `text`: Intl.Segmenter when available; otherwise ja/zh count ~2 CJK characters a word, the rest (Korean included) splits on whitespace. */
export function countWords(text: string, lang: string): number {
  const seg = segmenter(lang)
  if (seg) {
    let n = 0
    for (const s of seg.segment(text)) if (s.isWordLike) n++
    return n
  }
  if (UNSPACED.test(lang)) return Math.ceil((text.match(CJK)?.length ?? 0) / 2) + spacedWords(text.replace(CJK, ' '))
  return spacedWords(text)
}

interface Pending { lang: string; text: string; conf: number; start: number; end: number; at: number; seq: number }
interface Side { lang: string; text: string; words: number; score: number; start: number; end: number }

export class DirectionPicker {
  private readonly langs: [string, string]
  private readonly scorer: LanguageScorer
  private readonly waitMs: number
  private readonly minWords: number
  private readonly margin: number
  private readonly now: () => number
  private cur: string
  /** The other language led the previous cluster (with >= 2 words): a second lead in a row switches. */
  private streak: string | null = null
  private pending: Pending[] = []
  /** Per language: end of its latest final, +Infinity once it ended. */
  private readonly mark: Record<string, number>
  private seq = 0

  constructor(opts: { langs: [string, string]; initial: string; scorer: LanguageScorer; waitMs?: number; minWords?: number; margin?: number; now?: () => number }) {
    const [a, b] = opts.langs
    if (a === b || (opts.initial !== a && opts.initial !== b)) throw new Error(`DirectionPicker: bad pair ${a}/${b} (initial ${opts.initial})`)
    this.langs = [a, b]
    this.cur = opts.initial
    this.scorer = opts.scorer
    this.waitMs = opts.waitMs ?? 1500
    this.minWords = opts.minWords ?? 4
    this.margin = opts.margin ?? 0.15
    this.now = opts.now ?? Date.now
    this.mark = { [a]: -Infinity, [b]: -Infinity }
  }

  get current(): string { return this.cur }

  /** A transcriber final; returns the clusters that became decidable. Unknown languages are ignored. */
  pushFinal(lang: string, f: SpeechFinal): Decision[] {
    if (!(lang in this.mark)) return []
    // Native times should always be finite; if not, pin the final to this language's watermark rather than poison it.
    const fallback = Number.isFinite(this.mark[lang]) ? this.mark[lang]! : 0
    const start = Number.isFinite(f.start) ? f.start : Number.isFinite(f.end) ? f.end : fallback
    const end = Number.isFinite(f.end) ? Math.max(f.end, start) : start
    if (end > this.mark[lang]!) this.mark[lang] = end
    const text = String(f.text ?? '').trim()
    if (text) this.pending.push({ lang, text, conf: f.conf, start, end, at: this.now(), seq: this.seq++ })
    return this.drain(false)
  }

  /** Called ~every 250 ms: emits clusters whose first final has waited longer than waitMs. */
  tick(): Decision[] { return this.drain(false) }

  /** That transcriber is done: nothing more will arrive from it. */
  ended(lang: string): Decision[] {
    if (lang in this.mark) this.mark[lang] = Infinity
    return this.drain(false)
  }

  /** Stop: emit everything pending. */
  flush(): Decision[] { return this.drain(true) }

  private drain(all: boolean): Decision[] {
    const clusters = this.clusters()
    const t = this.now()
    // Emit through the last decidable cluster so decisions stay in time order even when a later one times out first.
    let last = all ? clusters.length - 1 : -1
    if (!all) clusters.forEach((c, i) => { if (this.decidable(c, t)) last = i })
    if (last < 0) return []
    const emit = clusters.slice(0, last + 1)
    const used = new Set(emit.flat())
    this.pending = this.pending.filter(p => !used.has(p))
    return emit.map(c => this.decide(c))
  }

  /** Pending finals in time order, grouped transitively by overlap (PAD apart). */
  private clusters(): Pending[][] {
    const sorted = [...this.pending].sort((x, y) => x.start - y.start || x.end - y.end || x.seq - y.seq)
    const out: Pending[][] = []
    let end = -Infinity
    for (const p of sorted) {
      if (out.length && p.start <= end + PAD) { out[out.length - 1]!.push(p); end = Math.max(end, p.end) }
      else { out.push([p]); end = p.end }
    }
    return out
  }

  /** Every transcriber has reached the cluster's end (within PAD: their word boundaries differ slightly), or it timed out. */
  private decidable(c: Pending[], t: number): boolean {
    return this.langs.every(l => this.caughtUp(c, l)) || t - Math.min(...c.map(p => p.at)) > this.waitMs
  }

  /** `lang` has heard the cluster: its watermark is within PAD of the end and inside the cluster (an earlier utterance's mark does not count). */
  private caughtUp(c: Pending[], lang: string): boolean {
    return this.mark[lang]! >= Math.max(Math.max(...c.map(p => p.end)) - PAD, Math.min(...c.map(p => p.start)))
  }

  private decide(c: Pending[]): Decision {
    const C = this.cur
    const O = C === this.langs[0] ? this.langs[1] : this.langs[0]
    const sc = this.side(c, C)
    const so = this.side(c, O)
    const lead = so.score - sc.score
    const leads = lead > 0 && so.words >= 2
    // C silent only because it lags (timeout path): its absence is no evidence, so only a streak can switch.
    const lagging = !sc.text && !this.caughtUp(c, C)
    const switched = (!lagging && so.words >= this.minWords && lead >= this.margin - 1e-9) || (this.streak === O && leads)
    this.streak = !switched && leads ? O : null
    if (switched) this.cur = O
    // Not switching, but the current language heard nothing: show the other one's text, in its language.
    const pick = switched || !sc.text ? so : sc
    return { lang: pick.lang, text: pick.text, start: pick.start, end: pick.end, scores: { [C]: sc.score, [O]: so.score }, switched, words: pick.words }
  }

  /** One language's text and score in a cluster: 0.5 * word-weighted confidence + 0.5 * language ID; 0 when it has no final. */
  private side(c: Pending[], lang: string): Side {
    const finals = c.filter(p => p.lang === lang)
    if (!finals.length) return { lang, text: '', words: 0, score: 0, start: NaN, end: NaN }
    const text = finals.map(f => f.text).join(UNSPACED.test(lang) ? '' : ' ')
    let weight = 0
    let sum = 0
    for (const f of finals) {
      const n = Math.max(1, countWords(f.text, lang))
      weight += n
      sum += n * (f.conf >= 0 && f.conf <= 1 ? f.conf : 0.5)
    }
    let nl = 0.5
    try {
      const v = this.scorer(text)[lang]
      if (typeof v === 'number' && Number.isFinite(v)) nl = v
    } catch { /* language ID unavailable: neutral */ }
    return { lang, text, words: countWords(text, lang), score: 0.5 * (sum / weight) + 0.5 * nl, start: finals[0]!.start, end: Math.max(...finals.map(f => f.end)) }
  }
}
