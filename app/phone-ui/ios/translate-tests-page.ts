import { Dialogs, knownFolders, Label, type Page } from '@nativescript/core'
import { buttonRow, customRow, groupedPage, navRow, section, valueRow } from './ui-kit'
import { getRuntime } from './runtime'
import { presentOnTop } from './present'
import { reportError } from '../../native/error-reports'
import { remoteLog } from '../../native/remote-log.ios'
import { guardCallback } from '../../native/callback-errors.ios'
import { kotlinListener } from '../../native/kotlin-listener.ios'
import { FaceclawCommunicatorBridge } from '../../native/faceclaw-communicator.ios'
import { GrayImage } from '../../graphics/image'
import { getFont } from '../../graphics/bdffont'
import { EvenHubFont } from '../../graphics/evenhub-font'
import { fontSelectionLabel, getDefaultSmallFont, getUiFontSelection } from '../../graphics/ui-fonts'
import { shell } from '../../ui/shell/shell'
import type { Layer, LayerContext } from '../../ui/layers'
import { wrapWords } from '../../apps/microphones/captions-layer'
import {
  CAPTION_LINES, FONT_SAMPLES, WRAP_SAMPLE, LID_CASES, PAIRS, localeCoverage, median, missingGlyphs, nextPair, scoreLanguageId, spikeLine, type LidResult,
} from './translate-spike'

/*
 * Settings > General (tap the app name five times) > Translate Tests: the translation spike's
 * on-device checks. Every step appends a JSON line to Documents/translate-spike.jsonl (pull it
 * with afcclient) and each test's summary shows on the page. Nothing here changes settings,
 * firmware or the normal app; failures are recorded as ok:false, never thrown.
 */

const LOG_NAME = 'translate-spike.jsonl'
const STRATEGIES = [[0, 'default'], [1, 'lowLatency'], [2, 'highFidelity']] as const
const WINDOW_ID = 'translate-tests'
const T4_TICKS = 30, T4_EVERY_MS = 3_000
const T7_HOLD_MS = 8_000

type Rec = (step: string, ok: boolean, ms: number, detail?: unknown) => void
type Availability = { supported: string[]; pairs: Record<string, string> }
type Translated = { ready: boolean; rows: { text: string; out?: string; error?: string; ms: number }[] }

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function appendLog(line: string): void {
  remoteLog('translate-tests', 'info', line)
  // getFile creates the file, which appendTextSync's NSFileHandle needs.
  knownFolders.documents().getFile(LOG_NAME).appendTextSync(line + '\n', error => reportError('translate-tests.log', error))
}

function logLineCount(): number {
  const text = knownFolders.documents().getFile(LOG_NAME).readTextSync(error => reportError('translate-tests.log', error))
  return text ? text.split('\n').filter(Boolean).length : 0
}

/** A native completion as a promise; rejects when it never answers. */
function nativeCall<T>(where: string, timeoutMs: number, start: (done: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (typeof FaceclawTranslateSpike === 'undefined') throw new Error('this build has no FaceclawTranslateSpike (Swift shim)')
    const timer = setTimeout(() => reject(new Error(`${where}: no answer in ${timeoutMs} ms`)), timeoutMs)
    start(value => guardCallback(where, () => { clearTimeout(timer); resolve(value) }))
  })
}

const availability = (pairs: readonly string[], strategy: number) => nativeCall<string>('translate-tests.availability', 30_000,
  done => FaceclawTranslateSpike.availabilityPairsStrategyCompletion(pairs.join(','), strategy, done)).then(json => JSON.parse(json) as Availability)

const translateLines = (lines: readonly string[], pair: string, strategy: number, timeoutMs = 120_000) => {
  const [source, target] = pair.split('>') as [string, string]
  return nativeCall<string>('translate-tests.translate', timeoutMs,
    done => FaceclawTranslateSpike.translateLinesSourceTargetStrategyCompletion(JSON.stringify(lines), source, target, strategy, done))
    .then(json => JSON.parse(json) as Translated)
}

const glassesPhase = () => getRuntime().controller.connectionState?.phase ?? 'disconnected'
const APP_STATES = ['active', 'inactive', 'background']

type SampleFace = {
  name: string; lineHeight: number; measureText: (text: string) => number; draw: (image: GrayImage, x: number, y: number, text: string) => void
}
const SAMPLE_X = 96

