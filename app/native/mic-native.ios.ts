/**
 * iOS twin of mic-native.ts over FaceclawKit: the shared Kotlin store on the
 * FaceclawSqlite shim, the shared suppressor and caption session (Apple's
 * recognizer per utterance, no voice-prints), and a WAV recorder. PCM crosses
 * as NSData. Each object is wrapped to Android's method names.
 */
import { knownFolders } from "@nativescript/core";

import type { CaptionCallbacks } from "./mic-native";
import { toData } from "./kotlin-data";
import { kotlinListener } from "./kotlin-listener.ios";

export type { CaptionCallbacks } from "./mic-native";

declare const FaceclawKitIosConversationStore: any;
declare const FaceclawKitIosNoiseSuppressor: any;
declare const FaceclawKitIosCaptionEngine: any;
declare const FaceclawKitIosWavRecorder: any;
declare const FaceclawKitFaceclawCaptionEngineListener: any;
declare const FaceclawSqlite: any;
declare const FaceclawSpeech: any;

/** Android method name -> the Kotlin export's ObjC-derived name. */
function adapt(native: any, names: Record<string, string>): any {
  const out: any = {};
  for (const [name, selector] of Object.entries(names)) out[name] = (...args: unknown[]) => native[selector](...args);
  return out;
}

const STORE_METHODS: Record<string, string> = {
  startSession: "startSessionStartedAtMsTitle",
  endSession: "endSessionSessionIdEndedAtMsAudioPathAudioCodecAvgSentiment",
  setSessionAudio: "setSessionAudioSessionIdAudioPathAudioCodec",
  getSessionAudioPath: "getSessionAudioPathSessionId",
  querySessions: "querySessionsFilterJson",
  insertSegment: "insertSegmentJson",
  updateSegment: "updateSegmentSegmentIdJson",
  querySegments: "querySegmentsSessionId",
  searchSegments: "searchSegmentsFilterJson",
  querySegmentEmbeddings: "querySegmentEmbeddingsSessionId",
  createSpeaker: "createSpeakerNameColorIsWearerEmbeddingBase64",
  querySpeakers: "querySpeakers",
  renameSpeaker: "renameSpeakerSpeakerIdName",
  setSpeakerColor: "setSpeakerColorSpeakerIdColor",
  setSpeakerTag: "setSpeakerTagSpeakerIdTag",
  setSpeakerInsights: "setSpeakerInsightsSpeakerIdRecapActionItemsJsonFactsJsonSessionId",
  setSpeakerWearer: "setSpeakerWearerSpeakerIdIsWearer",
  updateSpeakerEmbedding: "updateSpeakerEmbeddingSpeakerIdEmbeddingBase64MaxCount",
  mergeSpeakers: "mergeSpeakersFromIdIntoId",
  reassignSegmentSpeaker: "reassignSegmentSpeakerSegmentIdSpeakerId",
  reassignSessionSpeaker: "reassignSessionSpeakerSessionIdFromSpeakerIdToSpeakerId",
  deleteSpeaker: "deleteSpeakerSpeakerId",
  applyRetention: "applyRetentionCaptionCutoffMsRecordingCutoffMs",
  closeInterruptedSessions: "closeInterruptedSessionsExcludeIdsJson",
  deleteUnreferencedRecordings: "deleteUnreferencedRecordingsDirPath",
  deleteSession: "deleteSessionSessionId",
};

let store: any = null;

export function conversationStore(): any {
  if (store) return store;
  const port = FaceclawSqlite.alloc().initWithPath(`${knownFolders.ios.library().path}/faceclaw-conversations.db`);
  if (!port) throw new Error("conversation store could not open");
  store = adapt(FaceclawKitIosConversationStore.alloc().initWithPort(port), STORE_METHODS);
  return store;
}

export function createNoiseSuppressor(sampleRate: number): any {
  return adapt(FaceclawKitIosNoiseSuppressor.alloc().initWithSampleRate(sampleRate), { process: "processPcm", reset: "reset" });
}

