import { guardCallback, logJsError } from './callback-errors.ios'
import { toData } from './kotlin-data'
import type { LiveTranscriber, SpeechLocaleStatus, TranscriberEvent } from './live-transcriber'
export type { LiveTranscriber, SpeechLocaleStatus, TranscriberEvent } from './live-transcriber'

// Apple's on-device SpeechAnalyzer + SpeechTranscriber (FaceclawLiveTranscriber.swift). Language ids
// are ours ('es', 'zh-Hans'); the Swift side maps them to the transcriber's locale. Nothing here
// downloads a model except installSpeechLanguage.

export const liveTranscriberAvailable = (): boolean => typeof FaceclawLiveTranscriber !== 'undefined'

/** A completion-style native call that settles once: its answer, or fallback after timeoutMs (never rejects). */
function nativeCall<T>(where: string, timeoutMs: number, fallback: T, start: (done: (value: T) => void) => void): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false
    const settle = (value: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => settle(fallback), timeoutMs)
    try {
      start(value => guardCallback(where, () => settle(value)))
    } catch (error) {
      logJsError(where, error)
      settle(fallback)
    }
  })
}

/** Whether the transcriber supports the language and has its model. Rejects on a timeout or a bad answer, so callers can tell "unknown" from "not supported". */
export function speechLanguageStatus(language: string, timeoutMs = 15_000): Promise<SpeechLocaleStatus> {
  if (!liveTranscriberAvailable()) return Promise.resolve({ supported: false, installed: false, locale: '' })
  return nativeCall<string | null>('live-transcriber.status', timeoutMs, null,
    done => FaceclawLiveTranscriber.statusLanguageCompletion(language, done))
    .then(json => {
      if (!json) throw new Error('speech recognition status timed out')
      const status = JSON.parse(json) as Partial<SpeechLocaleStatus>
      return { supported: status.supported === true, installed: status.installed === true, locale: String(status.locale ?? '') }
    })
}

/** Downloads the language's model: null once installed, else the error ('timeout' after timeoutMs). */
export function installSpeechLanguage(language: string, timeoutMs = 300_000): Promise<string | null> {
  if (!liveTranscriberAvailable()) return Promise.resolve('This build has no live speech recognition.')
  return nativeCall<string | null>('live-transcriber.install', timeoutMs, 'timeout',
    done => FaceclawLiveTranscriber.installLanguageCompletion(language, error => done(error ? String(error) : null)))
}

/**
 * Starts transcribing 16 kHz mono S16LE chunks given to accept(). onEvent gets ready, partials and
 * finals, errors and finally ended (exactly once; nothing follows it). Null when this build has no
 * native transcriber.
 */
export function startLiveTranscriber(language: string, onEvent: (e: TranscriberEvent) => void): LiveTranscriber | null {
  if (!liveTranscriberAvailable()) return null
  let ended = false
  const handle = FaceclawLiveTranscriber.startLanguageEvents(language, json => guardCallback('live-transcriber.event', () => {
    if (ended) return
    const event = JSON.parse(json) as TranscriberEvent
    if (event.kind === 'ended') ended = true
    onEvent(event)
  }))
  if (!(handle > 0)) return null
  return {
    language,
    accept: pcm => { if (!ended && pcm.byteLength >= 2) FaceclawLiveTranscriber.acceptHandlePcm(handle, toData(pcm)) },
    finish: () => { if (!ended) FaceclawLiveTranscriber.finishHandle(handle) },
    cancel: () => { if (!ended) FaceclawLiveTranscriber.cancelHandle(handle) },
  }
}
