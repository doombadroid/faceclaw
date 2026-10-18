/**
 * Wireless logging for development (Settings > General > Developer > Remote Log URL): error
 * reports, the app log FaceclawLog gets (IosPreviewController.logBluetooth, and native code through
 * FaceclawLog's sink), console output (debug
 * builds only: release builds strip console calls), Translate Tests lines and a session-start line go out as batched JSON POSTs to <url>/log, e.g. phone-log-sink.py behind
 * `tailscale serve`. Off while the URL is empty. Lines wait in Library/remote-log-queue.jsonl
 * (bounded, oldest dropped first) so they survive offline spells, relaunches and crashes. Lines are
 * ASCII (non-ASCII escaped as \uXXXX): a length is a UTF-8 byte count, so a batch stays under the
 * sink's 1 MB body cap, and a write torn by a crash cannot leave the file undecodable.
 * Main isolate only: workers' console output is not forwarded (their error reports are).
 *
 * Never-silent exception (tests/never-silent.test.cjs): nothing here calls reportError. The error
 * report listener forwards every report through this channel, so reporting a failed send would
 * queue a line about the failure whose send fails in turn. Failures go to the status row instead
 * (noteFailure, remoteLogStatus).
 */
import { Application, File, Http, knownFolders, path as fsPath } from '@nativescript/core'
import { appBuild, onErrorReport } from './error-reports'
import { guardCallback } from './callback-errors.ios'
import { kotlinListener } from './kotlin-listener.ios'

export type RemoteLogStatus = {
  on: boolean; sending: boolean; sent: number; queued: number; dropped: number
  lastError: string; lastErrorAt: string; lastSuccessAt: string; retryInMs: number
}

const FILE_NAME = 'remote-log-queue.jsonl'
/** Sent every TICK_MS, or once SEND_AT lines wait; a backlog goes out up to BATCH_LINES at a time. */
const TICK_MS = 2_000, SEND_AT = 50, BATCH_LINES = 500, BATCH_CHARS = 512_000, MAX_BACKOFF_MS = 60_000, TIMEOUT_MS = 15_000
const MAX_LINES = 5_000, MAX_CHARS = 2_000_000, MAX_LINE = 32_000, MIN_SECRET = 8, REFRESH_MS = 1_000
/** Past a cap the queue drops to this share of it, so a full queue is not rewritten for every line. */
const DROP_TO = 0.9
/** Console tags whose lines are already forwarded where they are made (in release builds too, which strip console calls). */
const FORWARDED = new Set(['error-report', 'ios-ble'])

