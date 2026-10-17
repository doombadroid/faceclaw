/**
 * Errors FaceclawKit's facades caught (IosErrorReports.record) become error reports.
 * Not named error-reports.ios.ts: that would shadow error-reports.ts on iOS.
 */
import { kotlinListener } from './kotlin-listener.ios'
import { reportError } from './error-reports'

declare const FaceclawKitIosErrorReports: any
declare const FaceclawKitIosErrorReportListener: any

let listener: object | null = null

/** Once at startup; Kotlin buffers what it caught before this and delivers it now. */
export function installKotlinErrorReports(): void {
  if (listener) return
  // Kept referenced: Kotlin holds the proxy, but the JS side must stay alive too.
  listener = kotlinListener(FaceclawKitIosErrorReportListener, {
    // Kotlin forwards a repeat only at counts 2, 4, 8..., with the occurrences in between.
    onCaughtErrorSourceMessageStackOccurrences: (source: string, message: string, stack: string, occurrences: number) =>
      reportError(String(source), { message: String(message), stack: String(stack) }, undefined, Number(occurrences)),
  })
  FaceclawKitIosErrorReports.shared.listener = listener
}
