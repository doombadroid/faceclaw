import { presentDetour } from './detour'
import { presentOnTop } from './present'
import { pushInTab } from './shell'
import { getRuntime } from './runtime'
import { firmwareAlertTitle, firmwareSummary, reportedState } from './firmware-info'

/**
 * Offer the firmware fix for a session's firmware warning: one condition, one
 * decision, as a native alert titled by what the glasses reported.
 */
export function showFirmwareAlert(message: string): Promise<void> {
  const title = firmwareAlertTitle(firmwareSummary(reportedState(getRuntime().controller.connectionState)).extension)
  return new Promise(resolve => {
    const alert = UIAlertController.alertControllerWithTitleMessagePreferredStyle(title, message, UIAlertControllerStyle.Alert)
    const action = (label: string, style: UIAlertActionStyle, run?: () => unknown) => {
      const item = UIAlertAction.actionWithTitleStyleHandler(label, style, () => { void Promise.resolve(run?.()).then(() => resolve()) })
      alert.addAction(item)
      return item
    }
    alert.preferredAction = action('Install', UIAlertActionStyle.Default,
      () => presentDetour('phone-ui/onboarding-flash-page', { mode: 'install', fromOnboarding: false }))
    action('What Changes?', UIAlertActionStyle.Default, () => pushInTab('glasses', 'ocusmart/update'))
    action('Not Now', UIAlertActionStyle.Cancel)
    if (!presentOnTop(alert)) resolve()
  })
}
