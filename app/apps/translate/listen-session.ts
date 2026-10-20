import { voiceControlBridge } from "../../native/voice-control";
import { audioMonitorCommunicator } from "../../native/audio-monitor";
import {
  liveTranscriberAvailable,
  speechLanguageStatus,
  startLiveTranscriber,
  type LiveTranscriber,
  type TranscriberEvent,
} from "../../native/live-transcriber";
import { appleTranslateAvailable, translateText } from "../../native/apple-translate";
import { countWords, DirectionPicker, type Decision } from "./direction";
import { Endpointer } from "./endpoint";
import { scorePair } from "./language-id";
import { languageName, translateMyLanguageSetting, translateTheirLanguageSetting } from "./translate-settings";

/**
 * Listen: the glasses mic feeds two on-device transcribers at once (their
 * language and mine); the DirectionPicker decides per utterance which one was
 * spoken, and the winner is translated into the other language. Partials of
 * the current direction show as a live line, translated at most every
 * LIVE_TRANSLATE_MS.
 */

export interface ListenLine {
  id: number;
  /** Spoken language, and the one it is translated into. */
  lang: string;
  target: string;
  text: string;
  /** "" until the translation arrives (or when it failed). */
  translation: string;
  final: boolean;
  /** Spoken in my language. */
  mine: boolean;
  atMs: number;
}

export interface ListenState {
  status: "idle" | "starting" | "listening" | "paused" | "error";
  message: string;
  their: string;
  mine: string;
  /** The language the picker currently expects (the highlighted side). */
  current: string;
  lines: ListenLine[];
  live: ListenLine | null;
}

const SAMPLE_RATE = 16000;
const MAX_LINES = 40;
const TICK_MS = 250;
const NOTIFY_MS = 250;
const LIVE_TRANSLATE_MS = 700;
const CAPTURE_CHECK_MS = 3000;
const MAX_RESTARTS = 3;
// A final ending this soon after the live line's audio is the live line itself.
const LIVE_PAD_S = 0.25;
const RAW_CAPTURE_OWNER = "translate";
const WAITING_MIC = "Waiting for the glasses microphone…";

/** One picker and the transcribers feeding it; a pause closes it and resume opens another. */
/** startS: the session audio time (samplesFed) when the run opened, the endpointer's 0. */
type Run = { picker: DirectionPicker; endpointer: Endpointer; startS: number; ready: Set<string>; closed: boolean };
type Slot = { id: number; lang: string; run: Run; transcriber: LiveTranscriber | null; offsetS: number; finishing: boolean };

// all-apps imports this on Android too: load the iOS-only logger lazily.
const remoteLog = (level: string, msg: string, data?: unknown) => {
  if (!global.isIOS) return;
  (require("../../native/remote-log.ios") as typeof import("../../native/remote-log.ios")).remoteLog("translate", level, msg, data);
};
const log = (msg: string, data?: unknown) => remoteLog("info", msg, data);
const logError = (msg: string, data?: unknown) => remoteLog("error", msg, data);

class ListenSession {
  private st: ListenState = { status: "idle", message: "", their: "", mine: "", current: "", lines: [], live: null };
  private readonly listeners = new Set<(state: ListenState) => void>();
  // Bumped by start and stop: continuations of an older session drop out.
  private generation = 0;
  private run: Run | null = null;
  private readonly runs = new Set<Run>();
  private readonly slots = new Map<number, Slot>();
  private nextSlotId = 1;
  private readonly restarts = new Map<string, number>();
  private nextLineId = 1;
  private samplesFed = 0;
  private liveEndS = 0;
  // The live line's transcriber finalized it: the next partial is a new utterance.
  private liveClosed = false;
  private liveTranslatedAt = 0;
  private liveTranslating = false;
  private offPcm: (() => void) | null = null;
  private captureRestarts = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private notifiedAt = 0;

  get state(): ListenState {
    return { ...this.st, lines: this.st.lines.slice() };
  }

