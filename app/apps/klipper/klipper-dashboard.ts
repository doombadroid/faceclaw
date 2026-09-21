// KlipKommander's cockpit: state chip, segmented progress bar, big percentage,
// time left, thermometers and the home-menu tabs. Pure drawing on a GrayImage
// with the fonts passed in, so it can be rendered under node for layout checks.
import { type GrayImage, type UiFont } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { type Snapshot } from "./moonraker";

export type DashboardFonts = { small: UiFont; medium: UiFont; large: UiFont };

const FG = 255;
const MID = 150;
const DIM = 60;
const PAGE_X = 16;
const SEGMENTS = 40;
// Thermometer full-scale values. Tune to your hotend / bed.
const NOZZLE_MAX_C = 300;
const BED_MAX_C = 120;

export function formatDuration(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/** Seconds left, or null while there is not enough progress to extrapolate from. */
export function remainingSeconds(snap: Snapshot): number | null {
  if (snap.state !== "printing" || snap.progress < 0.01 || snap.printSeconds < 30) return null;
  return snap.printSeconds / snap.progress - snap.printSeconds;
}

export function jobName(path: string): string {
  return path.replace(/\.gcode$/i, "").split("/").pop() ?? path;
}

const clock = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

// Seven-segment digits drawn with rectangles: a big number that does not depend
// on which fonts the user picked. Segments: a top, b upper-right, c lower-right,
// d bottom, e lower-left, f upper-left, g middle.
const SEGMENT_MAP: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg",
};

function drawDigit(image: GrayImage, x: number, y: number, w: number, h: number, t: number, digit: string): void {
  const on = SEGMENT_MAP[digit] ?? "";
  const half = (h / 2) | 0;
  if (on.includes("a")) image.fillRect(x + t, y, w - 2 * t, t, FG);
  if (on.includes("g")) image.fillRect(x + t, y + half - ((t / 2) | 0), w - 2 * t, t, FG);
  if (on.includes("d")) image.fillRect(x + t, y + h - t, w - 2 * t, t, FG);
  if (on.includes("f")) image.fillRect(x, y + t, t, half - t, FG);
  if (on.includes("e")) image.fillRect(x, y + half, t, half - t, FG);
  if (on.includes("b")) image.fillRect(x + w - t, y + t, t, half - t, FG);
  if (on.includes("c")) image.fillRect(x + w - t, y + half, t, half - t, FG);
}

/** Draws e.g. "41" in big segments followed by a "%" in the medium font; returns the total width. */
function drawPercent(image: GrayImage, fonts: DashboardFonts, x: number, y: number, h: number, percent: number): number {
  const w = Math.round(h * 0.56);
  const t = Math.max(3, Math.round(h * 0.12));
  const gap = Math.round(w * 0.28);
  let cursor = x;
  for (const digit of String(percent)) {
    drawDigit(image, cursor, y, w, h, t, digit);
    cursor += w + gap;
  }
  image.drawText(fonts.medium, cursor, y + h - fonts.medium.lineHeight, "%", FG);
  return cursor + fonts.medium.measureText("%") - x;
}

function drawThermometer(
  image: GrayImage, fonts: DashboardFonts, name: string, x: number, top: number, bottom: number,
  now: number, target: number, max: number,
): void {
  const small = fonts.small;
  const tubeTop = top + small.lineHeight + 2;
  const tubeBottom = bottom - small.lineHeight - 2;
  const tubeHeight = Math.max(8, tubeBottom - tubeTop);
  const value = `${Math.round(now)}°`;
  image.drawText(small, x + 11 - ((small.measureText(value) / 2) | 0), top, value, FG);
  image.drawRect(x, tubeTop, 22, tubeHeight, MID);
  const fill = Math.round((tubeHeight - 4) * Math.min(1, Math.max(0, now / max)));
  if (fill > 0) image.fillRect(x + 3, tubeTop + tubeHeight - 2 - fill, 16, fill, FG);
  if (target > 0) {
    const mark = tubeTop + tubeHeight - 2 - Math.round((tubeHeight - 4) * Math.min(1, target / max));
    image.fillRect(x - 5, mark, 32, 2, FG);
  }
  // The target is the tick on the tube; a second number here collides with the neighbouring gauge.
  image.drawText(small, x + 11 - ((small.measureText(name) / 2) | 0), tubeBottom + 2, name, MID);
}

