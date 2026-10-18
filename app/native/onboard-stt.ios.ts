/**
 * The On-device (Parakeet), (Moonshine) and (Whisper) providers on iOS: the
 * downloaded model (FluidAudio's Parakeet, or sherpa-onnx) as a CloudSttClient, so the voice bridge feeds
 * it FaceclawSpeech's PCM exactly as it feeds a cloud provider (and wraps it in
 * the same ReconnectingSttClient for buffering until ready and pause commits).
 * Decoding is FaceclawKit's IosOnDeviceTranscriber (Android's segmented
 * transcript) over the FaceclawSherpa shim.
 */
import type { CloudSttClient, CloudSttOptions } from "./cloud-stt";
import type { PushToTalkOptions, VoiceProviderKind } from "./voice-control";
import { asrModelDir, isAsrModelReady, isAsrModelWarm, type AsrModelId } from "./asr-model";
import { toData } from "./kotlin-data";
import { kotlinListener } from "./kotlin-listener.ios";


let loader: FaceclawSherpa | null = null;

/** The app's one FaceclawSherpa model loader (FaceclawKitIosSherpaLoader); it hands the Parakeet folder to FluidAudio. */
export function sherpaLoader(): FaceclawSherpa {
  if (!loader) loader = FaceclawSherpa.new();
  return loader;
}

/** The downloaded model an on-device provider uses, or null for Apple's recognizer and the cloud. */
export function onboardModel(provider: VoiceProviderKind): AsrModelId | null {
  // Until Parakeet is downloaded and warmed up for this build, its captures use Apple's recognizer.
  if (provider === "onboard-parakeet") return isAsrModelWarm("parakeet-v3") ? "parakeet-v3" : null;
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
    onTranscriptTextIsFinal_: (text: string, isFinal: boolean) => options.onTranscript({ text: String(text ?? ""), isFinal: !!isFinal }),
    onErrorMessage_: (message: string) => options.onError(String(message ?? "On-device transcription failed.")),
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

export type SpeakerVerdict = { isWearer: boolean; similarity: number };

export type SpeakerVerifier = {
  /** Capture PCM (16 kHz mono S16LE) as it arrives; the first 10 s are kept. */
  acceptPcm(pcm: NSData): void;
  /** Starts the check on the first call; fails open (isWearer) like Android. */
  verdict(): Promise<SpeakerVerdict>;
};

/** "My voice only" for one capture: FaceclawKit's IosSpeakerVerifier over the voice-print model. */
export function createSpeakerVerifier(options: NonNullable<PushToTalkOptions["speakerVerification"]>): SpeakerVerifier {
  let resolve: (verdict: SpeakerVerdict) => void = () => {};
  const result = new Promise<SpeakerVerdict>((done) => { resolve = done; });
  const listener = kotlinListener(FaceclawKitIosSpeakerVerifiedListener, {
    onVerifiedIsWearerSimilarity: (isWearer: boolean, similarity: number) => resolve({ isWearer: !!isWearer, similarity: Number(similarity) }),
  });
  const print = options.wearerEmbedding;
  const native = FaceclawKitIosSpeakerVerifier.alloc().initWithLoaderModelPathWearerThresholdListener(
    sherpaLoader(), options.speakerModelPath, toData(new Uint8Array(print.buffer.slice(print.byteOffset, print.byteOffset + print.byteLength))),
    options.threshold, listener);
  let started = false;
  return {
    listener,
    acceptPcm: (pcm: NSData) => native.acceptPcmChunk(pcm),
    verdict: () => {
      if (!started) native.verify();
      started = true;
      return result;
    },
  } as SpeakerVerifier;
}