  /** Calls fn now and on every (throttled) change; returns the unsubscribe. */
  onState(fn: (state: ListenState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async start(): Promise<void> {
    if (this.st.status === "starting" || this.st.status === "listening" || this.st.status === "paused") return;
    const generation = ++this.generation;
    const their = translateTheirLanguageSetting.get();
    const mine = translateMyLanguageSetting.get();
    this.restarts.clear();
    this.st = { status: "starting", message: "", their, mine, current: their, lines: [], live: null };
    this.notify(true);
    log("start", { their, mine });
    if (their === mine) return this.fail("Pick two different languages in Translate on the phone.");
    if (!liveTranscriberAvailable()) return this.fail("This build has no on-device speech recognition.");
    if (!appleTranslateAvailable()) return this.fail("This build has no Apple Translation.");
    let statuses: Awaited<ReturnType<typeof speechLanguageStatus>>[];
    try {
      statuses = await Promise.all([speechLanguageStatus(their), speechLanguageStatus(mine)]);
    } catch (error) {
      if (generation === this.generation) this.fail(`Could not check speech recognition: ${error}`);
      return;
    }
    // Stopped, or paused while checking (a resume then already opened the run).
    if (generation !== this.generation || this.st.status !== "starting") return;
    const langs = [their, mine];
    const unsupported = langs.filter((_, i) => !statuses[i]!.supported);
    if (unsupported.length) {
      return this.fail(`${unsupported.map(languageName).join(" and ")} speech recognition is not supported on this iPhone.`);
    }
    const missing = langs.filter((_, i) => !statuses[i]!.installed);
    if (missing.length) return this.fail(`Open Translate on the phone to download ${missing.map(languageName).join(" and ")}.`);
    if (!this.run) this.openRun(their);
  }

  /** Release the mic and drop the transcribers; the lines stay until the next start. */
  stop(): void {
    if (this.st.status === "idle") return;
    log("stop");
    this.teardown();
    this.st = { ...this.st, status: "idle", message: "", live: null };
    this.notify(true);
  }

  /** Release the mic; the transcribers finish, so the last utterance still becomes a line. */
  pause(): void {
    if (this.st.status !== "starting" && this.st.status !== "listening") return;
    log("pause");
    this.closeRun();
    this.st = { ...this.st, status: "paused", message: "" };
    this.notify(true);
  }

  resume(): void {
    if (this.st.status !== "paused") return;
    log("resume");
    this.st = { ...this.st, status: "starting", message: "" };
    this.openRun(this.st.current);
  }

  // ---- runs and transcribers ----

  private openRun(initial: string): void {
    const { their, mine } = this.st;
    const langs: [string, string] = [their, mine];
    const run: Run = {
      picker: new DirectionPicker({ langs, initial, scorer: (text) => scorePair(text, langs) }),
      endpointer: new Endpointer(),
      startS: this.samplesFed / SAMPLE_RATE,
      ready: new Set(),
      closed: false,
    };
    this.run = run;
    this.runs.add(run);
    this.startSlot(their, run);
    this.startSlot(mine, run);
    this.offPcm ??= voiceControlBridge.onRawPcm((pcm) => this.handlePcm(pcm));
    this.captureRestarts = 0;
    this.startCapture();
    this.tickTimer ??= setInterval(() => this.tick(), TICK_MS);
    this.captureTimer ??= setInterval(() => this.checkCapture(), CAPTURE_CHECK_MS);
    this.notify(true);
  }

  /** Stop feeding the current run and let its transcribers finish (pause). */
  private closeRun(): void {
    this.stopCapture();
    const run = this.run;
    this.run = null;
    this.st.live = null;
    if (!run) return;
    run.closed = true;
    for (const slot of this.slots.values()) {
      if (slot.run !== run) continue;
      slot.finishing = true;
      slot.transcriber?.finish();
    }
    this.maybeFlushRun(run);
  }

  private startSlot(lang: string, run: Run): void {
    const id = this.nextSlotId++;
    // Times are relative to the first sample a transcriber is fed: a restarted
    // one starts later than its twin, so its times are shifted to the session clock.
    const slot: Slot = { id, lang, run, transcriber: null, offsetS: this.samplesFed / SAMPLE_RATE, finishing: false };
    this.slots.set(id, slot);
    const transcriber = startLiveTranscriber(lang, (event) => {
      if (this.slots.get(id) === slot) this.handleEvent(slot, event);
    });
    if (!transcriber) {
      this.failSlot(slot, "could not start");
      return;
    }
    // An error delivered during start already dropped the slot.
    if (this.slots.get(id) !== slot) transcriber.cancel();
    else slot.transcriber = transcriber;
  }

  private handleEvent(slot: Slot, event: TranscriberEvent): void {
    switch (event.kind) {
      case "ready":
        log("ready", { lang: slot.lang, locale: event.locale });
        slot.run.ready.add(slot.lang);
        if (slot.run === this.run && this.st.status === "starting" && slot.run.ready.size >= 2) {
          this.st.status = "listening";
          this.st.message = voiceControlBridge.isRawCaptureLive() ? "" : WAITING_MIC;
          this.notify(true);
        }
        return;
      case "partial":
        // ponytail: debug — see "final" below.
        log("partial", { lang: slot.lang, start: event.start + slot.offsetS, end: event.end + slot.offsetS, text: event.text });
        this.handlePartial(slot, event.text, event.end + slot.offsetS);
        return;
      case "final":
        // It works: a later failure gets a fresh set of restarts.
        this.restarts.delete(slot.lang);
        if (slot.run === this.run && slot.lang === this.st.live?.lang) this.liveClosed = true;
        // ponytail: debug — speech text in the LAN log while the picker is tuned; drop before merging.
        log("final", { lang: slot.lang, start: event.start + slot.offsetS, end: event.end + slot.offsetS, conf: event.conf, text: event.text });
        this.applyDecisions(
          slot.run,
          slot.run.picker.pushFinal(slot.lang, {
            text: event.text,
            conf: event.conf,
            start: event.start + slot.offsetS,
            end: event.end + slot.offsetS,
          }),
        );
        return;
      case "finalized":
        log("finalized", { lang: slot.lang, through: event.through + slot.offsetS });
        this.applyDecisions(slot.run, slot.run.picker.finalized(slot.lang, event.through + slot.offsetS));
        return;
      case "error":
        logError("transcriber error", { lang: slot.lang, message: event.message });
        this.failSlot(slot, event.message);
        return;
      case "ended":
        this.slots.delete(slot.id);
        if (slot.finishing) this.slotEnded(slot);
        else this.failSlot(slot, "ended unexpectedly");
        return;
    }
  }

  /** A finishing transcriber is done: its run flushes once all of them are. */
  private slotEnded(slot: Slot): void {
    this.applyDecisions(slot.run, slot.run.picker.ended(slot.lang));
    this.maybeFlushRun(slot.run);
  }

  private maybeFlushRun(run: Run): void {
    if (!run.closed || !this.runs.has(run)) return;
    for (const slot of this.slots.values()) if (slot.run === run) return;
    this.runs.delete(run);
    this.applyDecisions(run, run.picker.flush());
  }

  /** Drop a failed transcriber and restart it with backoff, or end the session after MAX_RESTARTS. */
  private failSlot(slot: Slot, message: string): void {
    this.slots.delete(slot.id);
    slot.transcriber?.cancel();
    if (slot.finishing) {
      this.slotEnded(slot);
      return;
    }
    const attempt = (this.restarts.get(slot.lang) ?? 0) + 1;
    this.restarts.set(slot.lang, attempt);
    if (attempt > MAX_RESTARTS) {
      this.fail(`${languageName(slot.lang)} speech recognition stopped: ${message}`);
      return;
    }
    log("restart transcriber", { lang: slot.lang, attempt, message });
    const generation = this.generation;
    const run = slot.run;
    setTimeout(() => {
      if (generation === this.generation && run === this.run) this.startSlot(slot.lang, run);
    }, 1000 * 2 ** (attempt - 1));
  }

  private tick(): void {
    for (const run of this.runs) this.applyDecisions(run, run.picker.tick());
  }

  // ---- lines ----

  private handlePartial(slot: Slot, text: string, endS: number): void {
    const run = this.run;
    if (slot.run !== run || slot.lang !== run.picker.current || !text.trim()) return;
    const { mine } = this.st;
    const previous = this.st.live;
    const same = previous && previous.lang === slot.lang && !this.liveClosed;
    this.liveClosed = false;
    const live: ListenLine = {
      id: same ? previous.id : this.nextLineId++,
      lang: slot.lang,
      target: this.otherLanguage(slot.lang),
      text,
      translation: same ? previous.translation : "",
      final: false,
      mine: slot.lang === mine,
      atMs: same ? previous.atMs : Date.now(),
    };
    this.st.live = live;
    this.liveEndS = endS;
    this.notify();
    const now = Date.now();
    if (this.liveTranslating || now - this.liveTranslatedAt < LIVE_TRANSLATE_MS || countWords(text, slot.lang) < 2) return;
    this.liveTranslating = true;
    this.liveTranslatedAt = now;
    const generation = this.generation;
    void translateText(text, live.lang, live.target).then((result) => {
      this.liveTranslating = false;
      // Only onto the line it was made for, while it is still the live one.
      const current = this.st.live;
      if (generation !== this.generation || !result.out || current?.id !== live.id) return;
      this.st.live = { ...current, translation: result.out };
      this.notify();
    });
  }

  private applyDecisions(run: Run, decisions: Decision[]): void {
    if (!decisions.length) return;
    const { mine } = this.st;
    for (const decision of decisions) {
      if (decision.switched) {
        log("switch", { to: decision.lang, scores: decision.scores, words: decision.words });
      }
      // The live line was this utterance (in whichever language it was decided).
      if (this.st.live && this.liveEndS <= decision.end + LIVE_PAD_S) {
        this.st.live = null;
      }
      log("decision", { lang: decision.lang, start: decision.start, end: decision.end, scores: decision.scores, words: decision.words, text: decision.text });
      if (!decision.text.trim()) continue;
      const line: ListenLine = {
        id: this.nextLineId++,
        lang: decision.lang,
        target: this.otherLanguage(decision.lang),
        text: decision.text,
        translation: "",
        final: true,
        mine: decision.lang === mine,
        atMs: Date.now(),
      };
      this.st.lines = [...this.st.lines, line].slice(-MAX_LINES);
      this.translateLine(line);
    }
    if (run === this.run) this.st.current = run.picker.current;
    this.notify();
  }

  private translateLine(line: ListenLine): void {
    const generation = this.generation;
    void translateText(line.text, line.lang, line.target).then((result) => {
      if (generation !== this.generation) return;
      if (!result.out) {
        logError("translate failed", { from: line.lang, to: line.target, error: result.error, notInstalled: result.notInstalled, ms: result.ms });
        if (result.notInstalled && this.st.status === "listening") {
          this.st.message = `Open Translate on the phone to download ${languageName(line.lang)} → ${languageName(line.target)}.`;
          this.notify();
        }
        return;
      }
      log("translate", { from: line.lang, to: line.target, strategy: result.strategy, ms: result.ms, out: result.out });
      const index = this.st.lines.findIndex((entry) => entry.id === line.id);
      if (index < 0) return;
      const lines = this.st.lines.slice();
      lines[index] = { ...lines[index]!, translation: result.out };
      this.st.lines = lines;
      this.notify();
    });
  }

  private otherLanguage(lang: string): string {
    return lang === this.st.their ? this.st.mine : this.st.their;
  }

  // ---- glasses mic (the raw tap Microphones uses) ----

  private handlePcm(pcm: Uint8Array): void {
    const run = this.run;
    if (!run) return;
    this.samplesFed += pcm.length >> 1;
    for (const slot of this.slots.values()) {
      if (slot.run === run && !slot.finishing) slot.transcriber?.accept(pcm);
    }
    // At each pause, make both transcribers finalize through it: their finals then cover the same stretch.
    for (const at of run.endpointer.push(pcm)) {
      const through = run.startS + at;
      log("pause", { at: through, floor: Math.round(run.endpointer.floorDb), db: run.endpointer.recentDb.join(" ") });
      for (const slot of this.slots.values()) {
        if (slot.run === run && !slot.finishing) slot.transcriber?.finalize(through - slot.offsetS);
      }
    }
  }

  private startCapture(): boolean {
    const communicator = audioMonitorCommunicator();
    // The tap only records intent without a session; the capture check retries.
    if (!communicator?.isSessionReady()) return false;
    return voiceControlBridge.startRawCapture({ communicator, owner: RAW_CAPTURE_OWNER });
  }

  private stopCapture(): void {
    // Only a run takes the tap; another owner (Microphones) may still hold it.
    if (!this.offPcm) return;
    this.offPcm();
    this.offPcm = null;
    voiceControlBridge.stopRawCapture(RAW_CAPTURE_OWNER);
  }

  /**
   * As Microphones' checkStockCapture: the tap dies with the glasses session
   * and a voice capture preempts it, so restart it whenever it isn't live.
   * One restart is routine; only repeated failures show as waiting.
   */
  private checkCapture(): void {
    if (!this.run) return;
    let waiting: boolean;
    if (voiceControlBridge.isRawCaptureLive()) {
      this.captureRestarts = 0;
      waiting = false;
    } else if (!this.startCapture()) {
      waiting = true;
    } else {
      this.captureRestarts += 1;
      waiting = this.captureRestarts >= 2;
    }
    if (this.st.status !== "listening") return;
    const message = waiting ? WAITING_MIC : this.st.message === WAITING_MIC ? "" : this.st.message;
    if (message !== this.st.message) {
      if (waiting) log("mic waiting");
      this.st.message = message;
      this.notify();
    }
  }

  // ---- teardown and notification ----

  private fail(message: string): void {
    logError("error", { message });
    this.teardown();
    this.st = { ...this.st, status: "error", message, live: null };
    this.notify(true);
  }

  private teardown(): void {
    this.generation++;
    this.stopCapture();
    for (const slot of this.slots.values()) slot.transcriber?.cancel();
    this.slots.clear();
    this.runs.clear();
    this.run = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.tickTimer = this.captureTimer = null;
    this.liveTranslating = false;
  }

  /** At most one emit per NOTIFY_MS; `now` skips the wait (status changes). */
  private notify(now = false): void {
    const wait = NOTIFY_MS - (Date.now() - this.notifiedAt);
    if (!now && wait > 0) {
      this.notifyTimer ??= setTimeout(() => {
        this.notifyTimer = null;
        this.emit();
      }, wait);
      return;
    }
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.emit();
  }

  private emit(): void {
    this.notifiedAt = Date.now();
    const state = this.state;
    for (const fn of [...this.listeners]) {
      try {
        fn(state);
      } catch (error) {
        console.warn(`translate state listener failed: ${error}`);
      }
    }
  }
}

export const listenSession = new ListenSession();
