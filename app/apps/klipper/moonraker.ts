// Moonraker client for the KlipKommander app: the HTTP API that Mainsail and
// Fluidd use. Pure TypeScript (no DOM, no native code) so it runs the same on
// Android and iOS and under node tests.
import { fetchWithUserAgent } from "../../util/http";

export type PrintState = "standby" | "printing" | "paused" | "complete" | "cancelled" | "error" | "offline";

export type Snapshot = {
  state: PrintState;
  klippy: string;
  filename: string;
  /** 0..1 */
  progress: number;
  printSeconds: number;
  layer: number | null;
  totalLayers: number | null;
  nozzle: number;
  nozzleTarget: number;
  bed: number;
  bedTarget: number;
  message: string;
};

export type Job = { path: string; modified: number };
export type JobMeta = { estimatedSeconds: number | null; filamentGrams: number | null; material: string | null };
export type Spool = {
  connected: boolean;
  spoolId: number | null;
  name: string;
  material: string;
  vendor: string;
  remainingGrams: number | null;
  usedGrams: number | null;
  remainingMeters: number | null;
};

export const OFFLINE: Snapshot = {
  state: "offline", klippy: "unreachable", filename: "", progress: 0, printSeconds: 0,
  layer: null, totalLayers: null, nozzle: 0, nozzleTarget: 0, bed: 0, bedTarget: 0, message: "",
};

const READ_TIMEOUT_MS = 4000;
const WRITE_TIMEOUT_MS = 15000;

/**
 * Turns what the user typed (a Moonraker, Mainsail or Fluidd address, with or
 * without scheme, port or UI route) into Moonraker base URLs worth trying: the
 * address as given, then Moonraker's own port 7125 when no port was named.
 */
export function moonrakerCandidates(input: string): string[] {
  const typed = input.trim();
  if (!typed) return [];
  const match = /^(?:(https?):\/\/)?([^/?#]+)([^?#]*)/i.exec(typed);
  if (!match || !match[2]) return [];
  const scheme = (match[1] ?? "http").toLowerCase();
  const host = match[2]!;
  // Mainsail/Fluidd links carry a UI route; Moonraker lives at the root unless
  // the path names a proxy prefix.
  const path = (match[3] ?? "").replace(/\/+$/, "");
  const prefix = /^\/(mr|moonraker|api)(\/|$)/.test(path) ? path : "";
  const base = `${scheme}://${host}${prefix}`;
  const hasPort = /:\d+$/.test(host);
  return hasPort || prefix ? [base] : [base, `${scheme}://${host}:7125`];
}

export class Moonraker {
  constructor(private readonly base: string, private readonly apiKey = "") {}

  get baseUrl(): string {
    return this.base;
  }

  private async call<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers["X-Api-Key"] = this.apiKey;
    const request = fetchWithUserAgent(this.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Printer request timed out.")), method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([request, timeout]);
      const json = await response.json().catch(() => null);
      if (response.status === 401) throw new Error("Moonraker wants an API key.");
      if (!response.ok) throw new Error(json?.error?.message ?? `HTTP ${response.status}`);
      return json.result as T;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async snapshot(): Promise<Snapshot> {
    const info = await this.call<{ klippy_state: string }>("/server/info");
    if (info.klippy_state !== "ready") return { ...OFFLINE, state: "error", klippy: info.klippy_state };
    const { status } = await this.call<{ status: any }>(
      "/printer/objects/query?print_stats&virtual_sdcard&heater_bed&extruder&display_status");
    const stats = status.print_stats;
    return {
      state: stats.state,
      klippy: info.klippy_state,
      filename: stats.filename ?? "",
      // Slicer-reported M73 progress when present, else file position.
      progress: status.display_status?.progress || status.virtual_sdcard?.progress || 0,
      printSeconds: stats.print_duration ?? 0,
      layer: stats.info?.current_layer ?? null,
      totalLayers: stats.info?.total_layer ?? null,
      nozzle: status.extruder.temperature,
      nozzleTarget: status.extruder.target,
      bed: status.heater_bed.temperature,
      bedTarget: status.heater_bed.target,
      message: stats.message || status.display_status?.message || "",
    };
  }

  async jobs(): Promise<Job[]> {
    const files = await this.call<Job[]>("/server/files/list?root=gcodes");
    return files.sort((a, b) => b.modified - a.modified).slice(0, 20);
  }

  async jobMeta(path: string): Promise<JobMeta> {
    const meta = await this.call<any>(`/server/files/metadata?filename=${encodeURIComponent(path)}`);
    return {
      estimatedSeconds: meta.estimated_time ?? null,
      filamentGrams: meta.filament_weight_total ?? null,
      material: meta.filament_type ?? null,
    };
  }

  /** Every registered G-code command, macros included (same source Mainsail's console help uses). */
  async macros(): Promise<string[]> {
    return Object.keys(await this.call<Record<string, string>>("/printer/gcode/help"));
  }

  async spool(): Promise<Spool> {
    const status = await this.call<{ spoolman_connected: boolean; spool_id: number | null }>("/server/spoolman/status");
    const empty: Spool = {
      connected: status.spoolman_connected, spoolId: status.spool_id, name: "", material: "", vendor: "",
      remainingGrams: null, usedGrams: null, remainingMeters: null,
    };
    if (!status.spoolman_connected || status.spool_id == null) return empty;
    const proxied = await this.call<{ response: any; error: any }>("/server/spoolman/proxy", "POST", {
      request_method: "GET", path: `/v1/spool/${status.spool_id}`, use_v2_response: true,
    });
    const spool = proxied.response;
    if (!spool) return empty;
    return {
      ...empty,
      name: spool.filament?.name ?? "",
      material: spool.filament?.material ?? "",
      vendor: spool.filament?.vendor?.name ?? "",
      remainingGrams: spool.remaining_weight ?? null,
      usedGrams: spool.used_weight ?? null,
      remainingMeters: spool.remaining_length != null ? spool.remaining_length / 1000 : null,
    };
  }

  start(path: string): Promise<void> {
    return this.call(`/printer/print/start?filename=${encodeURIComponent(path)}`, "POST");
  }
  pause(): Promise<void> {
    return this.call("/printer/print/pause", "POST", {});
  }
  resume(): Promise<void> {
    return this.call("/printer/print/resume", "POST", {});
  }
  cancel(): Promise<void> {
    return this.call("/printer/print/cancel", "POST", {});
  }
  gcode(script: string): Promise<void> {
    return this.call("/printer/gcode/script", "POST", { script });
  }
}
