import { presentDetour } from './detour'
import { presentOnTop } from './present'
import { pushInTab } from './shell'
import { getRuntime } from './runtime'
import { firmwareAlertTitle, firmwareSummary, reportedState } from './firmware-info'

type AlertAction = [label: string, style: UIAlertActionStyle, run?: () => unknown]

/** A native alert whose first action is the preferred one; resolves once an action has run. */
function nativeAlert(title: string, message: string, actions: AlertAction[]): Promise<void> {
  return new Promise(resolve => {
    const alert = UIAlertController.alertControllerWithTitleMessagePreferredStyle(title, message, UIAlertControllerStyle.Alert)
    actions.forEach(([label, style, run], i) => {
      const item = UIAlertAction.actionWithTitleStyleHandler(label, style, () => { void Promise.resolve(run?.()).then(() => resolve()) })
      alert.addAction(item)
      if (i === 0) alert.preferredAction = item
    })
    if (!presentOnTop(alert)) resolve()
  })
}

/**
 * Offer the firmware fix for a session's firmware warning: one condition, one
 * decision, as a native alert titled by what the glasses reported.
 */
export function showFirmwareAlert(message: string): Promise<void> {
  const title = firmwareAlertTitle(firmwareSummary(reportedState(getRuntime().controller.connectionState)).extension)
  return nativeAlert(title, message, [
    ['Install', UIAlertActionStyle.Default, () => presentDetour('phone-ui/onboarding-flash-page', { mode: 'install', fromOnboarding: false })],
    ['What Changes?', UIAlertActionStyle.Default, () => pushInTab('glasses', 'ocusmart/update')],
    ['Not Now', UIAlertActionStyle.Cancel],
  ])
}

/** The firmware check extracts the fonts when custom firmware is already installed. */
export function showFontsAlert(): Promise<void> {
  return nativeAlert('G2 Fonts Missing', 'The G2 fonts have not been extracted, so EvenHub apps will render with fallback fonts. ' +
    'Preparing them downloads the official firmware to extract its fonts; your glasses are not reflashed.', [
    ['Prepare G2 Fonts', UIAlertActionStyle.Default, () => presentDetour('phone-ui/onboarding-firmware-check-page')],
    ['Not Now', UIAlertActionStyle.Cancel],
  ])
}
