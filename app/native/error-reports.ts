/**
 * Durable reports of errors the app caught instead of crashing (Kotlin facade guards,
 * listener try/catch, discarded uncaught JS exceptions), so a caught error is never a
 * silent failure. JSON lines in Library (iOS) or the files directory (Android), written
 * by the main isolate only (a worker posts its reports there); the iOS shell shows them
 * under Settings > General.
 */
import { Application, File, Folder, Utils, knownFolders, path as fsPath } from '@nativescript/core'
import { FACECLAW_VERSION } from '../version'

declare const NSBundle: any
declare const FaceclawLog: { log(message: string): void } | undefined
declare const FaceclawKitIosErrorReports: { shared: { forgetRepeats(): void } } | undefined

export type ErrorReport = {
  /** Latest occurrence (ISO). */
  at: string
  build: string
  platform: string
  source: string
  message: string
  stack: string
  context?: Record<string, string>
  /** Occurrences this session (repeats of one source and message). */
  count: number
}

type Listener = (report: ErrorReport, isNewThisSession: boolean) => void

/** A worker's report on its way to the main isolate (WorkerAppHost hands it to reportError). */
export type WorkerErrorReport = { type: 'error-report'; source: string; message: string; stack: string; context?: Record<string, string> }

const FILE_NAME = 'error-reports.jsonl'
const MAX_REPORTS = 200, MAX_CHARS = 1_000_000, MAX_MESSAGE = 2_000, MAX_STACK = 16_000, SAVE_INTERVAL_MS = 1000
/** New reports written at once per second; past it they wait for the timer (a storm of distinct errors). */
const MAX_IMMEDIATE_SAVES = 5
/** Unreadable report files kept aside (error-reports.jsonl.corrupt-<time>), newest first. */
const MAX_CORRUPT = 2
/** Distinct messages kept per source per session; past it they share one report (an error naming its frame). */
const MAX_PER_SOURCE = 20
const LISTENER_SOURCE = 'error report listener'

let reports: ErrorReport[] | null = null
const thisSession = new Map<string, ErrorReport>()
const messagesPerSource = new Map<string, number>()
const listeners = new Set<Listener>()
let saveTimer: ReturnType<typeof setTimeout> | null = null, lifecycleHooked = false, unsaved = false
let saveWindowStart = 0, immediateSaves = 0
/** The file could not be read nor moved aside: saving would overwrite reports nobody has seen. */
let readOnly = false
let build: string | null = null

/**
 * Record a caught error. Never throws: it is called from inside catch blocks. [occurrences]: how
 * many times it happened, for a caller that only forwards some repeats (IosErrorReports.record).
 */
