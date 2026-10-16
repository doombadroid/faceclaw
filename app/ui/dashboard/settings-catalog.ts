import {
  anthropicApiKeySetting,
  appSwitcherPositionSetting,
  assistantBackendSetting,
  assistantModelSetting,
  assistantSkipConfirmationSetting,
  autoBrightnessCurveSetting,
  autoBrightnessMaxSetting,
  autoBrightnessMinSetting,
  batteryDisplayModeSetting,
  brightnessSetting,
  dataCollectionSetting,
  displayLayoutSetting,
  elevenLabsApiKeySetting,
  glassesBatteryVisibilitySetting,
  lockScreenEnabledSetting,
  mapboxApiKeySetting,
  menuAnimationSetting,
  mirrorTouchSetting,
  openAiApiKeySetting,
  phoneBatteryVisibilitySetting,
  previewColorSetting,
  previewScalingSetting,
  screenFadeSetting,
  showBleBandwidthSetting,
  sonioxApiKeySetting,
  statusBarPositionSetting,
  statusBarVisibilitySetting,
  timeFormatSetting,
  uiDepthSetting,
  voiceProviderSetting,
  wakeWordActionSetting,
  windowBorderSetting,
  type ConfigSettingBoolean,
  type ConfigSettingEnum,
  type ConfigSettingString,
} from "../dashboard-settings";
import {
  clearConflictingSlots,
  glanceboardEnabledSetting,
  glanceDepthSetting,
  glanceLayout,
  glanceLayoutSetting,
  glanceShowLinesSetting,
  glanceShowOnHeadTiltSetting,
  glanceShowOnLongPressSetting,
  glanceSlotSettings,
  glanceTapDurationSetting,
  type GlanceSlotChoice,
} from "../../apps/glanceboard/glanceboard-settings";
import { iosAppUnavailableReason } from "../../apps/ios-availability";

/**
 * The iPhone Settings tab's catalog: the same ConfigSetting objects the
 * glasses Settings app lists (settings-menus.ts, after its iOS filter),
 * plus the Glanceboard app's own Settings (glanceboard-app.ts), regrouped
 * into phone categories. tests/ios-ocusmart-settings.test.cjs walks both
 * glasses menus and fails when either disagrees with this file, so a setting
 * added there must land here (or in the test's list of iOS-inert settings).
 *
 * Left out on purpose: settings no iOS code reads (phone rotation, watch and
 * ring battery indicators), and the glasses-only composite pickers (UI font,
 * per-widget Glanceboard settings), which stay on the glasses.
 */

export type CatalogSetting = ConfigSettingBoolean | ConfigSettingEnum<string> | ConfigSettingString;

export type CatalogItem =
  | {
      kind: "setting";
      setting: CatalogSetting;
      /** Runs after an enum choice is saved (the glasses menu's onChange). */
      onChange?: (value: string) => void;
      /** Why a value cannot be chosen on iOS, or null. */
      unavailable?: (value: string) => string | null;
    }
  /** Rows backed by stores other than a ConfigSetting; the phone page draws them. */
  | { kind: "notification-sources" | "input-tokens" | "ios-privacy-notice" }
  | { kind: "document"; fileName: string; title: string };

export type CatalogSection = { header?: string; footer?: string; items: CatalogItem[] };

export type SettingsCategory = {
  /** Stable: other tabs link to categories by id. */
  id: string;
  title: string;
  /** Re-read on every render: rows follow other settings (app switcher position, Glanceboard layout). */
  sections(): CatalogSection[];
};

const item = (setting: CatalogSetting): CatalogItem => ({ kind: "setting", setting });

// Mirrors customizationRows() in settings-menus.ts: depth and status bar
// only exist with a bottom or popup switcher, visibility and border only with
// the popup.
function switcherItems(): CatalogItem[] {
  const position = appSwitcherPositionSetting.get();
  const settings: CatalogSetting[] = [appSwitcherPositionSetting];
  if (position === "bottom" || position === "popup") settings.push(uiDepthSetting, statusBarPositionSetting);
  if (position === "popup") settings.push(statusBarVisibilitySetting, windowBorderSetting);
  return [...settings, timeFormatSetting].map(item);
}

