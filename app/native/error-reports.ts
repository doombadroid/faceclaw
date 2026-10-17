/**
 * Durable reports of errors the app caught instead of crashing (Kotlin facade guards,
 * listener try/catch, discarded uncaught JS exceptions), so a caught error is never a
 * silent failure. JSON lines in Library (iOS) or the files directory (Android), written
 * by the main isolate only; the iOS shell shows them under Settings > General.
 */
import { File, Utils, knownFolders, path as fsPath } from '@nativescript/core'
import { FACECLAW_VERSION } from '../version'

declare const NSBundle: any
declare const FaceclawLog: { log(message: string): void } | undefined

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

const FILE_NAME = 'error-reports.jsonl'
const MAX_REPORTS = 200, MAX_CHARS = 1_000_000, MAX_MESSAGE = 2_000, MAX_STACK = 16_000, SAVE_INTERVAL_MS = 1000

let reports: ErrorReport[] | null = null
const thisSession = new Map<string, ErrorReport>()
const listeners = new Set<Listener>()
let saveTimer: ReturnType<typeof setTimeout> | null = null, lastSave = 0
let build: string | null = null

/** Record a caught error. Never throws: it is called from inside catch blocks. */
export function reportError(source: string, error: unknown, context?: Record<string, string>): void {
  try {
    const { message, stack } = normalizeError(error)
    const list = loaded(), key = `${source}\n${message}`
    let report = thisSession.get(key)
    const isNew = !report
    if (report) {
      report.count++
      report.at = new Date().toISOString()
      if (!list.includes(report)) list.push(report)
    } else {
      report = { at: new Date().toISOString(), build: appBuild(), platform: global.isIOS ? 'ios' : 'android',
        source: String(source), message, stack, context: context ? { ...context } : undefined, count: 1 }
      thisSession.set(key, report)
      list.push(report)
    }
    log(report)
    // A new error is on disk before anything else runs, unless a write just happened: a
    // burst of distinct errors must not rewrite the file every frame. A repeat only bumps a count.
    if (isNew && new Date().getTime() - lastSave >= SAVE_INTERVAL_MS) save()
    else saveTimer ??= setTimeout(save, SAVE_INTERVAL_MS)
    for (const listener of [...listeners]) {
      try { listener({ ...report }, isNew) } catch (listenerError) { console.error(`error report listener failed: ${listenerError}`) }
    }
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
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
  try { if (File.exists(filePath())) File.fromPath(filePath()).removeSync() } catch (error) { console.error(`error-reports: could not clear: ${error}`) }
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

function filePath(): string {
  return fsPath.join(global.isIOS ? knownFolders.ios.library().path : knownFolders.documents().path, FILE_NAME)
}

function loaded(): ErrorReport[] {
  if (reports) return reports
  reports = []
  try {
    if (!File.exists(filePath())) return reports
    for (const line of File.fromPath(filePath()).readTextSync().split('\n')) {
      if (!line) continue
      try { reports.push(JSON.parse(line) as ErrorReport) } catch { /* a torn last line */ }
    }
  } catch (error) { console.error(`error-reports: could not read: ${error}`) }
  return reports
}

const sorted = (list: ErrorReport[]) => list.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0)

/** Rewrites the whole file: the newest MAX_REPORTS that fit in MAX_CHARS. */
function save(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
  lastSave = new Date().getTime()
  try {
    const list = sorted(loaded())
    const lines = list.map(report => JSON.stringify(report))
    let drop = Math.max(0, lines.length - MAX_REPORTS)
    let chars = lines.slice(drop).reduce((sum, line) => sum + line.length + 1, 0)
    while (chars > MAX_CHARS && drop < lines.length - 1) chars -= lines[drop++].length + 1
    list.splice(0, drop)
    File.fromPath(filePath()).writeTextSync(lines.slice(drop).join('\n') + '\n', (error: unknown) => { throw error })
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
