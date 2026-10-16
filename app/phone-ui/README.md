# Main-screen UI

Android and iOS share `remote-controls.xml`, `remote-controls.css`, and
`RemoteControlsViewModel`: tab order and selection, screen-size choices,
brightness/Auto settings, watch labels, ring markings, and microphone/keyboard
buttons. Import the stylesheet at the top of each platform's application CSS
(before any rules), so the NativeScript CSS pipeline includes it.

Android's `MainViewModel` extends that shared model and connects it to
`dashboardController`. iOS loads the same XML with `Builder.load` and connects
it to `IosPreviewController`. Keep platform-specific transport, page lifecycle,
and navigation in those adapters. Android uses NativeScript gesture events;
iOS feeds raw touches to `PhoneGestureRecognizer`, so the discrete pad gesture
bindings in the XML are Android-only to avoid delivering each gesture twice.

## iOS: the OcuSmart shell (`ios/`)

On iOS the app is named OcuSmart (`app/branding.ts` `APP_NAME`; strings that
name the firmware or protocol keep "Faceclaw"). Instead of one main page it is
a tab bar, built in code:

- `shell.ts`: the root `TabView` with one `Frame` per tab: Glasses
  (`glasses-page.ts`, Remote `remote-page.ts`, `device-page.ts`, `update-page.ts`,
  `firmware-channel-page.ts`), Apps (`apps-page.ts`), Hub (`hub-page.ts`,
  `hub-detail-page.ts`) and Settings (`settings-page.ts`,
  `settings-category-page.ts`, `settings-choice-page.ts`, `about-page.ts`).
  Pages are registered as `ocusmart/*` in `register.ts`. A keyboard session
  the glasses start selects Glasses and pushes Remote, which hosts the old main
  page's mirror, the shared remote controls, the keyboard panel and the BLE
  bandwidth label; under a detour it waits until the detour closes.
- `runtime.ts`: the process's one `IosPreviewController`. Pages subscribe to
  its events and never pause it (TabView unloads hidden tabs); the runtime
  follows app suspend/resume and shows controller errors once.
- `detour.ts`: pairing (`setup-page.ts` first), firmware check, flash, config
  and permissions are the shared Android pages, presented full screen over the
  tab bar and not swipeable. Back on a detour's first page, a navigation to the
  legacy `phone-ui/main-page`, or a `clearHistory` restart closes it.
- `ui-kit.ts` + `kit.css`: grouped-list builders (sections, nav/switch/button/
  value/check rows, tiles) and the light/dark tokens. Page styles import after
  the kit, so a page class on a kit view wins at equal specificity.
  `present.ts` presents UIKit controllers from the topmost one.
  `app-catalog.ts` is the one rule for which apps are launchable (the Apps tab
  lists them, My Glasses counts them) and their tile colours.
- `onboarding.ios.css` restyles the shared device pages to the tokens without
  changing their XML.

Pages show only real data: firmware, battery and warnings come from
`firmware-info.ts` `reportedState` (a live session, or one the firmware check
halted), so nothing stale is shown as current after a disconnect or a flash, and
the shell has no rows or controls that no code backs.

Voice input uses the glasses microphone when connected and the phone's default
audio input in preview mode. The phone path requires both Speech Recognition
and Microphone permissions and stops when the app leaves the foreground;
connected-glasses capture retains its existing background behavior.

The iOS microphone and keyboard image assets are 3x rasterizations of the
Android vector drawables with the same names; regenerate them from those
vectors if the icon designs change.
