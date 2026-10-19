import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { ListenLayer } from "./listen-layer";
import { listenSession } from "./listen-session";

export const TRANSLATE_WINDOW_ID = "translate";
export const TRANSLATE_SURFACE_ID = "window:translate";

/** Listen starts with the window and stops when it closes. */
export function createTranslateAppWindow(options: InProcessAppOptions): InProcessWindow {
  const layer = new ListenLayer();
  const app = createInProcessWindow({
    appId: "translate",
    windowId: TRANSLATE_WINDOW_ID,
    title: "Translate",
    iconLetter: "Tr",
    icon: "message-circle",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    // Captions are read, not touched: keep the lens awake while listening.
    keepsScreenOn: () => listenSession.state.status === "listening",
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.onRemoved();
      listenSession.stop();
      options.onClosed();
    },
  });
  layer.start(app.requestRender);
  void listenSession.start();
  return app;
}