export function reportError(source: string, error: unknown, context?: Record<string, string>, occurrences = 1): void {
  try {
    // Thrown by throwIfError (kotlin-data.ts): Kotlin's boundaryError already filed it.
    if ((error as { reportedByKotlin?: unknown } | null)?.reportedByKotlin === true) return
    const normalized = normalizeError(error), stack = normalized.stack
    let message = normalized.message
    if (!Utils.isMainThread()) { fromWorker(source, message, stack, context); return }
    const list = loaded()
    let key = `${source}\n${message}`, overflow = false
    if (!thisSession.has(key)) {
      const seen = messagesPerSource.get(source) ?? 0
      if ((overflow = seen >= MAX_PER_SOURCE)) {
        context = { ...context, latest: message }
        message = `more than ${MAX_PER_SOURCE} different errors this session`
        key = `${source}\n${message}`
      } else messagesPerSource.set(source, seen + 1)
    }
    let report = thisSession.get(key)
    const isNew = !report
    const times = Number.isInteger(occurrences) && occurrences > 0 ? occurrences : 1
    const before = report?.count ?? 0
    if (report) {
      report.count += times
      report.at = new Date().toISOString()
      if (overflow) { report.context = { ...context }; report.stack = stack }
      if (!list.includes(report)) list.push(report)
    } else {
      report = { at: new Date().toISOString(), build: appBuild(), platform: global.isIOS ? 'ios' : 'android',
        source: String(source), message, stack, context: context ? { ...context } : undefined, count: times }
      thisSession.set(key, report)
      list.push(report)
    }
    // A new error is on disk before anything else runs, up to MAX_IMMEDIATE_SAVES a second: a
    // storm of distinct errors must not rewrite the file every frame (each source has at most
    // MAX_PER_SOURCE + 1 reports, the file MAX_REPORTS). A repeat only bumps a count, written at
    // counts 2, 4, 8... (and at suspend/exit): an error every frame must not rewrite the whole
    // file every second.
    const now = new Date().getTime()
    if (now - saveWindowStart >= SAVE_INTERVAL_MS) { saveWindowStart = now; immediateSaves = 0 }
    if (isNew && immediateSaves < MAX_IMMEDIATE_SAVES) { immediateSaves++; save() }
    // Passed a power of two: a jump of several occurrences may step over it.
    else if (isNew || Math.clz32(before) !== Math.clz32(report.count)) scheduleSave()
    else unsaved = true
    for (const listener of [...listeners]) {
      try { listener({ ...report }, isNew) } catch (listenerError) {
        // Reported too, but later (the caller may be mid-layout) and never about itself: a
        // listener that always throws would otherwise report once per tick forever.
        if (report.source !== LISTENER_SOURCE) setTimeout(() => reportError(LISTENER_SOURCE, listenerError), 0)
      }
    }
    // Last and on its own: a native logger that throws must not cost the save or the notice.
    try { log(report) } catch { /* the report is saved; only the log line is lost */ }
  } catch (reportFailure) {
    try { console.error(`reportError(${source}) failed: ${reportFailure}`) } catch { /* nothing left to tell */ }
  }
}

/** Newest first. */
export function listErrorReports(): ErrorReport[] {
  try { return sorted(loaded()).reverse().map(report => ({ ...report })) } catch { return [] }
}

export function clearErrorReports(): void {
  reports = []
  thisSession.clear()
  messagesPerSource.clear()
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
  unsaved = false
  try {
    for (const path of [filePath(), tmpPath()]) if (File.exists(path)) File.fromPath(path).removeSync((error: unknown) => { throw error })
    // The unreadable file that kept saving off is gone.
    readOnly = false
  } catch (error) { console.error(`error-reports: could not clear: ${error}`) }
  // Kotlin's repeat filter too: a Kotlin error that keeps happening would otherwise next be
  // forwarded only at its next power of two, unseen until then.
  try {
    if (typeof FaceclawKitIosErrorReports !== 'undefined') FaceclawKitIosErrorReports.shared.forgetRepeats()
  } catch (error) { reportError('error reports', error, { while: 'resetting the Kotlin repeat filter' }) }
}

export function onErrorReport(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function normalizeError(error: unknown): { message: string; stack: string } {
  let message: string, stack = ''
  const e = error as any
  try {
    if (typeof error === 'string') message = error
    else if (e && typeof e.localizedDescription === 'string' && 'domain' in e) message = `${e.localizedDescription} (${e.domain} ${e.code})`
    else if (e && typeof e.message === 'string') {
      const name = typeof e.name === 'string' && e.name !== 'Error' ? e.name : ''
      message = name && e.message ? `${name}: ${e.message}` : e.message || name || 'Error'
      if (typeof e.stack === 'string') stack = e.stack
    } else message = describe(error)
  } catch { message = '(unprintable error)' }
  // Strings, NSErrors and the rest carry no stack: the reporting call site is the next best.
  if (!stack) stack = (new Error().stack ?? '').split('\n').slice(1).join('\n')
  return { message: message.slice(0, MAX_MESSAGE), stack: stack.slice(0, MAX_STACK) }
}

function describe(value: unknown): string {
  try { return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value) } catch { /* below */ }
  try { return String(value) } catch { return '(unprintable error)' }
}

