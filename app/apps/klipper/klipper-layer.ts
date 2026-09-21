// KlipKommander's interactive layer: the cockpit with a home-menu tab row.
// Lists, the spool page and every confirm are ordinary shell layers pushed on
// top, so back (double-click) and the long-press menus behave like any app.
import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, gestureHints, type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { MenuLayer, TextPageLayer, type MenuItem } from "../../ui/menu";
import { klipperBridge } from "./klipper-state";
import { formatDuration, jobName, paintDashboard } from "./klipper-dashboard";
import { type Job, type Moonraker, type PrintState } from "./moonraker";

type Action = { title: string; detail: string[]; done: string; run: (printer: Moonraker) => Promise<void> };
type HomeItem = { label: string; open?: "jobs" | "preheat" | "spool"; action?: Action };

const TOAST_MS = 4000;

const gcodeAction = (title: string, script: string, done: string): Action =>
  ({ title, detail: [script], done, run: (printer) => printer.gcode(script) });

const HEATERS_OFF = gcodeAction("HEATERS OFF?", "TURN_OFF_HEATERS", "Heaters off");

export class KlipperLayer implements Layer {
  private cursor = 0;
  private toast = "";
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private macros: string[] | null = null;
  /** The armed confirm and the printer state it was armed under. */
  private confirm: { layer: MenuLayer; state: PrintState } | null = null;
  private lastCtx: LayerContext | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly requestRender: () => void) {
    // Never leave a confirm armed across a printer state change: the action it
    // offers may no longer mean what it said.
    this.unsubscribe = klipperBridge.onStateChange(() => {
      const armed = this.confirm;
      if (armed && !this.busy && klipperBridge.snapshot().snap.state !== armed.state) {
        this.confirm = null;
        this.lastCtx?.stack.popIfTop((layer) => layer === armed.layer);
      }
    });
  }

  onRemoved(): void {
    this.unsubscribe();
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
  }

  private homeItems(): HomeItem[] {
    const { snap } = klipperBridge.snapshot();
    const spool: HomeItem = { label: "SPOOL", open: "spool" };
    const name = jobName(snap.filename);
    const cancel: HomeItem = {
      label: "CANCEL",
      action: { title: "CANCEL PRINT?", detail: [name, "This cannot be undone."], done: "Cancelling", run: (p) => p.cancel() },
    };
    if (snap.state === "offline" || snap.state === "error") return [];
    if (snap.state === "printing") {
      return [{ label: "PAUSE", action: { title: "PAUSE PRINT?", detail: [name], done: "Pausing", run: (p) => p.pause() } }, cancel, spool];
    }
    if (snap.state === "paused") {
      return [{ label: "RESUME", action: { title: "RESUME PRINT?", detail: [name], done: "Resuming", run: (p) => p.resume() } }, cancel, spool];
    }
    const items: HomeItem[] = [{ label: "START A JOB", open: "jobs" }, { label: "PREHEAT", open: "preheat" }, spool];
    if (snap.bedTarget > 0 || snap.nozzleTarget > 0) items.push({ label: "HEATERS OFF", action: HEATERS_OFF });
    return items;
  }

  paint(ctx: LayerContext): GrayImage {
    this.lastCtx = ctx;
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const state = klipperBridge.snapshot();
    const items = this.homeItems();
    this.cursor = Math.min(this.cursor, Math.max(0, items.length - 1));
    const notice = state.configurationMissing
      ? "Set the printer address: long-press, then Settings. Use your Moonraker address, or the one you open Mainsail or Fluidd with."
      : state.snap.state === "offline" ? `Printer not reachable. ${state.problem}` : "";
    paintDashboard(image, { small: getDefaultSmallFont(), medium: getDefaultMediumFont(), large: getDefaultLargeFont() }, {
      snap: state.snap,
      notice,
      tabs: items.map((item) => item.label),
      cursor: this.cursor,
      footer: this.toast || (items.length
        ? gestureHints([[GESTURE_SCROLL, "select"], [GESTURE_CLICK, "open"], [GESTURE_DOUBLE_CLICK, "exit"]])
        : ""),
      focused: ctx.stack.isFocused(),
    });
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    this.lastCtx = ctx;
    const items = this.homeItems();
    if (!items.length) {
      if (event.type === "click") await klipperBridge.refreshNow();
      return;
    }
    if (event.type === "scroll-up") this.cursor = (this.cursor + items.length - 1) % items.length;
    else if (event.type === "scroll-down") this.cursor = (this.cursor + 1) % items.length;
    else if (event.type === "click") await this.open(items[this.cursor]!, ctx);
  }

  private async open(item: HomeItem, ctx: LayerContext): Promise<void> {
    const printer = klipperBridge.client();
    if (!printer || this.busy) return;
    if (item.action) return this.askConfirm(ctx, item.action);
    try {
      if (item.open === "jobs") this.pushList(ctx, "START A JOB", await this.jobItems(printer), "No gcode files on the printer.");
      else if (item.open === "preheat") this.pushList(ctx, "PREHEAT", await this.preheatItems(printer), "Nothing available.");
      else if (item.open === "spool") ctx.stack.push(new TextPageLayer("SPOOL", await this.spoolText(printer)));
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : String(error));
    }
  }

  private pushList(ctx: LayerContext, title: string, items: MenuItem[], empty: string): void {
    const { width, height } = ctx.stack.getBaseSize();
    const rows = items.length ? items : [{ label: empty, disabled: true, onSelect: () => {} }];
    ctx.stack.push(new MenuLayer(title, rows, { x: 12, y: 8, width: width - 24, minHeight: height - 16, maxHeight: height - 16, opaque: true }));
  }

  private async jobItems(printer: Moonraker): Promise<MenuItem[]> {
    const jobs = await printer.jobs();
    return jobs.map((job: Job) => ({
      label: jobName(job.path),
      onSelect: async (ctx: LayerContext) => {
        const meta = await printer.jobMeta(job.path).catch(() => ({ estimatedSeconds: null, filamentGrams: null, material: null }));
        const facts = [meta.material, meta.estimatedSeconds != null ? formatDuration(meta.estimatedSeconds) : null,
          meta.filamentGrams != null ? `${Math.round(meta.filamentGrams)} g` : null].filter(Boolean).join("  /  ");
        this.askConfirm(ctx, { title: "START PRINT?", detail: [jobName(job.path), facts].filter(Boolean), done: "Print started", run: (p) => p.start(job.path) });
      },
    }));
  }

  private async preheatItems(printer: Moonraker): Promise<MenuItem[]> {
    this.macros ??= await printer.macros().catch(() => []);
    const actions: Array<[string, Action]> = [60, 80, 100].map((target): [string, Action] => [`BED ${target}°`,
      { ...gcodeAction(`HEAT BED TO ${target}°?`, `SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=${target}`, `Bed → ${target}°`) }]);
    for (const name of this.macros.filter((macro) => /^PREHEAT_/.test(macro) && macro !== "PREHEAT_OFF").sort()) {
      actions.push([`${name.replace("PREHEAT_", "")} PROFILE`, gcodeAction(`RUN ${name}?`, name, `${name} sent`)]);
    }
    actions.push(["HEATERS OFF", HEATERS_OFF]);
    return actions.map(([label, action]) => ({ label, onSelect: (ctx: LayerContext) => this.askConfirm(ctx, action) }));
  }

  private async spoolText(printer: Moonraker): Promise<string> {
    const spool = await printer.spool();
    if (!spool.connected) return `Spoolman offline. Active spool id ${spool.spoolId ?? "none"}. Moonraker cannot reach Spoolman.`;
    if (spool.spoolId == null) return "No active spool. Select one in Mainsail or Fluidd.";
    const left = `${Math.round(spool.remainingGrams ?? 0)} g${spool.remainingMeters != null ? ` / ${Math.round(spool.remainingMeters)} m` : ""}`;
    return `#${spool.spoolId} ${spool.material}  ${`${spool.vendor} ${spool.name}`.trim()}\nLeft ${left}\nUsed ${Math.round(spool.usedGrams ?? 0)} g`;
  }

  /** Every hardware action passes through here: click confirms, double-click backs out. */
  private askConfirm(ctx: LayerContext, action: Action): void {
    const { width, height } = ctx.stack.getBaseSize();
    const details: MenuItem[] = action.detail.map((line) => ({ label: line, disabled: true, onSelect: () => {} }));
    const menuWidth = Math.min(380, width - 40);
    const layer: MenuLayer = new MenuLayer(action.title, [
      ...details,
      { label: "Confirm", onSelect: (confirmCtx) => this.run(confirmCtx, action, layer) },
      { label: "Cancel", onSelect: (confirmCtx) => { this.confirm = null; confirmCtx.stack.popIfTop((top) => top === layer); } },
    ], { x: "center", y: Math.max(8, ((height - 150) / 2) | 0), width: menuWidth, dimUnderneath: 0.25 }).selectItem(details.length);
    this.confirm = { layer, state: klipperBridge.snapshot().snap.state };
    ctx.stack.push(layer);
  }

  private async run(ctx: LayerContext, action: Action, layer: MenuLayer): Promise<void> {
    const printer = klipperBridge.client();
    // The confirm may have been disarmed by a printer state change between paint and click.
    if (!printer || this.busy || this.confirm?.layer !== layer) return;
    this.busy = true;
    this.confirm = null;
    // Back to the cockpit whatever list the action came from.
    ctx.stack.clearToBase();
    this.showToast("Sending…");
    try {
      await action.run(printer);
      this.showToast(action.done);
    } catch (error) {
      this.showToast(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
      await klipperBridge.refreshNow();
    }
  }

  private showToast(message: string): void {
    this.toast = message;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toast = ""; this.requestRender(); }, TOAST_MS);
    this.requestRender();
  }
}

/** App-specific entries for the window's long-press menu. */
export function klipperMenuItems(openSettings: (ctx: LayerContext) => void): MenuItem[] {
  return [
    { label: "Refresh", onSelect: async (ctx) => { ctx.stack.pop(); await klipperBridge.refreshNow(); } },
    { label: "Settings", onSelect: (ctx) => { ctx.stack.pop(); openSettings(ctx); } },
  ];
}
