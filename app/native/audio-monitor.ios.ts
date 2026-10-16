/** iOS twin of audio-monitor.ts: the same passive view, over the active session bridge. */
import { FaceclawCommunicatorBridge } from "./faceclaw-communicator.ios";

export type AudioArm = "L" | "R" | "?";

/** The bridge listeners attach to; a new one per connection. */
export function audioMonitorCommunicator(): FaceclawCommunicatorBridge | null {
  return FaceclawCommunicatorBridge.getActive();
}

export function isFaceclawAudioCaptureActive(): boolean {
  try {
    return Boolean(FaceclawCommunicatorBridge.getActive()?.getNativeCommunicator().isAudioCaptureActive());
  } catch {
    return false;
  }
}

/** Every audio packet and field-104 mic status record body, on the main queue. Returns an unsubscribe function. */
export function addAudioMonitorListeners(
  communicator: FaceclawCommunicatorBridge | null,
  onPacket: (data: Uint8Array, arm: AudioArm, arrivalMs: number) => void,
  onStatus: (body: Uint8Array, arm: AudioArm) => void,
): () => void {
  if (!communicator) return () => {};
  const offs = [
    communicator.addAudioMonitorListener((data, arm, arrivalMs) => onPacket(data, toArm(arm), arrivalMs)),
    communicator.addMicStatusListener((body, arm) => onStatus(body, toArm(arm))),
  ];
  return () => {
    for (const off of offs) {
      try {
        off();
      } catch {
        // The session may have been torn down during a disconnect.
      }
    }
  };
}

function toArm(arm: string): AudioArm {
  return arm === "L" || arm === "R" ? arm : "?";
}
