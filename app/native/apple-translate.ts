// Apple's Translation framework is iOS only (apple-translate.ios.ts); elsewhere nothing translates.

export type PackStatus = 'installed' | 'supported' | 'unsupported' | 'unknown'
export interface TranslateResult { out?: string; error?: string; notInstalled?: boolean; strategy?: 'lowLatency' | 'highFidelity'; ms: number }

const UNAVAILABLE = 'Apple Translation is not available on this phone'

export const appleTranslateAvailable = (): boolean => false
export const translateText = (_text: string, _source: string, _target: string, _timeoutMs?: number): Promise<TranslateResult> =>
  Promise.resolve({ error: UNAVAILABLE, ms: 0 })
export const translationStatus = (_source: string, _target: string): Promise<{ lowLatency: PackStatus; highFidelity: PackStatus }> =>
  Promise.resolve({ lowLatency: 'unsupported', highFidelity: 'unsupported' })
export const prepareTranslation = (_source: string, _target: string, _timeoutMs?: number): Promise<string | null> => Promise.resolve(UNAVAILABLE)
export const translationLanguages = (): Promise<string[]> => Promise.resolve([])
