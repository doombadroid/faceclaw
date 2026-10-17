import { Application, Frame } from '@nativescript/core'
declare const FaceclawConfigPort: any

// Apply transferred preferences before settings getters or app workers load.
FaceclawConfigPort.processPendingRequest()
// Caught errors leave a report the owner sees (native/error-reports.ts); before anything can catch one.
const { installKotlinErrorReports } = require('./native/kotlin-error-reports.ios') as typeof import('./native/kotlin-error-reports.ios')
const { installErrorNotice } = require('./phone-ui/ios/error-reports-page') as typeof import('./phone-ui/ios/error-reports-page')
// The notice listens first: registering the Kotlin listener can deliver buffered reports.
try { installErrorNotice(); installKotlinErrorReports() } catch (error) { console.error(`error reports not installed: ${error}`) }
require('./phone-ui/onboarding-register.ios')
require('./phone-ui/ios/register')
// After the transferred preferences, before anything reads the provider.
const { migrateIosVoiceProvider } = require('./ui/dashboard-settings') as typeof import('./ui/dashboard-settings')
migrateIosVoiceProvider()
// Before Application.run: a notification action can cold-launch the app in the background.
const { installPhoneAlarmDelegate } = require('./native/alarms.ios') as typeof import('./native/alarms.ios')
// Alarm alerts must never stop the app from launching.
try { installPhoneAlarmDelegate() } catch (error) { console.error(`phone alarm delegate not installed: ${error}`) }
// Opt-in analytics (app/analytics/), started once the app is up.
// oxlint-disable-next-line typescript/no-deprecated -- still fires once, with the first window's content
Application.on(Application.launchEvent, () => {
  setTimeout(() => require('./analytics/analytics-sources').startAppAnalytics(), 0)
  // Parakeet redoes its slow Neural Engine build after each app or iOS update (in Swift, off the main thread).
  setTimeout(() => require('./native/asr-model').warmUpAsrModels(), 0)
})
const { hasCompletedOnboarding } = require('./phone-ui/onboarding-state') as typeof import('./phone-ui/onboarding-state')
const { createShell } = require('./phone-ui/ios/shell') as typeof import('./phone-ui/ios/shell')
// Finishing first-run onboarding swaps the root for the shell (ios/detour.ts finishDetour).
Application.run({ create: () => {
  if (hasCompletedOnboarding()) return createShell()
  const frame = new Frame()
  frame.navigate({ moduleName: 'phone-ui/onboarding-page' })
  return frame
} })