const folderPath = () => global.isIOS ? knownFolders.ios.library().path : knownFolders.documents().path
const filePath = () => fsPath.join(folderPath(), FILE_NAME)
const tmpPath = () => `${filePath()}.tmp`

/** On a worker: the file belongs to the main isolate, whose next save would overwrite a worker's write. */
function fromWorker(source: string, message: string, stack: string, context?: Record<string, string>): void {
  try { log({ source: String(source), message, stack, count: 1 } as ErrorReport) } catch { /* below */ }
  // ponytail: only WorkerAppHost workers relay this; a bare Worker (package-extraction) gets just the log line.
  if (typeof global.postMessage === 'function') {
    global.postMessage({ type: 'error-report', source: String(source), message, stack, context: context ? { ...context } : undefined } satisfies WorkerErrorReport)
  }
}

function loaded(): ErrorReport[] {
  if (reports) return reports
  reports = []
  let renameError: unknown = null
  // No file but a .tmp: save() died between dropping the old file and renaming the complete
  // new one. Put it in place now, or the next save's .tmp write would be over the only copy.
  try {
    if (!File.exists(filePath()) && File.exists(tmpPath())) File.fromPath(tmpPath()).renameSync(FILE_NAME, (error: unknown) => { throw error })
  } catch (error) { renameError = error; readOnly = true }
  // Both: save() died after writing the .tmp (complete or torn) but before dropping the old
  // file. Each may hold what the other lacks; the next save writes the union. Read apart: a
  // torn .tmp (iOS writes it in place, so it can end mid UTF-8 sequence) must not take the
  // intact file aside with it.
  const unreadable: string[] = []
  let readError: unknown = null
  const read = (path: string) => {
    try { return readReports(path) } catch (error) { unreadable.push(path); readError ??= error; return [] }
  }
  reports = merge(read(filePath()), read(tmpPath()))
  // reports is set, so these do not come back here.
  if (unreadable.length) quarantine(unreadable, readError)
  if (renameError) reportError('error reports', renameError, { notSaved: `could not put ${FILE_NAME}.tmp in place; reports are kept in memory only this session` })
  return reports
}

function readReports(path: string): ErrorReport[] {
  if (!File.exists(path)) return []
  const text: unknown = File.fromPath(path).readTextSync((error: unknown) => { throw error })
  // NativeScript returns undefined for a file it cannot decode (a torn UTF-8 sequence).
  if (typeof text !== 'string') throw new Error(`${path} is unreadable`)
  const list: ErrorReport[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const report = JSON.parse(line) as ErrorReport | null
      // Anything else would break sorting, and with it every later save.
      if (report && typeof report === 'object' && typeof report.at === 'string') list.push(report)
    } catch { /* a torn last line */ }
  }
  return list
}

/**
 * The .tmp's copy of a report replaces the old file's (larger count, newer at and stack); each
 * old entry is matched once, so an earlier launch's report of the same error stays its own.
 */
function merge(old: ErrorReport[], newer: ErrorReport[]): ErrorReport[] {
  const merged = [...old], matched = new Set<number>()
  for (const report of newer) {
    const i = merged.findIndex((m, j) => !matched.has(j) && m.source === report.source && m.message === report.message)
    if (i < 0) { merged.push(report); continue }
    matched.add(i)
    const had = merged[i]
    merged[i] = { ...(had.at > report.at ? had : report), count: Math.max(had.count, report.count) }
  }
  return merged
}