export type DashboardView = {
  snap: Snapshot;
  /** Connection problem or setup hint shown instead of the panels, or "". */
  notice: string;
  tabs: string[];
  cursor: number;
  footer: string;
  focused: boolean;
};

export function paintDashboard(image: GrayImage, fonts: DashboardFonts, view: DashboardView, now = new Date()): void {
  const { snap } = view;
  const { small, medium } = fonts;
  const width = image.width;
  const height = image.height;

  // Header: state chip, then job name (or the printer's last M117 message).
  const label = snap.state === "error" ? `KLIPPER ${snap.klippy.toUpperCase()}` : snap.state.toUpperCase();
  const chipWidth = small.measureText(label) + 18;
  const chipHeight = small.lineHeight + 6;
  if (snap.state === "printing") {
    image.fillRoundedRect(PAGE_X, 5, chipWidth, chipHeight, FG, 4);
    image.drawText(small, PAGE_X + 9, 8, label, 0);
  } else {
    image.drawRoundedRect(PAGE_X, 5, chipWidth, chipHeight, FG, 4);
    image.drawText(small, PAGE_X + 9, 8, label, FG);
  }
  const name = snap.filename ? jobName(snap.filename) : snap.message;
  const nameX = PAGE_X + chipWidth + 12;
  if (name) image.drawText(small, nameX, 8, truncateText(small, name, width - nameX - PAGE_X), MID);

  // Segmented progress bar; paused segments go hollow.
  const barY = 5 + chipHeight + 7;
  const barHeight = 12;
  const lit = Math.floor(Math.min(1, Math.max(0, snap.progress)) * SEGMENTS);
  const pitch = (width - 2 * PAGE_X + 3) / SEGMENTS;
  for (let index = 0; index < SEGMENTS; index++) {
    const x = Math.round(PAGE_X + index * pitch);
    const w = Math.max(2, Math.round(pitch) - 3);
    if (index >= lit) image.fillRect(x, barY, w, barHeight, DIM);
    else if (snap.state === "paused") image.drawRect(x, barY, w, barHeight, FG);
    else image.fillRect(x, barY, w, barHeight, FG);
  }

  // Bottom rows first, so the panels can take whatever height is left.
  const footerY = height - small.lineHeight - 4;
  const tabHeight = small.lineHeight + 10;
  const tabY = footerY - tabHeight - 6;
  const panelTop = barY + barHeight + 8;
  const panelBottom = tabY - 8;
  const panelHeight = panelBottom - panelTop;

  if (view.notice) {
    image.drawRoundedRect(PAGE_X, panelTop, width - 2 * PAGE_X, panelHeight, DIM, 6);
    image.drawTextWrapped({ font: medium, x: PAGE_X + 14, y: panelTop + 12, width: width - 2 * PAGE_X - 28, text: view.notice, value: FG });
  } else if (panelHeight < 100) {
    // Short window: no room for gauges, keep the numbers.
    const left = remainingSeconds(snap);
    const active = snap.state === "printing" || snap.state === "paused";
    const line = [active ? `${Math.floor(snap.progress * 100)}%` : "", left == null ? "" : `${formatDuration(left)} left`,
      `NOZ ${Math.round(snap.nozzle)}/${Math.round(snap.nozzleTarget)}°`, `BED ${Math.round(snap.bed)}/${Math.round(snap.bedTarget)}°`]
      .filter(Boolean).join("   ");
    image.drawText(medium, PAGE_X, panelTop + Math.max(0, ((panelHeight - medium.lineHeight) / 2) | 0), truncateText(medium, line, width - 2 * PAGE_X), FG);
  } else {
    const leftWidth = Math.round((width - 2 * PAGE_X) * 0.36);
    const rightWidth = 124;
    const midX = PAGE_X + leftWidth + 10;
    const rightX = width - PAGE_X - rightWidth;
    const midWidth = rightX - 10 - midX;
    image.drawRoundedRect(PAGE_X, panelTop, leftWidth, panelHeight, DIM, 6);
    image.drawRoundedRect(midX, panelTop, midWidth, panelHeight, DIM, 6);
    image.drawRoundedRect(rightX, panelTop, rightWidth, panelHeight, DIM, 6);

    const active = snap.state === "printing" || snap.state === "paused";
    const inner = panelTop + 10;
    if (active) {
      const percent = Math.floor(snap.progress * 100);
      // Three digits ("100") need a smaller face to stay inside the panel.
      const digitHeight = Math.min(percent >= 100 ? 56 : 80, panelHeight - small.lineHeight - 26);
      drawPercent(image, fonts, PAGE_X + 12, inner, digitHeight, percent);
      if (snap.layer != null && snap.totalLayers) {
        image.drawText(small, PAGE_X + 12, panelBottom - small.lineHeight - 8, `LAYER ${snap.layer}/${snap.totalLayers}`, MID);
      }
    } else {
      const word = snap.state === "offline" ? "N/C" : snap.state === "complete" ? "DONE" : "IDLE";
      image.drawText(fonts.large, PAGE_X + 12, inner, word, FG);
      image.drawText(small, PAGE_X + 12, panelBottom - small.lineHeight - 8,
        snap.state === "offline" ? "NO MOONRAKER" : "NO ACTIVE JOB", MID);
    }

    const left = remainingSeconds(snap);
    let y = inner;
    image.drawText(small, midX + 12, y, "REMAINING", MID);
    y += small.lineHeight + 2;
    image.drawText(fonts.large, midX + 12, y, left == null ? "--" : formatDuration(left), FG);
    y += fonts.large.lineHeight + 6;
    if (y + small.lineHeight + medium.lineHeight < panelBottom) {
      image.drawText(small, midX + 12, y, "DONE AT", MID);
      y += small.lineHeight + 2;
      image.drawText(medium, midX + 12, y, left == null ? "--:--" : clock(new Date(now.getTime() + left * 1000)), FG);
    }

    drawThermometer(image, fonts, "NOZ", rightX + 24, inner - 2, panelBottom - 6, snap.nozzle, snap.nozzleTarget, NOZZLE_MAX_C);
    drawThermometer(image, fonts, "BED", rightX + 78, inner - 2, panelBottom - 6, snap.bed, snap.bedTarget, BED_MAX_C);
  }

  // Home menu as a tab row; the selected tab is filled (outlined when the window is unfocused).
  if (view.tabs.length) {
    const gap = 8;
    const tabWidth = (width - 2 * PAGE_X - (view.tabs.length - 1) * gap) / view.tabs.length;
    view.tabs.forEach((tab, index) => {
      const x = Math.round(PAGE_X + index * (tabWidth + gap));
      const w = Math.round(tabWidth);
      const selected = index === view.cursor;
      if (selected && view.focused) image.fillRoundedRect(x, tabY, w, tabHeight, FG, 4);
      else image.drawRoundedRect(x, tabY, w, tabHeight, selected ? FG : MID, 4);
      const text = truncateText(small, tab, w - 10);
      image.drawText(small, x + ((w - small.measureText(text)) / 2 | 0), tabY + 5, text, selected && view.focused ? 0 : FG);
    });
  }
  if (view.footer) {
    const text = truncateText(small, view.footer, width - 2 * PAGE_X);
    image.drawText(small, ((width - small.measureText(text)) / 2) | 0, footerY, text, MID);
  }
}
