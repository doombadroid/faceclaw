import { iosBluetooth } from "../native/ios-bluetooth";
import { Application, Dialogs, EventData, Frame, Observable, Utils, View } from "@nativescript/core";
import { APP_NAME } from "../branding";

import {
  hasBlePermissions,
  hasFineLocationPermission,
  hasMicrophonePermission,
  hasPostNotificationsPermission,
  requestBlePermissions,
  requestMicrophonePermission,
  requestPostNotificationsPermission,
} from "../g2/android-permissions";
import { hasPhoneAlertPermission, refreshPhoneAlertPermission, requestPhoneAlertPermission } from "../native/alarms";
import { ensureCalendarPermission, hasCalendarPermission } from "../native/calendar-permissions";
import { ensureFineLocationPermission, hasLocationPermission } from "../native/location-permissions";
import { isIgnoringBatteryOptimizations, requestIgnoreBatteryOptimizations } from "../native/battery-optimization";
import { hasAllFilesAccess, requestAllFilesAccess } from "../native/file-access";
import { isNotificationListenerEnabled, requestNotificationListenerAccess } from "../native/notification-access";

type PermissionDefinition = {
  id: string;
  title: string;
  description: string;
  optional: boolean;
  isGranted: () => boolean;
  /** Show the grant UI: a runtime-permission dialog or a system settings screen. */
  request: () => void | Promise<unknown>;
};

/**
 * Battery Optimization, Read Notifications and All Files Access are not
 * runtime permissions: their request() opens a system screen, so the granted
 * state can only be re-checked when the app resumes (the page refreshes on
 * Application.resume).
 */
const ANDROID_PERMISSIONS: PermissionDefinition[] = [
  {
    id: "nearby-devices",
    title: "Nearby Devices",
    description: "Needed to communicate with your smart glasses over Bluetooth.",
    optional: false,
    isGranted: hasBlePermissions,
    request: requestBlePermissions,
  },
  {
    id: "post-notifications",
    title: "Send Notifications",
    description: "A notification will be pinned, to keep Faceclaw running while your phone screen is off.",
    optional: false,
    isGranted: hasPostNotificationsPermission,
    request: requestPostNotificationsPermission,
  },
  {
    id: "battery-optimization",
    title: "Battery Optimization",
    description: "Needed to keep running while your phone screen is off.",
    optional: false,
    isGranted: isIgnoringBatteryOptimizations,
    request: requestIgnoreBatteryOptimizations,
  },
  {
    id: "read-notifications",
    title: "Read Notifications",
    description: "Needed to display your Android notifications on the glasses.",
    optional: true,
    isGranted: isNotificationListenerEnabled,
    request: requestNotificationListenerAccess,
  },
  {
    id: "microphone",
    title: "Microphone",
    description: "Needed to use voice input.",
    optional: true,
    isGranted: hasMicrophonePermission,
    request: requestMicrophonePermission,
  },
  {
    id: "location",
    title: "Location",
    description: "Needed to use location-based features like navigation inside glasses apps.",
    optional: true,
    // Navigation needs precise fixes, so the checkmark tracks fine location;
    // "approximate only" leaves the card unchecked and re-tappable.
    isGranted: hasFineLocationPermission,
    request: ensureFineLocationPermission,
  },
  {
    id: "calendar",
    title: "Calendar",
    description: "Needed to display your calendar on the glasses.",
    optional: true,
    isGranted: hasCalendarPermission,
    request: ensureCalendarPermission,
  },
  {
    id: "all-files-access",
    title: "All Files Access",
    description: "Needed to browse and view files in the Files app on the glasses.",
    optional: true,
    isGranted: hasAllFilesAccess,
    request: requestAllFilesAccess,
  },
];


/** iOS prompts only once; after a denial the switch is on the app's Settings page. */
async function openIosSettings(title: string): Promise<void> {
  const open = await Dialogs.confirm({
    title: `${title} Access`,
    message: `Allow ${title} for ${APP_NAME} in iPhone Settings.`,
    okButtonText: "Open Settings",
    cancelButtonText: "Cancel",
  });
  if (open) Utils.openUrl("app-settings:");
}

