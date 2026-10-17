import * as frameTimings from "../native/frame-timings";
import { suspendEvenHubWhenScreenOffSetting } from "../ui/dashboard-settings";

const EVENHUB_SCREEN_OFF_SUSPEND_DELAY_MS = 5_000;
const EVENHUB_WAKE_READY_TIMEOUT_MS = 4_500;

/** The communicator calls this needs (both platforms' bridges). */
export type EvenHubSuspendSession = {
  setG2ScreenOn(screenOn: boolean): Promise<void>;
  setScreenBlanked(blanked: boolean): Promise<void>;
  suspendEvenHubSession(): Promise<boolean>;
  resumeEvenHubSession(): Promise<boolean>;
  awaitEvenHubSessionReady(timeoutMs: number): Promise<boolean>;
  setFaceclawWakeLeaseEnabled(enabled: boolean): Promise<boolean>;
};

export type EvenHubSuspendHost = {
  communicator(): EvenHubSuspendSession | null;
  /** The controller's connection phase ("connected", "charging", "disconnected", ...). */
  phase(): string;
  isScreenOn(): boolean;
  glanceVisible(): boolean;
  /** A live or parked voice capture: ending the plugin task would end its mic. */
  captureHeld(): boolean;
  /** Whether the firmware wake-takeover lease should be held now. */
  wantsWakeLease(): boolean;
  /** Without a session: wake the preview compositor (false when there is none). */
  wakePreview(): Promise<boolean>;
  /** A suspend landed: park a capture that raced it. */
  onSuspended(): void;
  log(message: string): void;
  formatError(error: unknown): string;
};

/**
 * Developer > Suspend EvenHub when screen off, with the Faceclaw wake lease:
 * the screen-off suspend timer, the single wake barrier every wake source
 * shares, and the lease sync. The controller resets the public state where a
 * session starts or ends.
 */
export class EvenHubSuspender {
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  suspended = false;
  resumePromise: Promise<boolean> | null = null;
  wakeLeaseState: boolean | null = null;

  constructor(private readonly host: EvenHubSuspendHost) {}