/** These files cannot be read: keep them aside (the next save would overwrite them) and say so. */
function quarantine(paths: string[], readError: unknown): void {
  const context: Record<string, string> = {}
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'), fail = (error: unknown) => { throw error }
    for (const path of paths) {
      const tmp = path === tmpPath(), name = `${FILE_NAME}.corrupt-${stamp}${tmp ? '.tmp' : ''}`
      File.fromPath(path).renameSync(name, fail)
      context[tmp ? 'tmpMovedTo' : 'movedTo'] = name
    }
  } catch (moveError) {
    readOnly = true
    context.notSaved = `could not move it aside (${normalizeError(moveError).message}); reports are kept in memory only this session`
  }
  // Moved aside already, so saving is safe: a failed clean-up only leaves extra old files.
  try {
    const folder = folderPath(), prefix = `${FILE_NAME}.corrupt-`, stampOf = (name: string) => name.slice(prefix.length).replace(/\.tmp$/, '')
    const aside = Folder.fromPath(folder).getEntitiesSync().map(entry => entry.name).filter(name => name.startsWith(prefix))
    const keep = [...new Set(aside.map(stampOf))].sort().slice(-MAX_CORRUPT)
    for (const name of aside) if (!keep.includes(stampOf(name))) File.fromPath(fsPath.join(folder, name)).removeSync((error: unknown) => { throw error })
  } catch (pruneError) {
    context.pruneFailed = `could not delete older unreadable files (${normalizeError(pruneError).message})`
  }
  reportError('error reports', readError, context)
}

const sorted = (list: ErrorReport[]) => list.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0)

function scheduleSave(): void {
  saveTimer ??= setTimeout(save, SAVE_INTERVAL_MS)
  if (lifecycleHooked) return
  lifecycleHooked = true
  // The second after a repeat is when a force-quit or the real crash tends to come.
  const flush = () => { if (saveTimer !== null || unsaved) save() }
  Application.on(Application.suspendEvent, flush)
  Application.on(Application.exitEvent, flush)
}

/**
 * Rewrites the whole file: the newest MAX_REPORTS that fit in MAX_CHARS. Via a .tmp so a
 * death mid-write loses nothing on disk; NativeScript's rename never replaces a file, so the
 * old one goes first and loaded() falls back to the .tmp if death comes in between.
 */
function save(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
  unsaved = false
  if (readOnly) return
  try {
    const list = sorted(loaded())
    const lines = list.map(report => JSON.stringify(report))
    let drop = Math.max(0, lines.length - MAX_REPORTS)
    let chars = lines.slice(drop).reduce((sum, line) => sum + line.length + 1, 0)
    while (chars > MAX_CHARS && drop < lines.length - 1) chars -= lines[drop++].length + 1
    list.splice(0, drop)
    const fail = (error: unknown) => { throw error }
    File.fromPath(tmpPath()).writeTextSync(lines.slice(drop).join('\n') + '\n', fail)
    if (File.exists(filePath())) File.fromPath(filePath()).removeSync(fail)
    File.fromPath(tmpPath()).renameSync(FILE_NAME, fail)
  } catch (error) { console.error(`error-reports: could not save: ${error}`) }
}

function log(report: ErrorReport): void {
  // Counts 1, 2, 4, 8...: an error repeating every frame must not flood the log.
  if (report.count & (report.count - 1)) return
  const line = `[error-report] ${report.source}: ${report.message}` + (report.count > 1 ? ` (x${report.count})` : `\n${report.stack}`)
  console.error(line)
  // Release builds drop console output; idevicesyslog reads the system log.
  if (typeof FaceclawLog !== 'undefined') FaceclawLog.log(line)
}

function appBuild(): string {
  if (build) return build
  try {
    if (global.isIOS) {
      const info = NSBundle.mainBundle.infoDictionary
      build = `${info.objectForKey('CFBundleShortVersionString')} (${info.objectForKey('CFBundleVersion')})`
    } else {
      const context = Utils.android.getApplicationContext()
      const pkg = context.getPackageManager().getPackageInfo(context.getPackageName(), 0)
      // oxlint-disable-next-line typescript/no-deprecated -- getLongVersionCode needs API 28 (minSdk 24)
      build = `${pkg.versionName} (${pkg.versionCode})`
    }
  } catch { build = FACECLAW_VERSION }
  return build
}
