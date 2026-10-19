import { GrayImage } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import { ensurePreinstalledFonts, installedFontPath } from "../../graphics/installed-fonts";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { renderFontFileCaption } from "../../native/font-files";
import { type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { listenSession, type ListenLine, type ListenState } from "./listen-session";
import { languageCode } from "./translate-settings";

/**
 * Listen's lens: a header with the pair (the side being listened for
 * highlighted) and the status, then captions bottom-up — the live line at
 * the bottom, finals above it, newest last. Each caption is its translation
 * (bright) over the original (dim), rendered by Core Text so CJK wraps and
 * Arabic shapes; lines I spoke render dimmer. Click pauses/resumes (or
 * retries after an error), scroll reviews older lines and snaps back to live
 * on a new final.
 */

const FONT_FILE = "Roboto-Light.ttf";
const TRANSLATION_PX = 18;
const ORIGINAL_PX = 15;
const TRANSLATION_LINES = 3;
const ORIGINAL_LINES = 2;
const ORIGINAL_DIM = 0.5;
const MINE_DIM = 0.6;
const SIDE = 16;
const CAPTION_GAP = 8;
const CACHE_SIZE = 64;
const RENDER_MS = 333;
const STATUS_LINES = 3;

const STATUS_TEXT: Record<ListenState["status"], string> = {
  idle: "stopped",
  starting: "starting",
  listening: "listening",
  paused: "paused",
  error: "error",
};

export class ListenLayer implements Layer {
  private state: ListenState = listenSession.state;
  private off: (() => void) | null = null;
  private requestRender: () => void = () => {};
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private renderedAt = 0;
  private scrollback = 0;
  private lastFinalId = 0;
  // Insertion order is recency (re-inserted on a hit).
  private readonly cache = new Map<string, GrayImage | null>();

  start(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.off?.();
    this.off = listenSession.onState((state) => {
      const lastId = state.lines[state.lines.length - 1]?.id ?? 0;
      if (lastId !== this.lastFinalId) {
        this.lastFinalId = lastId;
        this.scrollback = 0;
      }
      this.state = state;
      this.scheduleRender();
    });
  }

  /** At most one repaint per RENDER_MS; captions change at speech rate. */
  private scheduleRender(): void {
    if (this.renderTimer) return;
    const wait = Math.max(0, RENDER_MS - (Date.now() - this.renderedAt));
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderedAt = Date.now();
      this.requestRender();
    }, wait);
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const state = this.state;

    // Header: "ES ⇄ EN  listening", the side being listened for bright.
    let x = 12;
    const y = 4;
    const side = (lang: string) => {
      const code = languageCode(lang);
      image.drawText(font, x, y, code, lang === state.current ? 255 : 110);
      x += font.measureText(code);
    };
    side(state.their);
    const arrow = font.hasGlyph(0x21c4) ? " ⇄ " : " <> ";
    image.drawText(font, x, y, arrow, 150);
    x += font.measureText(arrow);
    side(state.mine);
    const status =
      (state.status === "error" ? state.message : STATUS_TEXT[state.status]) +
      (state.status !== "error" && state.message ? ` · ${state.message}` : "") +
      (this.scrollback > 0 ? `  (${this.scrollback} back)` : "");
    const statusLines = wrapText(font, status, width - x - 24).slice(0, STATUS_LINES);
    statusLines.forEach((line, i) => image.drawText(font, x + 12, y + i * font.lineHeight, line, state.status === "error" ? 220 : 130));

    const top = y + font.lineHeight * Math.max(1, statusLines.length) + 6;
    const maxWidth = width - 2 * SIDE;
    const lines = this.scrollback > 0 ? state.lines.slice(0, Math.max(0, state.lines.length - this.scrollback)) : state.lines;
    const shown = this.scrollback === 0 && state.live ? [...lines, state.live] : lines;
    let bottom = height - 4;
    for (let i = shown.length - 1; i >= 0 && bottom > top; i--) {
      const parts = this.captionImages(shown[i]!, maxWidth);
      const blockHeight = parts.reduce((sum, part) => sum + part.height, 0) + (parts.length - 1) * 2;
      let partY = bottom - blockHeight;
      for (const part of parts) {
        blitClipped(image, part, SIDE, partY, top);
        partY += part.height + 2;
      }
      bottom -= blockHeight + CAPTION_GAP;
    }
    return image;
  }

  /** Translation (if any) over the original, already dimmed. */
  private captionImages(line: ListenLine, maxWidth: number): GrayImage[] {
    const mine = line.mine ? MINE_DIM : 1;
    const parts: GrayImage[] = [];
    if (line.translation) {
      const translated = this.render(line.translation, TRANSLATION_PX, maxWidth, TRANSLATION_LINES, line.target, mine);
      if (translated) parts.push(translated);
    }
    const original = this.render(line.text, ORIGINAL_PX, maxWidth, ORIGINAL_LINES, line.lang, ORIGINAL_DIM * mine);
    if (original) parts.push(original);
    return parts;
  }

  private render(text: string, sizePx: number, maxWidth: number, maxLines: number, language: string, dim: number): GrayImage | null {
    const key = `${sizePx}|${maxWidth}|${maxLines}|${language}|${dim}|${text}`;
    if (this.cache.has(key)) {
      const hit = this.cache.get(key)!;
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    ensurePreinstalledFonts();
    const rendered = renderFontFileCaption({ path: installedFontPath(FONT_FILE), text, sizePx, maxWidth, maxLines, language });
    const image = rendered && dim < 1 ? rendered.dimmed(dim) : rendered;
    this.cache.set(key, image);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "click": {
        const { status } = listenSession.state;
        if (status === "paused") listenSession.resume();
        else if (status === "idle" || status === "error") void listenSession.start();
        else listenSession.pause();
        return;
      }
      case "scroll-up":
        this.scrollback = Math.min(this.scrollback + 1, Math.max(0, this.state.lines.length - 1));
        this.requestRender();
        return;
      case "scroll-down":
        this.scrollback = Math.max(0, this.scrollback - 1);
        this.requestRender();
        return;
      case "double-click":
        // At the window root YieldAtRootLayer leaves the app first.
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    this.off?.();
    this.off = null;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }
}

/** bitBlt with the rows above `top` cut off (the header's area). */
function blitClipped(target: GrayImage, source: GrayImage, x: number, y: number, top: number): void {
  const cut = Math.max(0, top - y);
  if (cut >= source.height) return;
  target.bitBlt(source, x, y + cut, { sy: cut, height: source.height - cut, transparentZero: true });
}
