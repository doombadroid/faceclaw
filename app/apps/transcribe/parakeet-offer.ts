import { ASR_MODELS, asrModelState, startAsrModelDownload } from "../../native/asr-model";
import { getBooleanSetting, setBooleanSetting } from "../../native/settings-store";
import { voiceProviderSetting } from "../../ui/dashboard-settings";
import type { MenuItem } from "../../ui/menu";

/**
 * iOS: with On-device (Parakeet) chosen (the default) and its model not
 * downloaded, captures use Apple's recognizer. Transcribe says so once and
 * offers the download in its menu; only that tap downloads.
 */
const NOTICE_SHOWN_KEY = "transcribe.parakeetNoticeShown";
const sizeMb = () => Math.round(ASR_MODELS["parakeet-v3"].totalBytes / 1e6);

function offered(): boolean {
  return !!global.isIOS && voiceProviderSetting.get() === "onboard-parakeet" && asrModelState("parakeet-v3").status === "absent";
}

/** The notice the first time it applies (the glasses window, which the phone preview mirrors), else "". */
export function takeParakeetNotice(): string {
  if (!offered() || getBooleanSetting(NOTICE_SHOWN_KEY, false)) return "";
  setBooleanSetting(NOTICE_SHOWN_KEY, true);
  return `Using Apple speech recognition for now. For Parakeet, which stays on the phone, open this app's menu and choose Download Parakeet (${sizeMb()} MB).`;
}

/** The download row while it applies. */
export function parakeetMenuItems(onStarted: () => void): MenuItem[] {
  if (!offered()) return [];
  return [{
    label: `Download Parakeet (${sizeMb()} MB)`,
    onSelect: (ctx) => {
      ctx.stack.pop();
      startAsrModelDownload("parakeet-v3");
      onStarted();
    },
  }];
}
