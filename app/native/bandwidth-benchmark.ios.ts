import { FaceclawCommunicatorBridge } from './faceclaw-communicator.ios'
import type { BandwidthBenchmarkStatus } from './bandwidth-benchmark'
export type { BandwidthBenchmarkStatus }

const native = (): any => FaceclawCommunicatorBridge.getActive()?.getNativeCommunicator()

/** CoreBluetooth picks the connection interval and PHY itself, so linkMode is ignored on iOS. */
export function startBandwidthBenchmark(messageSize: number, windowSize: number, durationMs: number, linkMode = 0): boolean {
  return Boolean(native()?.startBandwidthBenchmarkWithLinkModeMessageSizeWindowSizeDurationMsLinkMode(
    Math.round(messageSize), Math.round(windowSize), Math.round(durationMs), Math.round(linkMode)))
}

export function cancelBandwidthBenchmark(): void {
  native()?.cancelBandwidthBenchmark()
}

export function getBandwidthBenchmarkStatus(): BandwidthBenchmarkStatus | null {
  const session = native()
  if (!session) return null
  try {
    return JSON.parse(String(session.getBandwidthBenchmarkStatus())) as BandwidthBenchmarkStatus
  } catch {
    return null
  }
}
