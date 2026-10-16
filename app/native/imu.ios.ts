import { type ImuReading } from './imu-types'
export * from './imu-types'

type ImuSession = { setImuReportEnabled(enable: boolean, reportFreq: number): void }
const listeners = new Set<(reading: ImuReading) => void>()
let session: ImuSession | null = null
let desired = { enable: false, freq: 0 }

/** Listeners and the requested stream survive disconnect/reconnect and opening before Connect. */
export function bindImuSession(next: ImuSession): void {
  session = next
}

/** The Kotlin core drops an enable sent before the session is ready, so re-send it on connect. */
export function imuSessionReady(): void {
  if (desired.enable) session?.setImuReportEnabled(true, desired.freq)
}

export function setImuReportEnabled(enable: boolean, reportFreq: number): void {
  desired = { enable, freq: Math.max(0, Math.round(reportFreq)) }
  session?.setImuReportEnabled(desired.enable, desired.freq)
}

export function addImuListener(listener: (reading: ImuReading) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function receiveImuReading(reading: ImuReading): void {
  for (const listener of [...listeners]) listener(reading)
}
