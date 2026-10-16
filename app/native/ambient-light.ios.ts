import { FaceclawCommunicatorBridge } from './faceclaw-communicator.ios'
import { fromKotlinBytes } from './kotlin-data'
import { kotlinListener } from './kotlin-listener.ios'
import { decodeAmbientLightReport, type AmbientLightPollingOptions, type AmbientLightReport } from './ambient-light-report'
export * from './ambient-light-report'

declare const FaceclawKitFaceclawAmbientLightListener: any

const native = (): any => FaceclawCommunicatorBridge.getActive()?.getNativeCommunicator()

export function queryAmbientLight(): void {
  native()?.queryAmbientLight()
}

export function setAmbientLightPolling(enabled: boolean, options: AmbientLightPollingOptions = {}): void {
  native()?.setAmbientLightPollingEnableIntervalMsMinDeltaHeartbeatMsBindToLease(enabled, options.intervalMs ?? 500,
    options.minDelta ?? 1, options.heartbeatMs ?? 5000, options.bindToLease ?? true)
}

/** Bound to the current session, as on Android: reopen the page after a reconnect. */
export function addAmbientLightListener(listener: (report: AmbientLightReport) => void): () => void {
  const session = native()
  if (!session) return () => {}
  const proxy = kotlinListener(FaceclawKitFaceclawAmbientLightListener, {
    onAmbientLightBody: (body: any) => {
      const report = decodeAmbientLightReport(fromKotlinBytes(body))
      if (report) listener(report)
    },
  })
  session.addAmbientLightListenerListener(proxy)
  return () => { session.removeAmbientLightListenerListener(proxy) }
}
