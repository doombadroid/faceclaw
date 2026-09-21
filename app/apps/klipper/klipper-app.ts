import { klipperAddressSetting, klipperApiKeySetting, textSettingMenuItem } from "../../ui/dashboard-settings";
import { openSettingsSubMenu } from "../../ui/dashboard/settings-panel";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { KlipperLayer, klipperMenuItems } from "./klipper-layer";
import { klipperBridge } from "./klipper-state";

export const KLIPPER_WINDOW_ID = "klipper";
export const KLIPPER_SURFACE_ID = "window:klipper";

/** KlipKommander: status and control for a Klipper 3D printer through Moonraker, LAN only. */
export function createKlipperAppWindow(options: InProcessAppOptions): InProcessWindow {
  let unsubscribe: (() => void) | null = null;
  let app: InProcessWindow;
  app = createInProcessWindow({
    appId: "klipper",
    windowId: KLIPPER_WINDOW_ID,
    title: "KlipKommander",
    iconLetter: "K",
    icon: "printer-3d",
    closeable: true,
    menuItems: () => klipperMenuItems((ctx) => openSettingsSubMenu(ctx, "Printer settings", [
      textSettingMenuItem(klipperAddressSetting),
      textSettingMenuItem(klipperApiKeySetting),
    ])),
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new KlipperLayer(() => app.requestRender())),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    reconfigureSurface: options.reconfigureSurface,
    onClosed: () => {
      unsubscribe?.();
      unsubscribe = null;
      klipperBridge.stop();
      options.onClosed();
    },
  });
  unsubscribe = klipperBridge.onStateChange(() => app.requestRender());
  klipperBridge.start();
  return app;
}
