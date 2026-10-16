import { Dialogs, GridLayout, Image, Label, StackLayout, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, buttonRow, switchRow, customRow, tile, type Row } from './ui-kit'
import { getRuntime } from './runtime'
import type { SessionState } from '../../g2/ios-preview-controller'
import { presentDetour } from './detour'
import { showFirmwareAlert } from './firmware-alert'
import { firmwareSummary, reportedState } from './firmware-info'
import { pushInTab, selectTab } from './shell'
import { launchableAppCount } from './app-catalog'
import { PHASE_LABELS } from './device-page'
import { categoryValue } from './settings-page'
import { resumeAutoReconnect, suppressAutoReconnect } from '../../g2/reconnect-policy'
import { loadDeviceAddresses, loadPairedGlassesIdentityForAddresses } from '../../g2/device-addresses'
import { deviceAddressError } from '../../g2/ios-peripheral-identity'
import { GlassesHardwareIdentity } from '../../g2/glasses-hardware-identity'
import { glassesImagePath } from '../../g2/glasses-artwork'
import { brightnessLabel, brightnessSetting, mirrorTouchSetting, onAnySettingChanged } from '../../ui/dashboard-settings'
import { getInstalledEvenHubFingerprint } from '../../apps/evenhub/installed-apps'
import type { PhoneUiButton } from '../../apps/evenhub/manager'

// Frame acks also emit 'connection' (state.frames); rebuild only when what the page shows changes.
// Installs and uninstalls (from the glasses store too) write a setting, which reaches onAnySettingChanged.
function shownKey(state: SessionState | null, button: PhoneUiButton | null): string {
  return [state?.phase, state?.status, state?.firmwareWarning, state?.battery, state?.charging, state?.capabilities,
    state?.leftVersion, state?.rightVersion, button?.icon ? button.windowId + button.title : '',
    brightnessSetting.get(), mirrorTouchSetting.get(), categoryValue('notifications'), getInstalledEvenHubFingerprint()].join('\n')
}

function text(value: string, className: string): Label {
  const view = new Label()
  view.text = value; view.className = className; view.textWrap = true
  return view
}

/** `state` is the raw session for the phase; firmware and battery come from what it still reports. */
function deviceCard(state: SessionState | null): StackLayout {
  const reported = reportedState(state)
  const card = new StackLayout()
  card.className = 'os-glasses-card'
  const art = new Image()
  const paired = loadPairedGlassesIdentityForAddresses(loadDeviceAddresses())
  art.src = glassesImagePath(GlassesHardwareIdentity.decode(paired?.serial))
  art.className = 'os-glasses-art'; art.stretch = 'aspectFit'
  art.accessible = true; art.accessibilityLabel = 'Your glasses'
  card.addChild(art)
  card.addChild(text('Even G2', 'os-glasses-title'))
  card.addChild(text(PHASE_LABELS[state?.phase ?? 'disconnected'], 'os-glasses-status'))
  card.addChild(text(firmwareSummary(reported).line, 'os-glasses-status'))
  if (reported?.battery != null) {
    const battery = new StackLayout()
    battery.className = 'os-battery'
    battery.accessible = true; battery.accessibilityLabel = 'Glasses battery'
    battery.accessibilityValue = `${reported.battery}%${reported.charging ? ', charging' : ''}`
    const track = new GridLayout()
    track.className = 'os-battery-track'
    const fill = new StackLayout()
    fill.className = 'os-battery-fill'; fill.horizontalAlignment = 'left'
    fill.width = { unit: '%', value: Math.max(0, Math.min(100, reported.battery)) / 100 }
    track.addChild(fill); battery.addChild(track)
    const caption = new GridLayout()
    caption.columns = '*,auto'
    caption.addChild(text(reported.charging ? 'Battery · Charging' : 'Battery', 'os-battery-label'))
    const value = text(`${reported.battery}%`, 'os-battery-value')
    GridLayout.setColumn(value, 1); caption.addChild(value)
    battery.addChild(caption)
    card.addChild(battery)
  }
  return card
}

/** Pads a headerless section like the design's 22pt gap between cards. */
function spaced(box: StackLayout, top = 22): StackLayout {
  box.marginTop = top
  return box
}

