import type { NavigationEntry, Page } from '@nativescript/core'
import { groupedPage, section, buttonRow, valueRow, type Row } from './ui-kit'
import { settingRows } from './settings-category-page'
import { getRuntime } from './runtime'
import { onAnySettingChanged } from '../../ui/dashboard-settings'
import type { CatalogItem } from '../../ui/dashboard/settings-catalog'
import { installSpeechLanguage, speechLanguageStatus, type SpeechLocaleStatus } from '../../native/live-transcriber'
import { prepareTranslation, translationStatus, type PackStatus } from '../../native/apple-translate'
import { languageName, translateMyLanguageSetting, translateTheirLanguageSetting } from '../../apps/translate/translate-settings'

/*
 * My Glasses > Translate: the language pair, what each language still needs on this iPhone,
 * and Download Missing. Apple's prepareTranslation() may finish its download without ever
 * calling back, so every step is followed by a fresh status check rather than trusted.
 */

type Packs = { lowLatency: PackStatus; highFidelity: PackStatus }
type Pair = [string, string]

/** While a translation download runs, how often its status is re-checked (it may never answer). */
const PREPARE_POLL_MS = 3_000

const pairKey = ([a, b]: Pair) => `${a}>${b}`

/** undefined: not checked yet; null: the check failed. */
export function speechLabel(status: SpeechLocaleStatus | null | undefined): string {
  if (status === undefined) return 'Checking…'
  if (!status) return 'Unknown'
  if (!status.supported) return 'Not supported'
  return status.installed ? 'Ready' : 'Download needed'
}

export function packLabel(packs: Packs | null | undefined): string {
  if (packs === undefined) return 'Checking…'
  if (!packs) return 'Unknown'
  if (packs.lowLatency === 'installed') return 'Fast (offline)'
  if (packs.highFidelity === 'installed') return 'Apple Intelligence'
  if (packs.lowLatency === 'supported' || packs.highFidelity === 'supported') return 'Download needed'
  if (packs.lowLatency === 'unknown' && packs.highFidelity === 'unknown') return 'Unknown'
  return 'Not supported'
}

const pairOf = (): Pair => [translateTheirLanguageSetting.get(), translateMyLanguageSetting.get()]
const directionsOf = ([their, mine]: Pair): Pair[] => their === mine ? [] : [[their, mine], [mine, their]]

export function createPage(): Page {
  const speech = new Map<string, SpeechLocaleStatus | null>()
  const packs = new Map<string, Packs | null>()
  let checking = 0, progress = '', problems: string[] = [], shownPair = ''

  /** Fresh statuses for the current pair; a newer check supersedes an older one. */
  const check = async (): Promise<void> => {
    const generation = ++checking, pair = pairOf()
    const [speechResults, packResults] = await Promise.all([
      Promise.all(pair.map(lang => speechLanguageStatus(lang).catch(() => null))),
      Promise.all(directionsOf(pair).map(([a, b]) => translationStatus(a, b).catch(() => null))),
    ])
    if (generation !== checking) return
    pair.forEach((lang, i) => speech.set(lang, speechResults[i] ?? null))
    directionsOf(pair).forEach((direction, i) => packs.set(pairKey(direction), packResults[i] ?? null))
    refresh()
  }

  const missingSpeech = () => [...new Set(pairOf())].filter(lang => { const s = speech.get(lang); return s?.supported && !s.installed })
  const missingPacks = () => directionsOf(pairOf()).filter(direction => packs.get(pairKey(direction))?.lowLatency === 'supported')

  /** Waits for prepareTranslation or the pack showing as installed, whichever comes first. */
  const prepare = ([a, b]: Pair) => new Promise<string | null>(resolve => {
    // A failed poll is retried by the next one; check() after this reports what stuck.
    const poll = setInterval(() => { translationStatus(a, b).then(status => { if (status.lowLatency === 'installed') finish(null) }, () => {}) }, PREPARE_POLL_MS)
    const finish = (result: string | null) => { clearInterval(poll); resolve(result) }
    void prepareTranslation(a, b).then(finish)
  })

  const downloadMissing = async (): Promise<void> => {
    if (progress) return
    problems = []
    try {
      for (const lang of missingSpeech()) {
        progress = `Downloading ${languageName(lang)} speech recognition…`; refresh()
        const error = await installSpeechLanguage(lang)
        if (error) problems.push(`${languageName(lang)} speech recognition: ${error}`)
        await check()
      }
      // Re-read after every check: one language pack usually serves both directions.
      const tried = new Set<string>()
      for (let direction; (direction = missingPacks().find(d => !tried.has(pairKey(d))));) {
        tried.add(pairKey(direction))
        const [a, b] = direction
        progress = `Downloading ${languageName(a)} → ${languageName(b)}…`; refresh()
        const error = await prepare(direction)
        await check()
        // A timeout is expected (the completion may never come); only a pack still missing counts.
        if (packs.get(pairKey(direction))?.lowLatency === 'supported') {
          problems.push(`${languageName(a)} → ${languageName(b)}: ${error && error !== 'timeout' ? error : 'not downloaded'}`)
        }
      }
    } finally {
      progress = ''
      refresh()
    }
  }

  const { page, refresh } = groupedPage({ title: 'Translate', largeTitle: false, build: container => {
    const pair = pairOf(), [their, mine] = pair
    shownPair = pairKey(pair)
    const open = (entry: NavigationEntry) => page.frame?.navigate(entry)
    const choice = (setting: typeof translateTheirLanguageSetting, other: typeof translateTheirLanguageSetting, title: string, otherTitle: string): CatalogItem =>
      ({ kind: 'setting', setting, title, unavailable: value => value === other.get() ? `Chosen for ${otherTitle}` : null })
    container.addChild(section({ header: 'Languages', rows: [
      ...settingRows(choice(translateTheirLanguageSetting, translateMyLanguageSetting, 'They Speak', 'I Speak'), open),
      ...settingRows(choice(translateMyLanguageSetting, translateTheirLanguageSetting, 'I Speak', 'They Speak'), open),
    ], footer: their === mine ? 'Pick two different languages.' : 'The glasses listen for both at once and translate each into the other.' }))

    const rows: Row[] = [
      ...[...new Set(pair)].map(lang => valueRow({ title: `Speech Recognition — ${languageName(lang)}`, value: speechLabel(speech.get(lang)) })),
      ...directionsOf(pair).map(direction => valueRow({ title: `Translation ${languageName(direction[0])} → ${languageName(direction[1])}`,
        value: packLabel(packs.get(pairKey(direction))) })),
    ]
    const footer = progress || (problems.length ? `Not finished:\n${problems.join('\n')}`
      : 'Speech recognition and translation run on this iPhone. Fast translation works offline; without it Apple Intelligence translates, more slowly.')
    container.addChild(section({ header: 'Downloads', rows, footer }))

    container.addChild(section({ rows: [
      buttonRow({ title: progress ? 'Downloading…' : 'Download Missing', enabled: !progress && (missingSpeech().length > 0 || missingPacks().length > 0),
        onTap: () => { void downloadMissing() } }),
      buttonRow({ title: 'Start on Glasses', enabled: their !== mine, onTap: () => { void getRuntime().controller.launchApp('translate') } }),
    ] }))
  } })

  let off: (() => void) | null = null
  page.on('loaded', () => {
    off?.()
    // A new pair needs new statuses; other settings do not touch this page.
    off = onAnySettingChanged(() => { if (pairKey(pairOf()) !== shownPair) { refresh(); void check() } })
    refresh()
    void check()
  })
  page.on('unloaded', () => { off?.(); off = null })
  return page
}