/** AVAuthorizationStatus / SFSpeechRecognizerAuthorizationStatus: 0 not asked yet, 3 authorized. */
function iosStatusPermission(id: string, title: string, description: string, status: () => number, ask: (done: (status: number) => void) => void): PermissionDefinition {
  return {
    id, title, description, optional: true,
    isGranted: () => status() === 3,
    request: () => (status() === 0 ? new Promise<number>(ask) : openIosSettings(title)),
  };
}

/** CLAuthorizationStatus 1 restricted, 2 denied. */
function iosLocationBlocked(): boolean {
  const status = Number(CLLocationManager.new().authorizationStatus);
  return status === 1 || status === 2;
}

const PERMISSIONS: PermissionDefinition[] = global.isIOS ? [{
  id: "nearby-devices", title: "Nearby Devices",
  description: "Needed to communicate with your smart glasses over Bluetooth.", optional: false,
  isGranted: () => iosBluetooth().state === 5,
  request: () => iosBluetooth().ensureReady(),
}, {
  id: "post-notifications", title: "Notifications",
  description: "Optional: phone alerts for timers and alarms when the glasses cannot show them.", optional: true,
  isGranted: hasPhoneAlertPermission,
  request: requestPhoneAlertPermission,
},
iosStatusPermission("microphone", "Microphone", "Optional: voice input from the iPhone microphone when the glasses are not connected.",
  () => FaceclawSpeech.microphoneAuthorizationStatus(), (done) => FaceclawSpeech.requestMicrophoneAuthorization(done)),
iosStatusPermission("speech-recognition", "Speech Recognition", "Optional: on-device Apple transcription for voice input.",
  () => FaceclawSpeech.authorizationStatus(), (done) => FaceclawSpeech.requestAuthorization(done)),
{
  id: "location", title: "Location",
  description: "Optional: navigation, weather and true-north compass on the glasses.", optional: true,
  isGranted: hasLocationPermission,
  request: () => (iosLocationBlocked() ? openIosSettings("Location") : ensureFineLocationPermission()),
}, {
  id: "read-notifications", title: "iPhone Notifications",
  description: "Optional: show iPhone notifications on the glasses.", optional: true,
  isGranted: isNotificationListenerEnabled,
  // No API or deep link reaches this per-device Bluetooth setting.
  request: () => Dialogs.alert({
    title: "iPhone Notifications",
    message: "Open iPhone Settings > Bluetooth, tap (i) next to the right lens, and turn on Share System Notifications.",
    okButtonText: "OK",
  }),
}, {
  id: "calendar", title: "Calendar",
  description: "Optional: display upcoming events in Calendar and Glanceboard on your glasses. Choose Full Access when asked.",
  optional: true,
  isGranted: hasCalendarPermission,
  request: ensureCalendarPermission,
}] : ANDROID_PERMISSIONS;

/** One Repeater card: the permission's copy plus the display-only fields the XML binds. */
export type PermissionCardItem = {
  id: string;
  title: string;
  description: string;
  optionalVisibility: "visible" | "collapse";
  checkVisibility: "visible" | "collapse";
  onCardTap: (args: EventData) => void;
};

/**
 * The Permissions screen: one card per permission Faceclaw uses, with
 * a checkmark when it is already granted and tap-to-grant otherwise. Reached
 * both from onboarding (between the disclaimer and the firmware step) and from
 * the main-screen menu.
 */
export class PermissionsViewModel extends Observable {
  private readonly onboarding: boolean;
  private _cards: PermissionCardItem[] = [];
  private requesting = false;

  constructor(options?: { onboarding?: boolean }) {
    super();
    this.onboarding = options?.onboarding ?? false;
    this.refresh();
  }

  /**
   * Battery Optimization, Read Notifications and All Files Access grant flows
   * leave the app for a system screen; re-check everything whenever the app
   * comes back.
   */
  private readonly onAppResume = (): void => {
    this.refresh();
    // The notification status is only known asynchronously on iOS.
    if (global.isIOS) void refreshPhoneAlertPermission().then(() => this.refresh());
  };

  onPageLoaded(): void {
    Application.on(Application.resumeEvent, this.onAppResume);
    this.onAppResume();
  }

