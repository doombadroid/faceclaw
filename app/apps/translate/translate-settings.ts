import { ConfigSettingEnum } from "../../ui/dashboard-settings";

/**
 * Translate app settings: the conversation pair. "They speak" is the other
 * person's language (the direction a session starts in), "I speak" the
 * wearer's. Ids are BCP 47 and double as NLLanguage and Translation ids.
 */

export const LISTEN_LANGUAGES = [
  { id: "en", name: "English" },
  { id: "es", name: "Spanish" },
  { id: "fr", name: "French" },
  { id: "de", name: "German" },
  { id: "it", name: "Italian" },
  { id: "pt", name: "Portuguese" },
  { id: "ja", name: "Japanese" },
  { id: "ko", name: "Korean" },
  { id: "zh-Hans", name: "Chinese (Simplified)" },
] as const;

export type ListenLanguage = (typeof LISTEN_LANGUAGES)[number]["id"];

const LANGUAGE_IDS: readonly ListenLanguage[] = LISTEN_LANGUAGES.map((language) => language.id);

export function languageName(id: string): string {
  return LISTEN_LANGUAGES.find((language) => language.id === id)?.name ?? id;
}

/** The lens header's short form: "ES", "ZH". */
export function languageCode(id: string): string {
  return (id.split("-")[0] ?? id).toUpperCase();
}

export const translateTheirLanguageSetting = new ConfigSettingEnum<ListenLanguage>({
  id: "translate-their-language",
  label: "They speak",
  description: "The language of the person you are talking to. Listening starts in this direction.",
  storageKey: "translate.their-language",
  defaultValue: "es",
  values: LANGUAGE_IDS,
  formatValue: languageName,
});

export const translateMyLanguageSetting = new ConfigSettingEnum<ListenLanguage>({
  id: "translate-my-language",
  label: "I speak",
  description: "Your language: what they say is translated into it, and what you say is translated into theirs.",
  storageKey: "translate.my-language",
  defaultValue: "en",
  values: LANGUAGE_IDS,
  formatValue: languageName,
});