export function createPage(): Page {
  const runtime = getRuntime(), controller = runtime.controller
  let shown = ''
  let mirror: Image | null = null
  const { page, refresh } = groupedPage({ title: 'My Glasses', build: container => {
    const state = controller.connectionState, connected = runtime.connected, warning = reportedState(state)?.firmwareWarning
    shown = shownKey(state, runtime.evenHubButton)
    container.addChild(spaced(section({ rows: [customRow(deviceCard(state))] }), 6))

    const top: Row[] = []
    if (warning) top.push(navRow({ tile: tile('exclamationmark.triangle.fill', 'red'), title: 'Attention Needed',
      onTap: () => { void showFirmwareAlert(warning) } }))
    const phoneUi = runtime.evenHubButton
    if (phoneUi?.icon) {
      const appTile = tile('app', 'teal')
      // Through src: it replaces the tile's sys:// placeholder, and NativeScript wraps it so teardown leaves the cached icon intact.
      ;(appTile.getChildAt(0) as Image).src = phoneUi.icon
      top.push(navRow({ tile: appTile, title: `Open ${phoneUi.title} on iPhone`, onTap: () => controller.showEvenHubPhoneUi(phoneUi.windowId) }))
    }
    if (top.length) container.addChild(spaced(section({ rows: top })))

    const view = mirror = new Image()
    view.className = 'os-lens-mirror'; view.stretch = 'fill'
    view.accessible = true; view.accessibilityRole = 'button'; view.accessibilityLabel = 'Glasses display. Opens Remote'
    // src, not imageSource: teardown nulls an imageSource's native image, and this one is the runtime's shared cached frame.
    if (runtime.frame) view.src = runtime.frame.image
    // 4:3 like the 640×480 panel; set after layout, outside UIKit's layout pass.
    view.on('layoutChanged', () => setTimeout(() => {
      const width = view.getActualSize().width
      if (width > 0 && view.height !== width * 3 / 4) view.height = width * 3 / 4
    }, 0))
    view.on('tap', () => pushInTab('glasses', 'ocusmart/remote'))
    const lens = new StackLayout()
    lens.className = 'os-lens'; lens.addChild(view)
    container.addChild(section({ header: 'Lens', rows: [
      customRow(lens),
      switchRow({ title: mirrorTouchSetting.label, value: mirrorTouchSetting.get(), onChange: value => {
        // The switch already shows it; a rebuild would cut its animation.
        mirrorTouchSetting.set(value); shown = shownKey(controller.connectionState, runtime.evenHubButton)
      } }),
    ], footer: state?.phase === 'connected'
      ? 'A live copy of what the glasses show. Tap it to open Remote. With touch input on, touches on the Remote mirror act on the glasses: tap selects, double-tap goes back, hold opens the menu, swipes navigate.'
      : 'What OcuSmart draws for the glasses, running as a preview while no glasses are connected. Tap it to open Remote.' }))

    container.addChild(spaced(section({ rows: [
      navRow({ tile: tile('sun.max.fill', 'blue'), title: 'Display & Brightness', value: brightnessLabel(brightnessSetting.get()),
        onTap: () => pushInTab('glasses', 'ocusmart/settings-category', { category: 'display' }) }),
      navRow({ tile: tile('bell.badge.fill', 'red'), title: 'Notifications', value: categoryValue('notifications'),
        onTap: () => pushInTab('glasses', 'ocusmart/settings-category', { category: 'notifications' }) }),
      navRow({ tile: tile('square.grid.2x2.fill', 'purple'), title: 'Apps on Glasses', value: String(launchableAppCount()),
        onTap: () => selectTab('apps') }),
      navRow({ tile: tile('hand.tap.fill', 'green'), title: 'Remote & Touchpads', onTap: () => pushInTab('glasses', 'ocusmart/remote') }),
      navRow({ tile: tile('arrow.down.circle.fill', 'gray'), title: 'Software Update', badge: warning ? '1' : undefined,
        onTap: () => pushInTab('glasses', 'ocusmart/update') }),
    ] })))

    const rows: Row[] = []
    if (!deviceAddressError(loadDeviceAddresses())) rows.push(buttonRow({ title: connected ? 'Disconnect' : 'Connect', onTap: () => {
      if (connected) { suppressAutoReconnect(); void controller.disconnect() }
      else { resumeAutoReconnect(); void controller.connect() }
    } }))
    rows.push(
      navRow({ title: 'Connection Details', onTap: () => { void Dialogs.alert({ title: 'Connection Details', message: controller.connectionDetails, okButtonText: 'OK' }) } }),
      navRow({ title: 'Pair Glasses', onTap: () => { void presentDetour('ocusmart/setup') } }),
      // Configure, firmware check/install/uninstall and Permissions live there.
      navRow({ title: 'Device Settings', onTap: () => pushInTab('glasses', 'ocusmart/device') }),
    )
    container.addChild(section({ header: 'Connection', footer: state?.status, rows }))
  } })
  const refreshIfChanged = () => { if (shownKey(controller.connectionState, runtime.evenHubButton) !== shown) refresh() }
  let offs: (() => void)[] = []
  page.on('loaded', () => {
    for (const off of offs) off()
    offs = [
      runtime.on('connection', refreshIfChanged), runtime.on('evenHubButton', refreshIfChanged), onAnySettingChanged(refreshIfChanged),
      runtime.on('frame', ({ image }) => { if (mirror) mirror.src = image }),
      // Saved devices, pairing or firmware can change inside a detour.
      runtime.on('detour', open => { if (!open) refresh() }),
    ]
    // The paired identity is not evented.
    refresh()
  })
  page.on('unloaded', () => { for (const off of offs) off(); offs = [] })
  return page
}
