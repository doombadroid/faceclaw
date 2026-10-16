import { Dialogs, GridLayout, Image, Label, StackLayout, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, buttonRow, valueRow, customRow, type Row } from './ui-kit'
import { getRuntime } from './runtime'
import type { SessionState } from '../../g2/ios-preview-controller'
import { presentDetour } from './detour'
import { firmwareSummary, reportedState } from './firmware-info'
import { isPreviewOnlyMode } from '../onboarding-state'
import { resumeAutoReconnect, suppressAutoReconnect } from '../../g2/reconnect-policy'
import { loadDeviceAddresses, loadPairedGlassesIdentityForAddresses } from '../../g2/device-addresses'
import { deviceAddressError } from '../../g2/ios-peripheral-identity'
import { GlassesHardwareIdentity } from '../../g2/glasses-hardware-identity'
import { glassesImagePath } from '../../g2/glasses-artwork'
import { flash, restore } from './update-page'

/** The one wording for a session phase, on every page. */
export const PHASE_LABELS: Record<SessionState['phase'], string> = { connected: 'Connected', disconnected: 'Not Connected',
  connecting: 'Connecting…', retrying: 'Reconnecting…', disconnecting: 'Disconnecting…', error: 'Connection Failed' }

export const phaseLabel = (state: SessionState | null) => PHASE_LABELS[state?.phase ?? 'disconnected']

/** The live headset battery, or '' while unknown. A halted session's reading froze when its link closed. */
export function batteryText(state: SessionState | null): string {
  if (state?.phase !== 'connected' || state.battery == null) return ''
  return state.charging ? `${state.battery}% · Charging` : `${state.battery}%`
}

/** The device cell's second line: status, battery when known, what the firmware reported. */
export function deviceLine(state: SessionState | null): string {
  return [phaseLabel(state), batteryText(state), firmwareSummary(reportedState(state)).line].filter(Boolean).join(' · ')
}

/** The serial saved at pairing, while it still describes the configured addresses. */
function pairedIdentity(): { serial: string; hardware: GlassesHardwareIdentity | null } | null {
  const paired = loadPairedGlassesIdentityForAddresses(loadDeviceAddresses())
  return paired ? { serial: paired.serial, hardware: GlassesHardwareIdentity.decode(paired.serial) } : null
}

// Frame acks also emit 'connection'; rebuild only when what a page shows changes.
export const deviceKey = (state: SessionState | null) => [state?.phase, state?.status, state?.battery, state?.charging, state?.ring,
  state?.leftVersion, state?.rightVersion, state?.capabilities, state?.firmwareWarning].join('\n')

/** Art, "Even G2" and a status line: the head of Settings and of the device page. */
export function deviceCell(subtitle: string, onTap?: () => void): Row {
  const grid = new GridLayout()
  grid.columns = 'auto,*,auto'
  grid.className = 'os-row os-device-cell'
  grid.accessible = true; grid.accessibilityLabel = 'Even G2'; grid.accessibilityValue = subtitle
  const art = new GridLayout()
  art.className = 'os-device-art'; art.verticalAlignment = 'middle'
  const image = new Image()
  image.src = glassesImagePath(pairedIdentity()?.hardware); image.stretch = 'aspectFit'; image.className = 'os-device-image'
  art.addChild(image); grid.addChild(art)
  const text = new StackLayout()
  text.verticalAlignment = 'middle'
  const title = new Label()
  title.text = 'Even G2'; title.className = 'os-device-title'
  const line = new Label()
  line.text = subtitle; line.className = 'os-row-subtitle'; line.textWrap = true
  text.addChild(title); text.addChild(line)
  GridLayout.setColumn(text, 1); grid.addChild(text)
  if (onTap) {
    const chevron = new Image()
    chevron.src = 'sys://chevron.right'; chevron.className = 'os-chevron'; chevron.verticalAlignment = 'middle'
    GridLayout.setColumn(chevron, 2); grid.addChild(chevron)
    grid.accessibilityRole = 'button'
    grid.on('tap', onTap)
  }
  return customRow(grid)
}

/** Every device action the old main page's menus offered, in one place. */
export function createPage(): Page {
  const runtime = getRuntime(), controller = runtime.controller
  let shown = ''
  const { page, refresh } = groupedPage({ title: 'Even G2', largeTitle: false, build: container => {
    const state = controller.connectionState, connected = runtime.connected
    shown = deviceKey(state)
    const identity = pairedIdentity()
    container.addChild(section({ rows: [deviceCell(phaseLabel(state))],
      footer: identity ? [identity.hardware?.variantSummary, `Serial ${identity.serial}`].filter(Boolean).join(' · ') : undefined }))
    const status: Row[] = []
    const battery = batteryText(state)
    if (battery) status.push(valueRow({ title: 'Battery', value: battery }))
    status.push(valueRow({ title: 'Firmware', value: firmwareSummary(reportedState(state)).line }))
    if (state?.phase === 'connected') status.push(valueRow({ title: 'Ring', value: state.ring ? 'Connected' : 'Not connected' }))
    status.push(navRow({ title: 'Connection Details', onTap: () => {
      void Dialogs.alert({ title: 'Connection Details', message: controller.connectionDetails, okButtonText: 'OK' })
    } }))
    container.addChild(section({ header: 'Status', footer: state?.status, rows: status }))
    const connection: Row[] = []
    // Without saved addresses there is nothing to dial; Pair or Configure first.
    if (!deviceAddressError(loadDeviceAddresses())) connection.push(buttonRow({ title: connected ? 'Disconnect' : 'Connect', onTap: () => {
      if (connected) { suppressAutoReconnect(); void controller.disconnect() }
      else { resumeAutoReconnect(); void controller.connect() }
    } }))
    connection.push(
      navRow({ title: 'Pair Glasses', onTap: () => { void presentDetour('ocusmart/setup') } }),
      navRow({ title: 'Configure Devices', onTap: () => { void presentDetour('phone-ui/config-page', { onboarding: isPreviewOnlyMode() }) } }),
    )
    container.addChild(section({ header: 'Connection', rows: connection }))
    container.addChild(section({ header: 'Firmware', rows: [
      navRow({ title: 'Check Firmware', onTap: () => { void presentDetour('phone-ui/onboarding-firmware-check-page') } }),
      buttonRow({ title: 'Install Custom Firmware', onTap: () => { void flash('install') } }),
      buttonRow({ title: 'Uninstall Custom Firmware', role: 'destructive', onTap: () => { void restore('Uninstall Custom Firmware?', 'Continue') } }),
    ] }))
    // The old menu opened Permissions without dropping the connection.
    container.addChild(section({ rows: [navRow({ title: 'Permissions', onTap: () => { void presentDetour('phone-ui/permissions-page', undefined, false) } })] }))
  } })
  let offs: (() => void)[] = []
  page.on('loaded', () => {
    for (const off of offs) off()
    offs = [runtime.on('connection', state => { if (deviceKey(state) !== shown) refresh() }),
      // Pairing or config inside a detour can change the saved devices.
      runtime.on('detour', open => { if (!open) refresh() })]
    refresh()
  })
  page.on('unloaded', () => { for (const off of offs) off(); offs = [] })
  return page
}
