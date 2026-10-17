import {
  anthropicApiKeySetting,
  appSwitcherPositionSetting,
  assistantAllowProactiveSetting,
  assistantBackendSetting,
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
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
  firmwareDebugFlagsSetting,
  glassesBatteryVisibilitySetting,
  lockScreenEnabledSetting,
  mapboxApiKeySetting,
  menuAnimationSetting,
  mirrorTouchSetting,
  openAiApiKeySetting,
  phoneBatteryVisibilitySetting,
  previewColorSetting,
  previewScalingSetting,
  ringConnectionModeSetting,
  saveVoiceRecordingsSetting,
  screenFadeSetting,
  screenTimeoutSetting,
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
import { shell } from "../shell/shell";
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
import { mediaControllerBridge } from "../../native/media-controller";

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
      /** The phone row's title when phoneTitle has none (settings with generated ids). */
      title?: string;
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

/**
 * Phone row titles, by setting id. The labels stay sentence case for the
 * glasses menus; iOS Settings rows are Title Case. No text-transform: it
 * would turn "BLE" into "Ble".
 */
const PHONE_TITLES: Record<string, string> = {
  autoBrightnessMin: "Minimum",
  autoBrightnessMax: "Maximum",
  autoBrightnessCurve: "Light Curve",
  "display-mode": "Display Mode",
  "lock-screen-enabled": "Lock Screen",
  "screen-timeout": "Screen Timeout",
  "glanceboard-tap-duration": "Show on Tap",
  "glanceboard-show-on-long-press": "Show on Long Press",
  "glanceboard-show-on-head-tilt": "Show on Head Tilt",
  "glanceboard-show-lines": "Show Lines",
  "app-switcher-position": "App Switcher Position",
  "status-bar-position": "Status Bar Position",
  "status-bar-visibility": "Status Bar Visibility",
  "window-border": "Window Border",
  timeFormat: "Time Format",
  glassesBatteryVisibility: "Glasses",
  "menu-animation": "Menu Animation",
  "screen-fade": "Screen Fade",
  "preview-color": "Mirror Color",
  "preview-scaling": "Mirror Scaling",
  "mirror-touch": "Touch Mirror",
  "wake-word-action": "Wake Word",
  "voice-provider": "Transcription Provider",
  "assistant-backend": "Assistant Backend",
  "assistant-model": "Assistant Model",
  "assistant-skip-confirmation": "Send Without Confirming",
  "assistant-bridge-host": "Host",
  "assistant-bridge-port": "Port",
  "assistant-bridge-token": "Token",
  "assistant-allow-proactive": "Proactive Actions",
  "elevenlabs-api-key": "ElevenLabs API Key",
  "openai-api-key": "OpenAI API Key",
  "soniox-api-key": "Soniox API Key",
  "anthropic-api-key": "Anthropic API Key",
  "mapbox-api-key": "Mapbox Token",
  "data-collection": dataCollectionSetting.label.replace(/ statistics$/, " Statistics"),
  "show-ble-bandwidth": "Show BLE Bandwidth Usage",
  "ring-connection-mode": "Ring Connection",
  "save-voice-recordings": "Save Voice Recordings",
  "firmware-debug-flags": "Firmware Debug Flags",
};

export const phoneTitle = (setting: CatalogSetting): string => PHONE_TITLES[setting.id] ?? setting.label;
export const itemTitle = (entry: Extract<CatalogItem, { kind: "setting" }>): string => entry.title ?? phoneTitle(entry.setting);

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
    title: setting.label.replace(/ \w/g, (initial) => initial.toUpperCase()),
    // Each widget appears once per board, as the glasses slot picker enforces.
    onChange: (value) => {
      clearConflictingSlots(layout, index, value as GlanceSlotChoice);
      // Choosing the Music widget is the phone-side moment to ask for Apple Music access.
      if (value === "music") mediaControllerBridge.openNotificationAccessSettings();
    },
  }));
}

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    id: "display",
    title: "Display & Brightness",
    sections: () => [
      { items: [item(brightnessSetting)] },
      {
        header: "Auto-Brightness",
        footer: "The minimum, maximum and ambient-light curve that Auto-Brightness uses.",
        items: [item(autoBrightnessMinSetting), item(autoBrightnessMaxSetting), item(autoBrightnessCurveSetting)],
      },
      {
        items: [
          item(displayLayoutSetting),
          // As the glasses menu: a new timeout counts from now, not from the last input.
          { kind: "setting", setting: screenTimeoutSetting, onChange: () => shell.noteUserActivity() },
          item(lockScreenEnabledSetting),
        ],
      },
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
      {
        header: "Agent Bridge",
        footer: assistantBridgeHostSetting.description,
        items: [item(assistantBridgeHostSetting), item(assistantBridgePortSetting), item(assistantBridgeTokenSetting), item(assistantAllowProactiveSetting)],
      },
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
      // The shared summary names the glasses row ("TestFlight privacy"); the phone row is Title Case.
      { footer: dataCollectionSetting.description?.replace("TestFlight privacy", "TestFlight Privacy"), items: [item(dataCollectionSetting)] },
      { items: [{ kind: "ios-privacy-notice" }, { kind: "document", fileName: "PRIVACY", title: "Privacy Policy" }] },
    ],
  },
  {
    id: "developer",
    title: "Developer",
    sections: () => [
      { footer: ringConnectionModeSetting.description, items: [item(ringConnectionModeSetting)] },
      { footer: saveVoiceRecordingsSetting.description, items: [item(saveVoiceRecordingsSetting)] },
      { footer: firmwareDebugFlagsSetting.description, items: [item(firmwareDebugFlagsSetting)] },
      { footer: showBleBandwidthSetting.description, items: [item(showBleBandwidthSetting)] },
    ],
  },
];

export function settingsCategory(id: string | undefined): SettingsCategory | null {
  return SETTINGS_CATEGORIES.find((category) => category.id === id) ?? null;
}
