import { Dialogs, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, buttonRow, valueRow, type Row } from './ui-kit'
import { getRuntime } from './runtime'
import type { SessionState } from '../../g2/ios-preview-controller'
import { presentDetour } from './detour'
import { showFirmwareAlert } from './firmware-alert'
import { pushInTab } from './shell'
import { isPreviewOnlyMode } from '../onboarding-state'
import { resumeAutoReconnect, suppressAutoReconnect } from '../../g2/reconnect-policy'
import { loadDeviceAddresses } from '../../g2/device-addresses'
import { deviceAddressError } from '../../g2/ios-peripheral-identity'

// Frame acks also emit 'connection'; rebuild only when what the page shows changes.
const shownKey = (state: SessionState | null) => [state?.phase, state?.status, state?.firmwareWarning].join('\n')
const PHASE_LABELS = { connected: 'Connected', disconnected: 'Preview', connecting: 'Connecting',
  retrying: 'Reconnecting', disconnecting: 'Disconnecting', error: 'Failed' }

const flash = (mode: 'install' | 'uninstall') => presentDetour('phone-ui/onboarding-flash-page', { mode, fromOnboarding: false })


// ponytail: Phase 1 home for every old main-page action; the device card, lens and update rows come later.
export function createPage(): Page {
  const runtime = getRuntime(), controller = runtime.controller
  let shown = ''
  const { page, refresh } = groupedPage({ title: 'My Glasses', build: container => {
    const state = controller.connectionState, connected = runtime.connected
    shown = shownKey(state)
    const top: Row[] = []
    if (state?.firmwareWarning) top.push(navRow({ title: 'Attention Needed', badge: '!', onTap: () => { void showFirmwareAlert(state.firmwareWarning) } }))
    top.push(navRow({ title: 'Remote', onTap: () => pushInTab('glasses', 'ocusmart/remote') }))
    const phoneUi = runtime.evenHubButton
    if (phoneUi?.icon) top.push(navRow({ title: `Open ${phoneUi.title} on iPhone`, onTap: () => controller.showEvenHubPhoneUi(phoneUi.windowId) }))
    container.addChild(section({ rows: top }))
    const rows: Row[] = [valueRow({ title: 'Status', value: PHASE_LABELS[state?.phase ?? 'disconnected'] })]
    if (!deviceAddressError(loadDeviceAddresses())) rows.push(buttonRow({ title: connected ? 'Disconnect' : 'Connect', onTap: () => {
      if (connected) { suppressAutoReconnect(); void controller.disconnect() }
      else { resumeAutoReconnect(); void controller.connect() }
    } }))
    rows.push(
      navRow({ title: 'Connection Details', onTap: () => { void Dialogs.alert({ title: 'Connection details', message: controller.connectionDetails, okButtonText: 'OK' }) } }),
      navRow({ title: 'Pair Glasses', onTap: () => { void presentDetour('phone-ui/onboarding-unpair-page') } }),
      navRow({ title: 'Configure Devices', onTap: () => { void presentDetour('phone-ui/config-page', { onboarding: isPreviewOnlyMode() }) } }),
      navRow({ title: 'Check Firmware', onTap: () => { void presentDetour('phone-ui/onboarding-firmware-check-page') } }),
      navRow({ title: 'Install Custom Firmware', onTap: () => { void flash('install') } }),
      navRow({ title: 'Uninstall Custom Firmware', onTap: () => { void flash('uninstall') } }),
      // The old menu opened Permissions without dropping the connection.
      navRow({ title: 'Permissions', onTap: () => { void presentDetour('phone-ui/permissions-page', undefined, false) } }),
    )
    container.addChild(section({ header: 'Connection', footer: state?.status, rows }))
  } })
  let offs: (() => void)[] = []
  page.on('loaded', () => {
    for (const off of offs) off()
    offs = [runtime.on('connection', state => { if (shownKey(state) !== shown) refresh() }), runtime.on('evenHubButton', refresh),
      runtime.on('detour', open => { if (!open) refresh() })]
    refresh()
  })
  page.on('unloaded', () => { for (const off of offs) off(); offs = [] })
  return page
}
