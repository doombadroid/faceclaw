import { Frame } from '@nativescript/core'

/** Return to the main page after onboarding or a devices/firmware detour. iOS: onboarding-navigation.ios.ts. */
export function finishOnboardingNavigation(): void {
  const frame = Frame.topmost()
  frame?.navigate({ moduleName: 'phone-ui/main-page', clearHistory: true })
}