export function noiseSuppressorEngine(): string {
  return "Spectral suppression";
}

export function toNativePcm(pcm: Uint8Array): any {
  return toData(pcm);
}

export function createCaptionEngine(): any {
  const engine = FaceclawKitIosCaptionEngine.new();
  return {
    ...adapt(engine, { setListener: "setListenerListener", setAsrModelDir: "setAsrModelDirDir", start: "start", stop: "stop",
      requestStop: "requestStop", acceptPcm: "acceptPcmPcm" }),
    // No voice-print model on iOS yet.
    setSpeakerModelPath: () => {},
  };
}

export function createCaptionListener(callbacks: CaptionCallbacks): any {
  return kotlinListener(FaceclawKitFaceclawCaptionEngineListener, {
    onUtteranceTextEmbeddingStartMsEndMsPeakRms: (text: string, _embedding: unknown, startMs: number, endMs: number, peakRms: number) =>
      callbacks.onUtterance(String(text ?? ""), null, Number(startMs), Number(endMs), Number(peakRms)),
    onSpeechStartStartMs: (startMs: number) => callbacks.onSpeechStart(Number(startMs)),
    onStatusStatus: (status: string) => callbacks.onStatus(String(status ?? "")),
    onStoppedError: (error: string | null) => callbacks.onStopped(error ?? null),
  });
}

/** Apple ships the recognizer's models; any non-null dir turns recognition on. */
export function captionAsrDir(): string | null {
  return "apple-speech";
}

/** Speech Recognition can only be granted from the foreground; the caption engine checks it per start. */
export function prepareCaptions(): void {
  if (FaceclawSpeech.authorizationStatus() !== 0) return;
  if (UIApplication.sharedApplication.applicationState !== UIApplicationState.Active) return;
  FaceclawSpeech.requestAuthorization(() => {});
}

/** iOS has no voice-print model yet, so captions never carry embeddings. */
export function embeddingToFloat32(_embedding: unknown): Float32Array {
  return new Float32Array(0);
}

export function createWavRecorder(path: string, sampleRate: number, channels: number): any {
  const recorder = FaceclawKitIosWavRecorder.alloc().initWithPathSampleRateChannels(path, sampleRate, channels);
  if (!recorder.isOpen()) throw new Error(`could not create ${path}`);
  return adapt(recorder, { append: "appendPcm", getDurationMs: "getDurationMs", finish: "finish", discard: "discard" });
}

export function repairWavHeader(path: string, sampleRate: number, channels: number): number {
  return Number(FaceclawKitIosWavRecorder.companion.repairHeaderPathSampleRateChannels(path, sampleRate, channels));
}

/** AVAudioPlayer behind MediaPlayer's names. Plays under the app's current audio session (the ring/silent switch mutes it). */
export function createRecordingPlayer(path: string, onComplete: () => void): any {
  const player = AVAudioPlayer.alloc().initWithContentsOfURLError(NSURL.fileURLWithPath(path));
  // The delegate is weak: the returned object holds it for the player's life.
  const delegate = kotlinListener(AVAudioPlayerDelegate, { audioPlayerDidFinishPlayingSuccessfully: () => onComplete() });
  player.delegate = delegate as unknown as AVAudioPlayerDelegate;
  player.prepareToPlay();
  return {
    delegate,
    seekTo: (ms: number) => { player.currentTime = ms / 1000; },
    start: () => { player.play(); },
    pause: () => { player.pause(); },
    release: () => { player.stop(); },
  };
}

export function recordingsDir(): string {
  return `${knownFolders.documents().path}/mic-recordings`;
}

export function deleteFile(path: string): void {
  try {
    NSFileManager.defaultManager.removeItemAtPathError(path);
  } catch (error) {
    console.warn(`could not delete ${path}: ${error}`);
  }
}

/** ponytail: recordings stay WAV on iOS (~115 MB/hour, bounded by retention); AVAssetExportSession to M4A when disk use matters. */
export function transcodeRecording(_store: any, _rowId: number, _wavPath: string): void {}
