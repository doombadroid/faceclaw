import type { TileColor } from './ui-kit'
import { ALL_APPS } from '../../apps/all-apps'
import type { AppDefinition } from '../../apps/app-definition'
import { iosAppUnavailableReason } from '../../apps/ios-availability'
import { ONBOARDING_APP_ID } from '../../apps/onboarding/onboarding-progress'
import { getInstalledEvenHubApps, type InstalledEvenHubApp } from '../../apps/evenhub/installed-apps'

/**
 * The one rule for what the phone calls a launchable app: launcher-visible
 * built-ins that run on iOS, plus installed EvenHub packages. The glasses
 * Settings app is left out because the Settings tab replaces it; iOS-unavailable
 * built-ins come back separately, with the reason the glasses show.
 */
export function appCatalog(): { builtIn: AppDefinition[]; unavailable: { app: AppDefinition; reason: string }[]; hub: InstalledEvenHubApp[] } {
  const builtIn: AppDefinition[] = [], unavailable: { app: AppDefinition; reason: string }[] = []
  for (const app of ALL_APPS) {
    if (app.showInLauncher === false || app.appId === ONBOARDING_APP_ID || app.appId === 'settings') continue
    const reason = iosAppUnavailableReason(app.appId)
    if (reason) unavailable.push({ app, reason })
    else builtIn.push(app)
  }
  return { builtIn, unavailable, hub: getInstalledEvenHubApps() }
}

/** What the Apps tab lists under BUILT IN and FROM EVEN HUB. */
export function launchableAppCount(): number {
  const { builtIn, hub } = appCatalog()
  return builtIn.length + hub.length
}

const PALETTE: TileColor[] = ['blue', 'red', 'purple', 'green', 'orange', 'gray', 'indigo', 'teal']

/** A stable tile colour per app id (FNV-1a), the same on every tab and every launch. */
export function tileColor(appId: string): TileColor {
  let hash = 0x811c9dc5
  for (let i = 0; i < appId.length; i++) hash = Math.imul(hash ^ appId.charCodeAt(i), 0x01000193)
  return PALETTE[(hash >>> 0) % PALETTE.length]
}