const session = `${new Date().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
let seq = 0, installed = false, loaded = false
let readUrl = () => '', readSecrets = (): string[] => []
let url = '', secrets: string[] = [], refreshedAt = -Infinity
/** Serialized records, oldest first; the first [inFlight] are being sent. */
let queue: string[] = [], queueChars = 0, inFlight = 0
/** Newest lines not yet appended to the file; [rewrite]: lines left the front, so the file is rewritten. */
let unpersisted = 0, rewrite = false
let timer: ReturnType<typeof setTimeout> | null = null, sending: Promise<void> | null = null, backoffMs = 0, retryAt = 0
let sent = 0, dropped = 0, lastError = '', lastErrorAt = '', lastSuccessAt = ''

const now = () => new Date().getTime()
const filePath = () => fsPath.join(knownFolders.ios.library().path, FILE_NAME)
const tmpPath = () => `${filePath()}.tmp`

/** [url]: the Remote Log URL setting; [secretValues]: every API key or token, never sent. */
export function installRemoteLog(options: { url: () => string; secretValues: () => string[] }): void {
  if (installed) return
  installed = true
  readUrl = options.url; readSecrets = options.secretValues
  onErrorReport(report => {
    // Counts 1, 2, 4, 8..., as error-reports logs them: an error every frame must not flood the channel.
    if (report.count & (report.count - 1)) return
    remoteLog('error-report', 'error', `${report.source}: ${report.message}`, { stack: report.stack, context: report.context, count: report.count, at: report.at })
  })
  Application.on(Application.suspendEvent, flushInBackground)
  Application.on(Application.exitEvent, persist)
  // Objective-C callers of FaceclawLog (speech, model loads); the JS callers forward their own lines.
  if (typeof FaceclawLog !== 'undefined') FaceclawLog.setSink(line => guardCallback('remote log native line', () => remoteLog('native', 'info', line ?? '')))
  refresh()
  // Last: a console that cannot be replaced must not cost the rest.
  hookConsole()
}

/** Queue one record (no-op while off). Never throws. */
export function remoteLog(source: string, level: string, msg: string, data?: unknown): void {
  if (refresh()) enqueue(source, level, msg, data)
}

/** Re-read the URL now (just edited) and send whatever is queued without waiting out a retry delay. */
export function flushRemoteLog(): void {
  refreshedAt = -Infinity
  if (!refresh()) return
  backoffMs = 0; retryAt = 0
  reschedule(0)
}

export function sendRemoteLogTest(): void {
  remoteLog('remote-log', 'info', 'test line from Settings > General > Developer', { at: new Date().toISOString() })
  flushRemoteLog()
}

export function remoteLogStatus(): RemoteLogStatus {
  refresh()
  return { on: !!url, sending: !!sending, sent, queued: queue.length, dropped, lastError, lastErrorAt, lastSuccessAt, retryInMs: Math.max(0, retryAt - now()) }
}

/** Every catch here ends in this, never in reportError (see the top of the file). */
function noteFailure(where: string, error: unknown): void {
  const message = (error as { message?: unknown } | null)?.message
  lastError = `${where}: ${typeof message === 'string' ? message : String(error)}`.slice(0, 300)
  lastErrorAt = new Date().toISOString()
}

/** Re-reads the URL and secrets at most once a second; true while on. */
function refresh(): boolean {
  if (now() - refreshedAt < REFRESH_MS) return !!url
  refreshedAt = now()
  const was = url
  try {
    url = readUrl().trim().replace(/\/+$/, '')
    // Raw and JSON-escaped: a password can hold a quote or a backslash, and a line is scrubbed as JSON.
    secrets = url ? [...new Set(readSecrets().filter(value => value.length >= MIN_SECRET).flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))] : []
  } catch (error) { url = ''; noteFailure('reading settings', error) }
  if (url && !was) turnedOn()
  if (!!url !== !!was) listenToKotlin(!!url)
  return !!url
}

/** FaceclawKit's PlatformLog lines (the glasses session core): only while on, since each costs a main-queue hop. */
let kotlinLog: FaceclawKitIosLogListener | null = null
function listenToKotlin(on: boolean): void {
  if (typeof FaceclawKitIosLogSink === 'undefined') return
  try {
    if (on) kotlinLog ??= kotlinListener(FaceclawKitIosLogListener, { onLogLine_: line => guardCallback('remote log kotlin line', () => remoteLog('kotlin', 'info', line ?? '')) })
    FaceclawKitIosLogSink.shared.listener = on ? kotlinLog : null
  } catch (error) { noteFailure('kotlin log', error) }
}

function turnedOn(): void {
  if (!loaded) load()
  const device = typeof UIDevice !== 'undefined' ? UIDevice.currentDevice : null
  enqueue('remote-log', 'info', 'session start', { build: appBuild(), ios: device?.systemVersion, model: device?.model, session })
}

function scrub(text: string): string {
  for (const secret of secrets) if (text.includes(secret)) text = text.split(secret).join('[redacted]')
  return text
}

function enqueue(source: string, level: string, msg: string, data?: unknown): void {
  try {
    const record: Record<string, unknown> = { ts: new Date().toISOString(), seq: ++seq, session, build: appBuild(), source, level, msg: String(msg) }
    if (data !== undefined) record.data = data
    let line = scrub(JSON.stringify(record))
    if (line.length > MAX_LINE) {
      // Scrubbed before the cut, so a secret across it cannot leave its start in clear.
      record.msg = scrub(String(msg)).slice(0, MAX_LINE / 2)
      if (data !== undefined) record.data = scrub(JSON.stringify(data)).slice(0, MAX_LINE / 2)
      record.truncated = line.length
      line = scrub(JSON.stringify(record))
    }
    line = ascii(line)
    queue.push(line); queueChars += line.length + 1; unpersisted++
    if (queue.length > MAX_LINES || queueChars > MAX_CHARS) dropOldest()
    if (queue.length - inFlight >= SEND_AT && !sending && now() >= retryAt) reschedule(0)
    else schedule(TICK_MS)
    // An error is often what comes right before a crash: on disk now, not at the next tick.
    if (level === 'error') persist()
  } catch (error) { noteFailure('queueing a line', error) }
}

/** Non-ASCII as \uXXXX: still the same JSON, one byte per char (lone surrogates are escaped already). */
function ascii(line: string): string {
  return line.replace(/[\u0080-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function dropOldest(): void {
  let count = 0
  while (count < queue.length - 1 && (queue.length - count > MAX_LINES * DROP_TO || queueChars > MAX_CHARS * DROP_TO)) queueChars -= queue[count++]!.length + 1
  queue.splice(0, count)
  dropped += count
  inFlight = Math.max(0, inFlight - count)
  unpersisted = Math.min(unpersisted, queue.length)
  rewrite = true
}

function load(): void {
  loaded = true
  // The file is missing or holds a subset of the queue: write it whole next time (append needs a file).
  rewrite = true
  try {
    if (!File.exists(filePath())) return
    const text: unknown = File.fromPath(filePath()).readTextSync(error => { throw error })
    // A crash mid-append leaves a torn last line: keep only whole records.
    const lines = typeof text === 'string' ? text.split('\n').filter(isRecord) : []
    queue = [...lines, ...queue]
    queueChars = queue.reduce((sum, line) => sum + line.length + 1, 0)
    if (queue.length > MAX_LINES || queueChars > MAX_CHARS) dropOldest()
  } catch (error) { noteFailure('reading the queue', error) }
}

function isRecord(line: string): boolean {
  if (!line.startsWith('{') || !line.endsWith('}')) return false
  try { JSON.parse(line); return true } catch (error) { noteFailure('a torn queue line', error); return false }
}

function persist(): void {
  if (!rewrite && !unpersisted) return
  try {
    const fail = (error: unknown) => { throw error }
    if (rewrite) {
      // As error-reports.ts saves: a crash mid-rewrite leaves the old file, not half of the new one.
      File.fromPath(tmpPath()).writeTextSync(queue.length ? queue.join('\n') + '\n' : '', fail)
      if (File.exists(filePath())) File.fromPath(filePath()).removeSync(fail)
      File.fromPath(tmpPath()).renameSync(FILE_NAME, fail)
    } else File.fromPath(filePath()).appendTextSync(queue.slice(-unpersisted).join('\n') + '\n', fail)
    rewrite = false; unpersisted = 0
  } catch (error) { noteFailure('saving the queue', error) }
}

function schedule(delayMs: number): void {
  if (timer === null) timer = setTimeout(tick, Math.max(delayMs, retryAt - now()))
}

function reschedule(delayMs: number): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  schedule(delayMs)
}

function tick(): void {
  timer = null
  persist()
  // Off: the queue stays on disk until a URL is set again. Sending: its end schedules the next.
  if (!refresh() || sending || !queue.length) return
  if (now() < retryAt) schedule(TICK_MS)
  else void send()
}

function send(): Promise<void> {
  let chars = 0
  inFlight = 0
  while (inFlight < Math.min(BATCH_LINES, queue.length) && (inFlight === 0 || chars + queue[inFlight]!.length < BATCH_CHARS)) chars += queue[inFlight++]!.length + 1
  const content = `[${queue.slice(0, inFlight).join(',')}]`
  return sending = Http.request({ url: `${url}/log`, method: 'POST', headers: { 'Content-Type': 'application/json' }, content, timeout: TIMEOUT_MS })
    .then(response => {
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${response.statusCode}`)
      for (const line of queue.splice(0, inFlight)) queueChars -= line.length + 1
      unpersisted = Math.min(unpersisted, queue.length)
      sent += inFlight; rewrite = true
      backoffMs = 0; retryAt = 0
      lastSuccessAt = new Date().toISOString()
    })
    .catch((error: unknown) => {
      noteFailure('sending', error)
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs ? backoffMs * 2 : TICK_MS)
      retryAt = now() + backoffMs
    })
    .then(() => {
      sending = null; inFlight = 0
      persist()
      if (queue.length) schedule(queue.length >= SEND_AT ? 0 : TICK_MS)
    })
}