/** T7's glasses page: every FONT_SAMPLES line in one face, labelled in the UI font, then WRAP_SAMPLE wrapped as captions wrap. */
class FontSampleLayer implements Layer {
  face: SampleFace | null = null
  /** The last paint's WRAP_SAMPLE: wrapped lines, the widest one's px and the width it had. */
  wrap: { lines: number; widestPx: number; maxPx: number } | null = null

  paint(ctx: LayerContext): GrayImage {
    const label = getDefaultSmallFont()
    const { width, height } = ctx.stack.getBaseSize()
    const image = new GrayImage(width, height, 0)
    image.drawText(label, 12, 6, `T7 font: ${this.face?.name ?? '-'}`, 220)
    let y = 12 + label.lineHeight
    for (const sample of FONT_SAMPLES) {
      image.drawText(label, 12, y, sample.label, 130)
      this.face?.draw(image, SAMPLE_X, y, sample.text)
      y += Math.max(label.lineHeight, this.face?.lineHeight ?? 0) + 6
    }
    if (this.face) {
      image.drawText(label, 12, y, WRAP_SAMPLE.label, 130)
      const maxPx = width - SAMPLE_X - 12, wrapped = wrapWords(this.face, WRAP_SAMPLE.text, maxPx)
      this.wrap = { lines: wrapped.length, widestPx: Math.max(...wrapped.map(line => this.face!.measureText(line))), maxPx }
      for (const line of wrapped) {
        this.face.draw(image, SAMPLE_X, y, line)
        y += this.face.lineHeight + 2
      }
    }
    return image
  }

  handleInput(): void {}
}

let probeListener: FaceclawKitFaceclawTranslateProbeListener | null = null
// Module-level, so a test still running behind a closed page (T4 runs 90 s) blocks a second one
// started from a reopened page; refreshPage is the newest page's.
let busy: string | null = null
let refreshPage = () => {}

