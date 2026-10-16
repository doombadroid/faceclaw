import { Dialogs } from '@nativescript/core'
import { presentDetour } from './detour'

/** Offer the firmware fix for a session's firmware warning. */
export async function showFirmwareAlert(message: string): Promise<void> {
  const install = await Dialogs.confirm({ title: 'Attention needed', message,
    okButtonText: 'Install custom firmware', cancelButtonText: 'Close' })
  if (install) await presentDetour('phone-ui/onboarding-flash-page', { mode: 'install', fromOnboarding: false })
}