function glanceSlotItems(): CatalogItem[] {
  const layout = glanceLayout();
  return glanceSlotSettings(layout).map((setting, index): CatalogItem => ({
    kind: "setting",
    setting,
    // Each widget appears once per board, as the glasses slot picker enforces.
    onChange: (value) => clearConflictingSlots(layout, index, value as GlanceSlotChoice),
    unavailable: (value) => iosAppUnavailableReason(value),
  }));
}

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    id: "display",
    title: "Display & Brightness",
    sections: () => [
      { items: [item(brightnessSetting)] },
      {
        header: "Auto-brightness",
        footer: "The minimum, maximum and ambient-light curve that Auto brightness uses.",
        items: [item(autoBrightnessMinSetting), item(autoBrightnessMaxSetting), item(autoBrightnessCurveSetting)],
      },
      { items: [item(displayLayoutSetting), item(lockScreenEnabledSetting)] },
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    sections: () => [{ items: [{ kind: "notification-sources" }] }],
  },
  {
    id: "glanceboard",
    title: "Glanceboard",
    sections: () => [
      { footer: glanceboardEnabledSetting.description, items: [item(glanceboardEnabledSetting)] },
      {
        header: "Board",
        items: [
          item(glanceLayoutSetting),
          item(glanceTapDurationSetting),
          item(glanceShowOnLongPressSetting),
          item(glanceShowOnHeadTiltSetting),
          item(glanceShowLinesSetting),
          item(glanceDepthSetting),
        ],
      },
      {
        header: "Slots",
        footer: "The Glanceboard font and each widget's own settings are on the glasses, in the Glanceboard app's Settings.",
        items: glanceSlotItems(),
      },
    ],
  },
  {
    id: "customization",
    title: "Customization",
    sections: () => [
      {
        header: "Layout",
        footer: "The UI font is chosen on the glasses, in Settings > Customization.",
        items: switcherItems(),
      },
      {
        header: "Battery indicators",
        items: [item(batteryDisplayModeSetting), item(phoneBatteryVisibilitySetting), item(glassesBatteryVisibilitySetting)],
      },
      { header: "Animations", items: [item(menuAnimationSetting), item(screenFadeSetting)] },
    ],
  },
  {
    id: "phone-display",
    title: "Phone Display",
    sections: () => [{
      footer: mirrorTouchSetting.description,
      items: [item(previewColorSetting), item(previewScalingSetting), item(mirrorTouchSetting)],
    }],
  },
  {
    id: "voice",
    title: "Voice & Assistant",
    sections: () => [
      { header: "Voice", items: [item(wakeWordActionSetting), item(voiceProviderSetting)] },
      { header: "Assistant", items: [item(assistantBackendSetting), item(assistantModelSetting), item(assistantSkipConfirmationSetting)] },
    ],
  },
  {
    id: "api-keys",
    title: "API Keys",
    sections: () => [
      {
        items: [
          item(elevenLabsApiKeySetting),
          item(openAiApiKeySetting),
          item(sonioxApiKeySetting),
          item(anthropicApiKeySetting),
          item(mapboxApiKeySetting),
        ],
      },
      {
        header: "Input tokens",
        footer: "Allow another app to provide ring/watch input, type into the foreground window, or send messages to the voice assistant. Each token has its own permissions and can be revoked here.",
        items: [{ kind: "input-tokens" }],
      },
    ],
  },
  {
    id: "privacy",
    title: "Privacy",
    sections: () => [
      { footer: dataCollectionSetting.description, items: [item(dataCollectionSetting)] },
      { items: [{ kind: "ios-privacy-notice" }, { kind: "document", fileName: "PRIVACY", title: "Privacy Policy" }] },
    ],
  },
  {
    id: "developer",
    title: "Developer",
    sections: () => [{ footer: showBleBandwidthSetting.description, items: [item(showBleBandwidthSetting)] }],
  },
];

export function settingsCategory(id: string | undefined): SettingsCategory | null {
  return SETTINGS_CATEGORIES.find((category) => category.id === id) ?? null;
}
