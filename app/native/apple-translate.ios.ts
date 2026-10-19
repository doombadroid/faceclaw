import { guardCallback } from './callback-errors.ios'
// Types only: on iOS './apple-translate' resolves to this file.
import type { PackStatus, TranslateResult } from './apple-translate'
export type { PackStatus, TranslateResult } from './apple-translate'

// Apple's Translation framework through FaceclawTranslate.swift: on-device, lowLatency packs when
// installed, else highFidelity. Every call resolves (an error or a fallback), never rejects, so a
// caption pipeline cannot be broken by a native answer that never comes.

const UNAVAILABLE = 'this build has no FaceclawTranslate (Swift shim)'
const STATUS_TIMEOUT_MS = 15_000
const PACK_STATUSES: readonly string[] = ['installed', 'supported', 'unsupported', 'unknown']

export const appleTranslateAvailable = (): boolean => typeof FaceclawTranslate !== 'undefined'

/**
 * A native completion as a promise of parse(answer), onTimeout() when none comes in timeoutMs, or
 * fallback without the shim. Rejects only when start or parse throws (callers catch that).
 */
function nativeCall<T, R>(where: string, timeoutMs: number, fallback: R, onTimeout: () => R, parse: (value: T) => R,
  start: (done: (value: T) => void) => void): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    if (!appleTranslateAvailable()) return resolve(fallback)
    let settled = false
    const settle = (value: () => R) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { resolve(value()) } catch (error) { reject(error) }
    }
    const timer = setTimeout(() => settle(onTimeout), timeoutMs)
    try {
      start(value => guardCallback(where, () => settle(() => parse(value))))
    } catch (error) {
      settle(() => { throw error })
    }
  })
}

function parseJson<T>(json: string): T | null {
  try { return JSON.parse(json) as T } catch { return null }
}

const packStatus = (value: unknown): PackStatus => (PACK_STATUSES.includes(value as string) ? value as PackStatus : 'unknown')

export function translateText(text: string, source: string, target: string, timeoutMs = 8_000): Promise<TranslateResult> {
  if (!text.trim()) return Promise.resolve({ out: '', ms: 0 })
  const started = Date.now()
  return nativeCall<string, TranslateResult>('apple-translate.translate', timeoutMs, { error: UNAVAILABLE, ms: 0 },
    () => ({ error: 'timeout', ms: Date.now() - started }),
    json => parseJson<TranslateResult>(json) ?? { error: `unreadable answer: ${json}`, ms: Date.now() - started },
    done => FaceclawTranslate.translateTextSourceTargetCompletion(text, source, target, done))
    .catch(error => ({ error: String(error), ms: Date.now() - started }))
}

export function translationStatus(source: string, target: string): Promise<{ lowLatency: PackStatus; highFidelity: PackStatus }> {
  const unknown = { lowLatency: 'unknown', highFidelity: 'unknown' } as const
  return nativeCall<string, { lowLatency: PackStatus; highFidelity: PackStatus }>('apple-translate.status', STATUS_TIMEOUT_MS,
    { lowLatency: 'unsupported', highFidelity: 'unsupported' }, () => unknown,
    json => {
      const status = parseJson<{ lowLatency?: unknown; highFidelity?: unknown }>(json)
      return { lowLatency: packStatus(status?.lowLatency), highFidelity: packStatus(status?.highFidelity) }
    },
    done => FaceclawTranslate.statusSourceTargetCompletion(source, target, done))
    .catch(() => unknown)
}

/**
 * Apple's download sheet for the pair's lowLatency pack: null once done, else the error ('timeout'
 * when it never answered, which happens: always re-check translationStatus afterwards).
 */
export function prepareTranslation(source: string, target: string, timeoutMs = 180_000): Promise<string | null> {
  return nativeCall<string | null, string | null>('apple-translate.prepare', timeoutMs, UNAVAILABLE, () => 'timeout', error => error ?? null,
    done => FaceclawTranslate.prepareSourceTargetCompletion(source, target, done))
    .catch(error => String(error))
}

export function translationLanguages(): Promise<string[]> {
  return nativeCall<string, string[]>('apple-translate.languages', STATUS_TIMEOUT_MS, [], () => [],
    json => parseJson<{ languages?: string[] }>(json)?.languages ?? [],
    done => FaceclawTranslate.supportedLanguages(done))
    .catch(() => [])
}
