// Live on-device speech-to-text (Translate's Listen): Apple's SpeechTranscriber, iOS only
// (live-transcriber.ios.ts). Elsewhere nothing is available.

export interface SpeechLocaleStatus { supported: boolean; installed: boolean; locale: string }
export type TranscriberEvent =
  | { kind: 'ready'; locale: string }
  | { kind: 'partial' | 'final'; text: string; conf: number; start: number; end: number }
  | { kind: 'error'; message: string }
  | { kind: 'ended' }
/** A running transcriber; events stop after { kind: 'ended' }. */
export interface LiveTranscriber { readonly language: string; accept(pcm: Uint8Array): void; finish(): void; cancel(): void }

export const liveTranscriberAvailable = (): boolean => false
export const speechLanguageStatus = (language: string, _timeoutMs?: number): Promise<SpeechLocaleStatus> =>
  Promise.resolve({ supported: false, installed: false, locale: language })
export const installSpeechLanguage = (_language: string, _timeoutMs?: number): Promise<string | null> =>
  Promise.resolve('Live speech recognition needs iOS.')
export const startLiveTranscriber = (_language: string, _onEvent: (e: TranscriberEvent) => void): LiveTranscriber | null => null
