import { reportError } from "../../native/error-reports";

let recognizer: NLLanguageRecognizer | null = null;

/**
 * NLLanguageRecognizer probabilities for `text`, constrained to the pair (NLLanguage ids are
 * ours: "en", "zh-Hans", ...). Empty for empty text or on failure; unreliable under ~4 words,
 * which the DirectionPicker accounts for.
 */
export function scorePair(text: string, langs: [string, string]): Record<string, number> {
  const scores: Record<string, number> = {};
  if (!text.trim()) return scores;
  try {
    recognizer ??= NLLanguageRecognizer.new();
    recognizer.reset();
    // A JS array marshals to NSArray<NSString>.
    recognizer.languageConstraints = langs as unknown as NSArray<string>;
    recognizer.processString(text);
    const hypotheses = recognizer.languageHypothesesWithMaximum(2);
    const keys = hypotheses.allKeys;
    for (let i = 0; i < keys.count; i++) {
      const key = keys.objectAtIndex(i);
      scores[key] = Number(hypotheses.objectForKey(key));
    }
  } catch (error) {
    reportError("translate.language-id", error);
  }
  return scores;
}