/** Going to the background: save the queue and send it while iOS allows (a short background task). */
function flushInBackground(): void {
  persist()
  if (!refresh() || !(sending || queue.length) || typeof UIApplication === 'undefined') return
  const app = UIApplication.sharedApplication
  let task = UIBackgroundTaskInvalid
  const end = () => { if (task !== UIBackgroundTaskInvalid) app.endBackgroundTask(task); task = UIBackgroundTaskInvalid }
  task = app.beginBackgroundTaskWithExpirationHandler(() => guardCallback('remote log background task', end))
  if (timer !== null) clearTimeout(timer)
  timer = null
  // A send already under way is waited for, not doubled.
  void (sending ?? send()).then(end)
}

function hookConsole(): void {
  let forwarding = false
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level]
    console[level] = (...args: unknown[]) => {
      original.apply(console, args)
      // Off is one cached check; a line logged while forwarding one (core logging from a send) is skipped.
      if (forwarding || !refresh()) return
      forwarding = true
      try { forwardConsole(level, args) } catch (error) { noteFailure('console', error) } finally { forwarding = false }
    }
  }
}

function forwardConsole(level: string, args: unknown[]): void {
  const text = args.map(arg => {
    if (typeof arg === 'string') return arg
    if (arg instanceof Error) return arg.stack || String(arg)
    try { return JSON.stringify(arg) ?? String(arg) } catch { return String(arg) }
  }).join(' ')
  // "[tag] ...": the tag is the source.
  const tag = /^\[([\w.-]+)\] /.exec(text)
  if (tag && FORWARDED.has(tag[1]!)) return
  enqueue(tag ? tag[1]! : 'console', level, tag ? text.slice(tag[0].length) : text)
}
