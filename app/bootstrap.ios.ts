import { Application, Frame } from '@nativescript/core'
import { logJsError } from './native/callback-errors.ios'

// nativescript.config.ts discards uncaught JS errors instead of ending the app; each becomes an error report.
Application.on(Application.discardedErrorEvent, (args) => logJsError('uncaught JS', args.error))
Application.on(Application.uncaughtErrorEvent, (args) => logJsError('uncaught JS', args.error))

// Apply transferred preferences before settings getters or app workers load.
FaceclawConfigPort.processPendingRequest()
// Caught errors leave a report the owner sees (native/error-reports.ts); before anything can catch one.
const { installKotlinErrorReports } = require('./native/kotlin-error-reports.ios') as typeof import('./native/kotlin-error-reports.ios')
const { installErrorNotice } = require('./phone-ui/ios/error-reports-page') as typeof import('./phone-ui/ios/error-reports-page')
// The notice listens first: registering the Kotlin listener can deliver buffered reports. Each has
// its own try: a notice that fails must not leave Kotlin's reports buffered for the whole session,
// and either failure still reaches disk and Settings > General > Error Reports.
try { installErrorNotice() } catch (error) { logJsError('error reports install', error) }
try { installKotlinErrorReports() } catch (error) { logJsError('error reports install', error) }
// Wireless logging while Settings > General > Developer > Remote Log URL is set; settings load on first use.
try {
  const settings = () => require('./ui/dashboard-settings') as typeof import('./ui/dashboard-settings')
  const { installRemoteLog } = require('./native/remote-log.ios') as typeof import('./native/remote-log.ios')
  // The Even Hub token too: a This Session Only one is in memory, not in a setting.
  const evenHub = () => require('./apps/evenhub/credentials') as typeof import('./apps/evenhub/credentials')
  installRemoteLog({ url: () => settings().remoteLogUrlSetting.get(), secretValues: () => [...settings().secretSettingValues(), evenHub().getEvenHubToken()] })
} catch (error) { logJsError('remote log install', error) }
require('./phone-ui/onboarding-register.ios')
require('./phone-ui/ios/register')
// After the transferred preferences, before anything reads the provider.
const { migrateIosVoiceProvider } = require('./ui/dashboard-settings') as typeof import('./ui/dashboard-settings')
migrateIosVoiceProvider()
// Before Application.run: a notification action can cold-launch the app in the background.
const { installPhoneAlarmDelegate } = require('./native/alarms.ios') as typeof import('./native/alarms.ios')
// Alarm alerts must never stop the app from launching.
try { installPhoneAlarmDelegate() } catch (error) { logJsError('phone alarm delegate install', error) }
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
