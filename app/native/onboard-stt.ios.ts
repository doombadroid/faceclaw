/**
 * The On-device (Moonshine) and On-device (Whisper) providers on iOS: the
 * downloaded sherpa-onnx model as a CloudSttClient, so the voice bridge feeds
 * it FaceclawSpeech's PCM exactly as it feeds a cloud provider (and wraps it in
 * the same ReconnectingSttClient for buffering until ready and pause commits).
 * Decoding is FaceclawKit's IosOnDeviceTranscriber (Android's segmented
 * transcript) over the FaceclawSherpa shim.
 */
import type { CloudSttClient, CloudSttOptions } from "./cloud-stt";
import type { VoiceProviderKind } from "./voice-control";
import { asrModelDir, isAsrModelReady, type AsrModelId } from "./asr-model";
import { toData } from "./kotlin-data";
import { kotlinListener } from "./kotlin-listener.ios";

declare const FaceclawSherpa: any;
declare const FaceclawKitIosOnDeviceTranscriber: any;
declare const FaceclawKitIosTranscriptListener: any;

let loader: any = null;

/** The app's one FaceclawSherpa model loader (FaceclawKitIosSherpaLoader). */
export function sherpaLoader(): any {
  if (!loader) loader = FaceclawSherpa.new();
  return loader;
}

/** The downloaded model an on-device provider uses, or null for Apple's recognizer and the cloud. */
export function onboardModel(provider: VoiceProviderKind): AsrModelId | null {
  if (provider === "onboard-moonshine") return "moonshine";
  if (provider === "onboard-whisper") return "whisper-base-en";
  return null;
}

/** An actionable error when the provider's model is missing, else ''. */
export function onboardModelError(model: AsrModelId): string {
  return isAsrModelReady(model) ? "" : "Download the on-device voice model first (Settings > Voice).";
}

export function createOnboardSttClient(model: AsrModelId, options: CloudSttOptions): CloudSttClient {
  // Kotlin holds the listener while the transcriber runs; the client keeps the JS side alive too.
  const listener = kotlinListener(FaceclawKitIosTranscriptListener, {
    onReady: () => {
      options.onStatus("Listening…");
      options.onReady?.();
    },
    onTranscriptTextIsFinal: (text: string, isFinal: boolean) => options.onTranscript({ text: String(text ?? ""), isFinal: !!isFinal }),
    onErrorMessage: (message: string) => options.onError(String(message ?? "On-device transcription failed.")),
  });
  const transcriber = FaceclawKitIosOnDeviceTranscriber.alloc()
    .initWithLoaderModelDirWhisperListener(sherpaLoader(), asrModelDir(model), model === "whisper-base-en", listener);
  return {
    listener,
    start: () => {
      options.onStatus("Loading voice model…");
      transcriber.start();
    },
    acceptPcm: (pcm: Uint8Array) => transcriber.acceptPcmPcm(toData(pcm)),
    commitSegment: () => transcriber.commitSegment(),
    finish: () => transcriber.finish(),
    stop: () => transcriber.cancel(),
  } as CloudSttClient;
}
