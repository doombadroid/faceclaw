// Shared printer state for the KlipKommander window: finds Moonraker from the
// address setting, polls it while a window is open, and notifies listeners.
import { klipperAddressSetting, klipperApiKeySetting, onAnySettingChanged } from "../../ui/dashboard-settings";
import { Moonraker, moonrakerCandidates, OFFLINE, type Snapshot } from "./moonraker";

const POLL_MS = 2000;

export type KlipperState = {
  snap: Snapshot;
  /** Human-readable connection problem, or "" when the printer answers. */
  problem: string;
  configurationMissing: boolean;
};

class KlipperBridge {
  private printer: Moonraker | null = null;
  private connectedTo = "";
  private state: KlipperState = { snap: OFFLINE, problem: "", configurationMissing: true };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private users = 0;
  private polling = false;
  private unsubscribeSettings: (() => void) | null = null;

  snapshot(): KlipperState {
    return this.state;
  }

  /** The connected client, for actions and lists. Null until the first successful poll. */
  client(): Moonraker | null {
    return this.printer;
  }

  onStateChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reference-counted: polling runs only while some window is open. */
  start(): void {
    if (this.users++ > 0) return;
    this.unsubscribeSettings = onAnySettingChanged(() => {
      const key = `${klipperAddressSetting.get()}|${klipperApiKeySetting.get()}`;
      if (key === this.connectedTo) return;
      this.printer = null;
      void this.refreshNow();
    });
    void this.refreshNow();
  }

  stop(): void {
    if (--this.users > 0) return;
    this.users = 0;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
  }

  async refreshNow(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.poll();
    } finally {
      this.polling = false;
      if (this.users > 0) this.timer = setTimeout(() => void this.refreshNow(), POLL_MS);
    }
  }

  private async poll(): Promise<void> {
    const address = klipperAddressSetting.get();
    const apiKey = klipperApiKeySetting.get();
    if (!address) {
      this.printer = null;
      this.publish({ snap: OFFLINE, problem: "", configurationMissing: true });
      return;
    }
    const key = `${address}|${apiKey}`;
    // Keep using the base that answered; on failure fall back to trying every candidate again.
    const clients = this.printer && this.connectedTo === key
      ? [this.printer]
      : moonrakerCandidates(address).map((base) => new Moonraker(base, apiKey));
    let problem = "Check the printer address.";
    for (const client of clients) {
      try {
        const snap = await client.snapshot();
        this.printer = client;
        this.connectedTo = key;
        this.publish({ snap, problem: "", configurationMissing: false });
        return;
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
    }
    this.printer = null;
    this.publish({ snap: OFFLINE, problem, configurationMissing: false });
  }

  private publish(next: KlipperState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export const klipperBridge = new KlipperBridge();
