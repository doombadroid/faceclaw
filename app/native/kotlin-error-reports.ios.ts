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
    onCaughtErrorSourceMessageStack: (source: string, message: string, stack: string) =>
      reportError(String(source), { message: String(message), stack: String(stack) }),
  })
  FaceclawKitIosErrorReports.shared.listener = listener
}