  onPageUnloaded(): void {
    Application.off(Application.resumeEvent, this.onAppResume);
  }

  // --- observable properties -------------------------------------------------

  get actionBarHidden(): boolean {
    return this.onboarding;
  }

  get headlineVisibility(): "visible" | "collapse" {
    return this.onboarding ? "visible" : "collapse";
  }

  get instructions(): string {
    if (global.isIOS) return `${APP_NAME} uses Bluetooth to communicate with your smart glasses; everything else is optional. Tap a card to allow access; a checkmark means it is ready. iOS asks only once, so a card you declined opens Settings.`;
    return this.onboarding
      ? `Faceclaw uses these ${global.isIOS ? "iOS" : "Android"} permissions. Tap a card to grant one; a checkmark means it is already granted. ` +
          "Optional permissions can also be granted later, from the Permissions item in the main-screen menu."
      : "Tap a card to grant a permission; a checkmark means it is already granted.";
  }

  get cards(): PermissionCardItem[] {
    return this._cards;
  }

  get primaryLabel(): string {
    return this.onboarding ? "Continue" : "Done";
  }

  /**
   * Continue looks grayed out (but stays tappable — tapping it asks for
   * confirmation instead) while a required permission is missing. Done, in
   * menu mode, never dims: there is nothing to warn about when closing.
   */
  get primaryClass(): string {
    return this.onboarding && !this.requiredPermissionsGranted()
      ? "-primary permissions-primary-dimmed"
      : "-primary";
  }

  /** Done spans the row once Back is collapsed. */
  get primaryColumn(): number {
    return this.onboarding ? 1 : 0;
  }

  get primaryColumnSpan(): number {
    return this.onboarding ? 1 : 2;
  }

  get secondaryVisibility(): "visible" | "collapse" {
    return this.onboarding ? "visible" : "collapse";
  }

  // --- actions ---------------------------------------------------------------

  // Arrow property: NativeScript fires XML event handlers with `this` bound to
  // the tapped view's bindingContext (the card item), not the view model.
  readonly onCardTap = (args: EventData): void => {
    const item = (args.object as View).bindingContext as PermissionCardItem | undefined;
    if (!item || this.requesting) return;
    const definition = PERMISSIONS.find((permission) => permission.id === item.id);
    if (!definition || definition.isGranted()) return;
    void this.requestPermission(definition);
  };

  async onPrimaryTap(): Promise<void> {
    if (this.onboarding) {
      if (!this.requiredPermissionsGranted()) {
        const proceed = await Dialogs.confirm({
          title: "Missing Permissions",
          message: "You haven't enabled all of the necessary permissions. Are you sure you want to continue?",
          okButtonText: "Continue",
          cancelButtonText: "Go Back",
        });
        if (!proceed) return;
      }
      // Continue the onboarding chain at the Custom Firmware Required step.
      Frame.topmost()?.navigate({
        moduleName: "phone-ui/onboarding-page",
        context: { step: 3 },
      });
      return;
    }
    Frame.topmost()?.goBack();
  }

  onSecondaryTap(): void {
    Frame.topmost()?.goBack();
  }

  // --- rendering -------------------------------------------------------------

  private async requestPermission(definition: PermissionDefinition): Promise<void> {
    this.requesting = true;
    try {
      await definition.request();
    } catch (error) {
      if (global.isIOS) await Dialogs.alert({ title: `${definition.title} Unavailable`, message: String((error as Error).message ?? error), okButtonText: "OK" });
      // A denial simply leaves the card unchecked; the user can tap again.
    } finally {
      this.requesting = false;
      this.refresh();
    }
  }

  private requiredPermissionsGranted(): boolean {
    return PERMISSIONS.every((definition) => definition.optional || definition.isGranted());
  }

  refresh(): void {
    this._cards = PERMISSIONS.map((definition) => ({
      id: definition.id,
      title: definition.title,
      description: definition.description,
      optionalVisibility: definition.optional ? "visible" : "collapse",
      checkVisibility: definition.isGranted() ? "visible" : "collapse",
      onCardTap: this.onCardTap,
    }));
    this.notifyPropertyChange("cards", this._cards);
    this.notifyPropertyChange("primaryClass", this.primaryClass);
  }
}
