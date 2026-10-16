import { Application, Frame } from '@nativescript/core'
declare const FaceclawConfigPort: any

// Apply transferred preferences before settings getters or app workers load.
FaceclawConfigPort.processPendingRequest()
require('./phone-ui/onboarding-register.ios')
require('./phone-ui/ios/register')
// Opt-in analytics (app/analytics/), started once the app is up.
Application.on(Application.launchEvent, () => {
  setTimeout(() => require('./analytics/analytics-sources').startAppAnalytics(), 0)
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
