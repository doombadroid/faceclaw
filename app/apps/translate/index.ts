import { type AppDefinition } from "../app-definition";
import { createTranslateAppWindow, TRANSLATE_SURFACE_ID, TRANSLATE_WINDOW_ID } from "./translate-app";

/**
 * Translate: a two-way conversation on the lens. Both languages are
 * transcribed on the phone at once, each utterance is attributed to one of
 * them and translated into the other with Apple's Translation framework.
 * The pair and the downloads are set up in the phone app (My Glasses >
 * Translate). iOS only (all-apps.ts).
 */
const translateApp: AppDefinition = {
  appId: "translate",
  title: "Translate",
  icon: "message-circle",
  launch: async (ctx) => {
    await ctx.launchInProcessApp(TRANSLATE_WINDOW_ID, TRANSLATE_SURFACE_ID, (options) => createTranslateAppWindow(options));
  },
};

export default translateApp;
