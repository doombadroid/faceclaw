/**
 * The Microphones app's native seam (Android): conversation store, noise
 * suppressor, caption engine, WAV recorder and transcoder. mic-native.ios.ts
 * supplies the same calls over FaceclawKit with the same method names.
 */
import { Utils } from "@nativescript/core";

import { toJavaBytes } from "./cloud-stt";
import { toUint8Array } from "../util/array-util";
import { isAsrModelReady } from "./asr-model";

declare const android: any;
declare const com: any;
declare const java: any;

export type CaptionCallbacks = {
  onUtterance(text: string, embedding: any, startMs: number, endMs: number, peakRms: number): void;
  onSpeechStart(startMs: number): void;
  onStatus(status: string): void;
  onStopped(error: string | null): void;
};

export function conversationStore(): any {
  const context = Utils.android.getApplicationContext();
  return com.faceclaw.app.FaceclawConversationStore.getInstance(context);
}

export function createNoiseSuppressor(sampleRate: number): any {
  return new com.faceclaw.app.FaceclawNoiseSuppressor(sampleRate);
}

export function noiseSuppressorEngine(): string {
  return String(com.faceclaw.app.FaceclawNoiseSuppressor.engineDescription());
}

/** PCM as the native consumers take it (a Java byte[]). */
export function toNativePcm(pcm: Uint8Array): any {
  return toJavaBytes(pcm);
}

export function createCaptionEngine(): any {
  return new com.faceclaw.app.FaceclawCaptionEngine();
}

export function createCaptionListener(callbacks: CaptionCallbacks): any {
  return new com.faceclaw.app.FaceclawCaptionEngineListener(callbacks);
}

/**
 * Live captions are a separate sherpa-onnx pipeline (FaceclawCaptionEngine)
 * that only ever uses Moonshine; unaffected by the two-model on-device
 * Whisper addition in native/voice-control.ts's push-to-talk path. Null
 * leaves the engine without ASR.
 */
export function captionAsrDir(): string | null {
  if (!isAsrModelReady("moonshine")) return null;
  const context = Utils.android.getApplicationContext();
  return `${context.getFilesDir().getAbsolutePath()}/faceclaw-voice-asr/sherpa-onnx-moonshine-base-en-quantized-2026-02-27`;
}

/** Ask for what captions need while the phone is in front of the user (nothing on Android). */
export function prepareCaptions(): void {}

export function embeddingToFloat32(javaFloats: any): Float32Array {
  const length = javaFloats.length;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Number(javaFloats[i]);
  return out;
}

/** The CFW mic_control forwarding listener; keep it referenced while forwarding runs. */
export function createForwardingListener(handler: (packet: Uint8Array, arm: string) => void): any {
  return new com.faceclaw.app.FaceclawAudioPacketListener({
    onAudioPacket: (data: any, arm: string, _arrivalMs: number) => handler(toUint8Array(data), String(arm)),
  });
}

/** False before Connect or while another capture holds the glasses mic. */
export function startForwarding(communicator: any, listener: any): boolean {
  return Boolean(communicator.startG2AudioForwarding(listener));
}

export function stopForwarding(communicator: any): void {
  communicator?.stopG2AudioForwarding();
}

export function createWavRecorder(path: string, sampleRate: number, channels: number): any {
  return new com.faceclaw.app.FaceclawWavRecorder(path, sampleRate, channels);
}

export function repairWavHeader(path: string, sampleRate: number, channels: number): number {
  return Number(com.faceclaw.app.FaceclawWavRecorder.repairHeader(path, sampleRate, channels));
}

/** A recording player with MediaPlayer's seekTo(ms)/start/pause/release; onComplete runs on the main thread. */
export function createRecordingPlayer(path: string, onComplete: () => void): any {
  const player = new android.media.MediaPlayer();
  player.setDataSource(path);
  player.prepare();
  player.setOnCompletionListener(
    new android.media.MediaPlayer.OnCompletionListener({
      onCompletion: () => Utils.executeOnMainThread(onComplete),
    }),
  );
  return player;
}

export function recordingsDir(): string {
  const context = Utils.android.getApplicationContext();
  return `${context.getExternalFilesDir(null).getAbsolutePath()}/mic-recordings`;
}

export function deleteFile(path: string): void {
  try {
    new java.io.File(path).delete();
  } catch (error) {
    console.warn(`could not delete ${path}: ${error}`);
  }
}

const RECORDING_AAC_BITRATE = 32_000;
// Transcoder listeners are referenced only from Java while a transcode runs;
// hold them here so they aren't GC'd before their callback.
const pendingTranscodes = new Set<any>();

/**
 * Transcode a finished WAV recording to M4A in the background and move its
 * session onto it. The WAV is deleted only once the row names the M4A, so a
 * failure at any step leaves the session pointing at a file that exists.
 */
export function transcodeRecording(store: any, rowId: number, wavPath: string): void {
  const m4aPath = wavPath.replace(/\.wav$/, ".m4a");
  const listener = new com.faceclaw.app.FaceclawAudioTranscoder.Listener({
    onDone: (outputPath: string, _outputBytes: number) => {
      pendingTranscodes.delete(listener);
      try {
        store.setSessionAudio(rowId, String(outputPath), "aac");
      } catch (error) {
        console.warn(`recording audio update failed: ${error}`);
        deleteFile(String(outputPath));
        return;
      }
      deleteFile(wavPath);
    },
    onError: (message: string) => {
      pendingTranscodes.delete(listener);
      console.warn(`recording transcode failed: ${message}`);
    },
  });
  pendingTranscodes.add(listener);
  try {
    // deleteSourceOnSuccess false: the WAV goes only after the row update above.
    new com.faceclaw.app.FaceclawAudioTranscoder(wavPath, m4aPath, RECORDING_AAC_BITRATE, false, listener).start();
  } catch (error) {
    pendingTranscodes.delete(listener);
    console.warn(`recording transcode start failed: ${error}`);
  }
}