  /**
   * The single wake barrier for every source: restore the EvenHub lifecycle,
   * unblank the retained compositor, and resolve only after that frame is
   * visible. Concurrent display-wake, shell, and wakeword callbacks share the
   * same operation.
   *
   * frameId (0 when the caller has none) attributes the barrier's four
   * round trips to the input frame waiting on them; a wake barrier is the
   * largest single input-to-display term there is, so knowing which step
   * owns the second matters. Callers that join an in-flight barrier share
   * the first caller's spans.
   */
  ensureActive(frameId = 0): Promise<boolean> {
    if (this.resumePromise) return this.resumePromise;
    const communicator = this.host.communicator();
    if (!communicator) {
      // Preview mode has no plugin session to restore; waking is just
      // unblanking the headless compositor so the mirror lights back up.
      return this.host.wakePreview();
    }
    const phase = this.host.phase();
    if (phase === "charging" || phase === "disconnected") {
      return Promise.resolve(false);
    }

    const operation = (async () => {
      await frameTimings.spanAsync(frameId, "wake:screen-on", () => communicator.setG2ScreenOn(true));
      const resumed = await frameTimings.spanAsync(frameId, "wake:resume-session", () =>
        communicator.resumeEvenHubSession(),
      );
      if (!resumed) {
        return false;
      }
      // Resume first: setScreenBlanked(false) then recomposites retained state
      // as the desired first frame for the fresh layout.
      await frameTimings.spanAsync(frameId, "wake:unblank", () => communicator.setScreenBlanked(false));
      const ready = await frameTimings.spanAsync(frameId, "wake:await-ready", () =>
        communicator.awaitEvenHubSessionReady(EVENHUB_WAKE_READY_TIMEOUT_MS),
      );
      if (ready && this.host.communicator() === communicator) {
        this.suspended = false;
      }
      return ready;
    })();
    this.resumePromise = operation;
    const clearOperation = () => {
      if (this.resumePromise === operation) {
        this.resumePromise = null;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  async syncWakeLease(communicator = this.host.communicator(), force = false): Promise<boolean> {
    if (!communicator || communicator !== this.host.communicator()) return false;
    const enabled = this.host.wantsWakeLease();
    if (!force && this.wakeLeaseState === enabled) return true;
    const applied = await communicator.setFaceclawWakeLeaseEnabled(enabled);
    if (this.host.communicator() === communicator) {
      this.wakeLeaseState = applied || !enabled ? enabled : null;
    }
    return applied;
  }

  syncScreenOffSetting(): void {
    void this.syncWakeLease().catch((error) => {
      this.host.log(`wake takeover lease sync failed: ${this.host.formatError(error)}`);
    });
    if (suspendEvenHubWhenScreenOffSetting.get() && !this.host.isScreenOn()) {
      this.scheduleSuspend();
      return;
    }

    this.cancelSuspendTimer();
    if (!this.suspended) return;

    // Turning the experiment off restores the legacy all-black page even if
    // the screen remains asleep.
    const communicator = this.host.communicator();
    if (!communicator) return;
    void communicator
      .resumeEvenHubSession()
      .then((resumed) => {
        if (resumed && this.host.communicator() === communicator) {
          this.suspended = false;
        }
      })
      .catch((error) => {
        this.host.log(`EvenHub resume failed: ${this.host.formatError(error)}`);
      });
  }

  scheduleSuspend(): void {
    this.cancelSuspendTimer();
    const communicator = this.host.communicator();
    if (
      !suspendEvenHubWhenScreenOffSetting.get() ||
      this.host.isScreenOn() ||
      this.host.glanceVisible() ||
      this.host.phase() !== "connected" ||
      !communicator ||
      this.suspended
    ) {
      return;
    }

    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      if (
        !suspendEvenHubWhenScreenOffSetting.get() ||
        this.host.isScreenOn() ||
        this.host.glanceVisible() ||
        this.host.phase() !== "connected" ||
        this.host.communicator() !== communicator
      ) {
        // A showing Glanceboard re-arms this when it hides.
        return;
      }

      if (this.host.captureHeld()) {
        // Ending the plugin task ends the mic with it, so a live capture (the
        // Transcribe window, typically) outranks the screen-off power save.
        // Check before the lease refresh below, which costs a BLE message.
        this.scheduleSuspend();
        return;
      }

      void (async () => {
        // The setting is on here, so wanting the lease means the firmware has it.
        if (this.host.wantsWakeLease()) {
          // Refresh immediately before teardown so the first suspended wake
          // cannot race an old lease's expiry.
          const leaseReady = await this.syncWakeLease(communicator, true);
          if (!leaseReady) {
            this.host.log("EvenHub suspend deferred; wake takeover lease was not delivered");
            this.scheduleSuspend();
            return;
          }
        }
        if (
          !suspendEvenHubWhenScreenOffSetting.get() ||
          this.host.isScreenOn() ||
          this.host.glanceVisible() ||
          this.host.phase() !== "connected" ||
          this.host.communicator() !== communicator
        ) {
          return;
        }
        this.suspended = true;
        return communicator.suspendEvenHubSession();
      })()
        .then((suspended) => {
          if (suspended === undefined) return;
          if (suspended) {
            // A capture that raced the suspend lost its mic with the plugin
            // task; park it for the resume path.
            this.host.onSuspended();
            this.host.log("EvenHub session suspended while screen is off");
            return;
          }
          if (this.host.communicator() !== communicator || this.host.isScreenOn()) return;
          this.suspended = false;
          this.scheduleSuspend();
        })
        .catch((error) => {
          if (this.host.communicator() === communicator) {
            this.suspended = false;
            this.host.log(`EvenHub suspend failed: ${this.host.formatError(error)}`);
            this.scheduleSuspend();
          }
        });
    }, EVENHUB_SCREEN_OFF_SUSPEND_DELAY_MS);
  }

  cancelSuspendTimer(): void {
    if (this.suspendTimer === null) return;
    clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
  }
}