export function createPage(): Page {
  let pair = 'es>en'
  const results = new Map<string, string>()
  // A new label per build: refresh() empties the container but the old section keeps its row,
  // so re-adding one label throws "View already has a parent".
  let output = new Label()
  let idle = ''
  const resultsText = () => [...results].map(([name, value]) => `${name}  ${value}`).join('\n\n') || idle
  const show = (test: string, text: string) => {
    results.set(test, text)
    output.text = resultsText()
  }

  async function run(test: string, body: (rec: Rec) => Promise<string>): Promise<void> {
    if (busy) { show('Busy', `${busy} is still running.`); return }
    busy = test
    const started = Date.now()
    const rec: Rec = (step, ok, ms, detail) => appendLog(spikeLine(test, step, ok, ms, detail))
    try {
      refreshPage()
      show(test, 'running…')
      const summary = await body(rec)
      rec('done', true, Date.now() - started, summary)
      show(test, summary)
    } catch (error) {
      reportError(`translate-tests.${test}`, error)
      rec('done', false, Date.now() - started, String(error))
      show(test, `FAILED: ${error}`)
    } finally {
      busy = null
      refreshPage()
    }
  }

  const T1 = async (rec: Rec) => {
    const ios = UIDevice.currentDevice.systemVersion
    rec('device', true, 0, { ios, model: UIDevice.currentDevice.model })
    const lines: string[] = []
    for (const [code, name] of STRATEGIES) {
      const t0 = Date.now()
      const result = await availability(PAIRS, code)
      rec(`availability ${name}`, true, Date.now() - t0, result)
      if (code === 0) lines.push(`iOS ${ios}. ${result.supported.length} languages: ${result.supported.join(' ')}`)
      lines.push(`${name}: ${PAIRS.map(p => `${p} ${result.pairs[p]}`).join(', ')}`)
    }
    return lines.join('\n')
  }

  const T2 = async (rec: Rec) => {
    const [source, target] = pair.split('>') as [string, string]
    const t0 = Date.now()
    const error = await nativeCall<string | null>('translate-tests.prepare', 10 * 60_000,
      done => FaceclawTranslateSpike.prepareSourceTargetCompletion(source, target, done))
    rec('prepareTranslation', !error, Date.now() - t0, { pair, error })
    const after = (await availability([pair], 0)).pairs[pair]
    rec('status after', after === 'installed', 0, { pair, status: after })
    return `${pair}: ${error ? `failed: ${error}` : 'prepared'} in ${Date.now() - t0} ms; status now ${after}`
  }

  const installedPairs = async (rec: Rec) => {
    const status = (await availability(PAIRS, 0)).pairs
    const installed = PAIRS.filter(p => status[p] === 'installed')
    rec('installed pairs', installed.length > 0, 0, { installed, status })
    return installed
  }

  const T3 = async (rec: Rec) => {
    const installed = await installedPairs(rec)
    if (!installed.length) return 'No installed pair: run T2 to download one.'
    const lines: string[] = []
    for (const p of installed) {
      for (const [code, name] of STRATEGIES) {
        const out = await translateLines(CAPTION_LINES[p.split('>')[0]!] ?? [], p, code)
        const ms = out.rows.map(row => row.ms), failed = out.rows.filter(row => row.error)
        const warm = median(ms.slice(1))
        rec(`${p} ${name}`, !failed.length, ms.reduce((a, b) => a + b, 0), { ready: out.ready, firstMs: ms[0], warmMedianMs: warm, rows: out.rows })
        lines.push(`${p} ${name}: first ${Math.round(ms[0] ?? 0)} ms, then median ${Math.round(warm)} ms` +
          (failed.length ? `, ${failed.length} failed (${failed[0]!.error})` : `; "${out.rows[0]?.out ?? ''}"`))
      }
    }
    return lines.join('\n')
  }

  const T4 = async (rec: Rec) => {
    const installed = await installedPairs(rec)
    const p = installed.includes('es>en') ? 'es>en' : installed[0] ?? 'es>en'
    const lines = CAPTION_LINES[p.split('>')[0]!] ?? []
    rec('start', true, 0, { pair: p, installed: installed.includes(p), glasses: glassesPhase(), ticks: T4_TICKS, everyMs: T4_EVERY_MS })
    show('T4', `Running ${T4_TICKS * T4_EVERY_MS / 1000} s: LOCK THE PHONE NOW and unlock it after that. ` +
      `Glasses ${glassesPhase()} (a connected BLE session may keep the app running in the background).`)
    const start = Date.now()
    let ok = 0, foreground = 0
    for (let tick = 0; tick < T4_TICKS; tick++) {
      const due = start + tick * T4_EVERY_MS
      await sleep(Math.max(0, due - Date.now()))
      const app = UIApplication.sharedApplication
      const state = { late: Date.now() - due, app: APP_STATES[app.applicationState] ?? String(app.applicationState), protectedData: app.protectedDataAvailable, glasses: glassesPhase() }
      if (state.app === 'active') foreground++
      const t0 = Date.now()
      try {
        const row = (await translateLines([lines[tick % lines.length]!], p, 0, 15_000)).rows[0]
        if (row && !row.error) ok++
        rec(`tick ${tick}`, !!row && !row.error, Date.now() - t0, { ...state, text: row?.text, out: row?.out, error: row?.error })
      } catch (error) {
        reportError('translate-tests.T4', error)
        rec(`tick ${tick}`, false, Date.now() - t0, { ...state, error: String(error) })
      }
    }
    return `${p}: ${ok}/${T4_TICKS} ticks translated, ${foreground} in the foreground, ${Math.round((Date.now() - start) / 1000)} s (expected ${T4_TICKS * T4_EVERY_MS / 1000}). Ticks are in the log.`
  }

  const T5 = async (rec: Rec) => {
    const recognizer = NLLanguageRecognizer.new()
    const outcomes: LidResult[] = []
    LID_CASES.forEach((item, index) => {
      recognizer.reset()
      recognizer.processString(item.text)
      const hypotheses = recognizer.languageHypothesesWithMaximum(3), keys = hypotheses.allKeys
      const top: [string, number][] = []
      for (let i = 0; i < keys.count; i++) { const key = keys.objectAtIndex(i); top.push([key, Math.round(Number(hypotheses.objectForKey(key)) * 1000) / 1000]) }
      top.sort((a, b) => b[1] - a[1])
      const outcome = { ...item, got: recognizer.dominantLanguage }
      outcomes.push(outcome)
      rec(`case ${index}`, (outcome.got ?? '').toLowerCase() === item.expect.toLowerCase(), 0, { ...outcome, top })
    })
    const score = scoreLanguageId(outcomes)
    rec('score', true, 0, score)
    const pct = (value: number) => `${Math.round(value * 100)}%`
    return `${score.correct}/${score.total} (${pct(score.accuracy)}); medium ${pct(score.medium.accuracy)}, 1-3 words ${pct(score.short.accuracy)}` +
      (score.misses.length ? `\nMisses: ${score.misses.join('; ')}` : '')
  }

  const T6 = async (rec: Rec) => {
    const json = await nativeCall<string>('translate-tests.speech', 30_000, done => FaceclawTranslateSpike.speechLocales(done))
    const result = JSON.parse(json) as { available: boolean; supported: string[]; installed: string[] }
    const coverage = localeCoverage({ supported: result.supported, installed: result.installed }, ['ja', 'zh', 'ko', 'en', 'es'])
    rec('SpeechTranscriber', result.available, 0, { ...result, coverage })
    return `available ${result.available}; ${result.supported.length} supported, ${result.installed.length} installed\n` +
      Object.entries(coverage).map(([lang, has]) => `${lang}: supported ${has.supported}, installed ${has.installed}`).join('; ') +
      `\nInstalled: ${result.installed.join(' ') || 'none'}`
  }

  const T7 = async (rec: Rec) => {
    const ui = getDefaultSmallFont(), terminus = getFont('terminus12'), stock = EvenHubFont.get()
    const faces = [
      { name: `UI small (${fontSelectionLabel(getUiFontSelection())})`, lineHeight: ui.lineHeight, hasGlyph: (cp: number) => ui.hasGlyph(cp), measureText: (text: string) => ui.measureText(text),
        draw: (image: GrayImage, x: number, y: number, text: string) => image.drawText(ui, x, y, text, 235) },
      { name: 'Terminus 12 bitmap', lineHeight: terminus.lineHeight, hasGlyph: (cp: number) => terminus.hasGlyph(cp), measureText: (text: string) => terminus.measureText(text),
        draw: (image: GrayImage, x: number, y: number, text: string) => image.drawText(terminus, x, y, text, 235) },
      { name: 'G2 stock 20 + Source Han Sans (EvenHub)', lineHeight: stock.lineHeight, hasGlyph: (cp: number) => stock.hasGlyph(cp), measureText: (text: string) => stock.measureLine(text),
        draw: (image: GrayImage, x: number, y: number, text: string) => stock.drawText(image, x, y, text, 235) },
    ]
    const lines: string[] = []
    for (const face of faces) {
      const missing = Object.fromEntries(FONT_SAMPLES.map(sample => [sample.label, missingGlyphs(face.hasGlyph, sample.text)]))
      rec(`coverage ${face.name}`, true, 0, Object.fromEntries(Object.entries(missing).map(([k, cps]) => [k, cps.map(cp => cp.toString(16))])))
      lines.push(`${face.name}: ${FONT_SAMPLES.map(s => `${s.label} ${missing[s.label]!.length ? `-${missing[s.label]!.length}` : 'ok'}`).join(', ')}`)
    }
    const phase = glassesPhase()
    rec('glasses', phase === 'connected', 0, { phase, note: phase === 'connected' ? undefined : 'shown in the phone mirror only' })
    const layer = new FontSampleLayer()
    const window = await getRuntime().controller.openHarnessWindow(WINDOW_ID, 'Translate Tests', layer)
    if (!window) throw new Error('the glasses window did not open')
    try {
      for (const face of faces) {
        layer.face = face
        window.requestRender()
        show('T7', `On the glasses now: ${face.name} (${T7_HOLD_MS / 1000} s each). Note which lines look right.\n${lines.join('\n')}`)
        await sleep(T7_HOLD_MS)
        // ok:false when the caption wrap left a line wider than the lens column (no spaces to break at).
        rec(`showing ${face.name}`, !!layer.wrap && layer.wrap.widestPx <= layer.wrap.maxPx, T7_HOLD_MS, { captionWrap: layer.wrap })
      }
    } finally {
      shell.closeWindow(WINDOW_ID)
    }
    return `Missing glyphs per sample (-n), report what the lens showed:\n${lines.join('\n')}`
  }

  const T8 = async (rec: Rec) => {
    const bridge = FaceclawCommunicatorBridge.getActive()
    if (!bridge || glassesPhase() !== 'connected') { rec('glasses', false, 0, { phase: glassesPhase() }); return 'Glasses not connected: connect them and run T8 again.' }
    const native = bridge.getNativeCommunicator()
    const steps: string[] = []
    const outcome = await new Promise<string>(resolve => {
      const timer = setTimeout(() => { native.cancelTranslateProbe(); resolve('no finish in 40 s: cancelled') }, 40_000)
      probeListener = kotlinListener(FaceclawKitFaceclawTranslateProbeListener, {
        onStepStepOkMsDetail: (step, ok, ms, detail) => {
          rec(step ?? '', ok, ms, detail)
          steps.push(`${ok ? '✓' : '✗'} ${ms} ms ${step}${detail ? ` (${detail})` : ''}`)
          show('T8', `running…\n${steps.join('\n')}`)
        },
        onFinishedOkDetail: (ok, detail) => { clearTimeout(timer); resolve(`${ok ? 'OK' : 'STOPPED'}: ${detail ?? ''}`) },
      })
      const error = native.startTranslateProbeSourceTargetListener('es', 'en', probeListener)
      if (error) { clearTimeout(timer); resolve(`did not start: ${error}`) }
    })
    probeListener = null
    return `${outcome}\n${steps.join('\n')}`
  }

  const confirmThen = async (test: string, message: string, body: (rec: Rec) => Promise<string>) => {
    if (await Dialogs.confirm({ title: test, message, okButtonText: 'Start', cancelButtonText: 'Cancel' })) await run(test, body)
  }

  const tests: [string, () => void][] = [
    ['T1 Availability', () => { void run('T1', T1) }],
    ['T2 Download Consent', () => { void run('T2', T2) }],
    ['T3 Translate Latency', () => { void run('T3', T3) }],
    ['T4 Locked / Background (90 s)', () => { void confirmThen('T4', 'Lock the phone right after tapping Start and unlock it after 90 s.', T4) }],
    ['T5 Language ID', () => { void run('T5', T5) }],
    ['T6 Speech Locales', () => { void run('T6', T6) }],
    ['T7 CJK On The Lens', () => { void run('T7', T7) }],
    ['T8 Firmware Translate Screen', () => { void confirmThen('T8', 'The glasses show the firmware Translate screen for up to 30 s, then it closes.', T8) }],
  ]

  const { page, refresh } = groupedPage({ title: 'Translate Tests', largeTitle: false, build: container => {
    container.addChild(section({ rows: [navRow({ title: 'Pair (T2)', value: pair, onTap: () => { pair = nextPair(pair); refresh() } })],
      footer: 'Tap to cycle the language pair T2 asks to download.' }))
    container.addChild(section({ rows: tests.map(([title, onTap]) => buttonRow({ title, enabled: !busy, onTap })) }))
    output = new Label()
    output.className = 'os-error-stack'; output.textWrap = true
    output.text = resultsText()
    container.addChild(section({ header: 'Results', rows: [customRow(output)] }))
    container.addChild(section({ rows: [
      valueRow({ title: `Documents/${LOG_NAME}`, value: `${logLineCount()} lines` }),
      buttonRow({ title: 'Share Results', onTap: () => {
        // The file itself (AirDrop, Messages, Files), not its text.
        const url = NSURL.fileURLWithPath(knownFolders.documents().getFile(LOG_NAME).path)
        const sheet = UIActivityViewController.alloc().initWithActivityItemsApplicationActivities([url], null)
        // A popover (regular width) needs an anchor.
        if (sheet.popoverPresentationController) sheet.popoverPresentationController.sourceView = page.ios.view
        presentOnTop(sheet)
      } }),
      buttonRow({ title: 'Clear Log', role: 'destructive', enabled: !busy, onTap: () => {
        knownFolders.documents().getFile(LOG_NAME).writeTextSync('', error => reportError('translate-tests.log', error)); refresh()
      } }),
    ], footer: 'Every step is a JSON line {ts, test, step, ok, ms, detail}; Share Results sends the file, or pull it over USB with afcclient.' }))
  } })
  refreshPage = refresh
  idle = busy ? `${busy} is still running from an earlier visit.` : 'No test run yet.'
  output.text = resultsText()
  return page
}
