/** NLLanguageRecognizer is iOS-only (language-id.ios.ts); elsewhere the picker scores by confidence alone. */
export function scorePair(_text: string, _langs: [string, string]): Record<string, number> {
  return {};
}
