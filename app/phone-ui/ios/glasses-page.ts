import { GridLayout, Image, Label, StackLayout, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, buttonRow, switchRow, customRow, tile, type Row } from './ui-kit'
import { getRuntime } from './runtime'
import { showConnectionDetails } from './connection-details'
import type { SessionState } from '../../g2/ios-preview-controller'
import { presentDetour } from './detour'
import { showFirmwareAlert } from './firmware-alert'
import { firmwareSummary, reportedState } from './firmware-info'
import { pushInTab, selectTab } from './shell'
import { launchableAppCount } from './app-catalog'
import { PHASE_LABELS } from './device-page'
import { categoryValue } from './settings-page'
import { phoneTitle } from '../../ui/dashboard/settings-catalog'
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

/** `state` is the raw session for the phase; firmware comes from what it still reports, battery only from a live link. */
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
  const live = state?.phase === 'connected' ? state : null
  if (live?.battery != null) {
    const battery = new StackLayout()
    battery.className = 'os-battery'
    battery.accessible = true; battery.accessibilityLabel = 'Glasses battery'
    battery.accessibilityValue = `${live.battery}%${live.charging ? ', charging' : ''}`
    const track = new GridLayout()
    track.className = 'os-battery-track'
    const fill = new StackLayout()
    fill.className = 'os-battery-fill'; fill.horizontalAlignment = 'left'
    fill.width = { unit: '%', value: Math.max(0, Math.min(100, live.battery)) / 100 }
    track.addChild(fill); battery.addChild(track)
    const caption = new GridLayout()
    caption.columns = '*,auto'
    caption.addChild(text(live.charging ? 'Battery · Charging' : 'Battery', 'os-battery-label'))
    const value = text(`${live.battery}%`, 'os-battery-value')
    GridLayout.setColumn(value, 1); caption.addChild(value)
    battery.addChild(caption)
    card.addChild(battery)
  }
  return card
}

/** Overrides kit.css's 24pt gap above a section. */
function spaced(box: StackLayout, top: number): StackLayout {
  box.marginTop = top
  return box
}

/**
 * The lens mirror's width: 4:3 like the 640×480 panel, as wide as the card, but
 * short enough to leave about 160pt of the page for the bars and rows around it
 * (landscape, the inner display) and no wider than 560pt.
 */
export function lensMirrorWidth(available: number, pageHeight: number): number {
  return Math.max(0, Math.min(available, (pageHeight - 160) * 4 / 3, 560))
}

export function createPage(): Page {
  const runtime = getRuntime(), controller = runtime.controller
  let shown = ''
  let mirror: Image | null = null
  // The last capped width, so a rebuilt mirror starts at it rather than card-wide for a frame.
  let lensWidth = 0
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
    if (top.length) container.addChild(section({ rows: top }))

    const view = mirror = new Image()
    view.className = 'os-lens-mirror'; view.stretch = 'fill'
    view.accessible = true; view.accessibilityRole = 'button'; view.accessibilityLabel = 'Glasses display. Opens Remote'
    // src, not imageSource: teardown nulls an imageSource's native image, and this one is the runtime's shared cached frame.
    if (runtime.frame) view.src = runtime.frame.image
    view.horizontalAlignment = 'center'
    if (lensWidth > 0) { view.width = lensWidth; view.height = lensWidth * 3 / 4 }
    view.on('tap', () => pushInTab('glasses', 'ocusmart/remote'))
    // The slot stretches to the card, so its width is what the mirror may use.
    const slot = new GridLayout()
    slot.addChild(view)
    // Set after layout, outside UIKit's layout pass.
    slot.on('layoutChanged', () => setTimeout(() => {
      const height = page.getActualSize().height
      const width = lensMirrorWidth(slot.getActualSize().width, height)
      if (height <= 0 || width <= 0 || (view.width === width && view.height === width * 3 / 4)) return
      lensWidth = width
      view.width = width; view.height = width * 3 / 4
    }, 0))
    const lens = new StackLayout()
    lens.className = 'os-lens'; lens.addChild(slot)
    container.addChild(section({ header: 'Lens', rows: [
      customRow(lens),
      switchRow({ title: phoneTitle(mirrorTouchSetting), value: mirrorTouchSetting.get(), onChange: value => {
        // The switch already shows it; a rebuild would cut its animation.
        mirrorTouchSetting.set(value); shown = shownKey(controller.connectionState, runtime.evenHubButton)
      } }),
    ], footer: state?.phase === 'connected'
      ? 'A live copy of what the glasses show. Tap it to open Remote. With touch input on, touches on the Remote mirror act on the glasses: tap selects, double-tap goes back, hold opens the menu, swipes navigate.'
      : 'What OcuSmart draws for the glasses, running as a preview while no glasses are connected. Tap it to open Remote.' }))

    container.addChild(section({ rows: [
      navRow({ tile: tile('sun.max.fill', 'blue'), title: 'Display & Brightness', value: brightnessLabel(brightnessSetting.get()),
        onTap: () => pushInTab('glasses', 'ocusmart/settings-category', { category: 'display' }) }),
      navRow({ tile: tile('bell.badge.fill', 'red'), title: 'Notifications', value: categoryValue('notifications'),
        onTap: () => pushInTab('glasses', 'ocusmart/settings-category', { category: 'notifications' }) }),
      navRow({ tile: tile('square.grid.2x2.fill', 'purple'), title: 'Apps on Glasses', value: String(launchableAppCount()),
        onTap: () => selectTab('apps') }),
      navRow({ tile: tile('hand.tap.fill', 'green'), title: 'Remote & Touchpads', onTap: () => pushInTab('glasses', 'ocusmart/remote') }),
      navRow({ tile: tile('arrow.down.circle.fill', 'gray'), title: 'Software Update', badge: warning ? '1' : undefined,
        onTap: () => pushInTab('glasses', 'ocusmart/update') }),
    ] }))

    const rows: Row[] = []
    if (!deviceAddressError(loadDeviceAddresses())) rows.push(buttonRow({ title: connected ? 'Disconnect' : 'Connect', onTap: () => {
      if (connected) { suppressAutoReconnect(); void controller.disconnect() }
      else { resumeAutoReconnect(); void controller.connect() }
    } }))
    rows.push(
      buttonRow({ title: 'Connection Details', onTap: () => { void showConnectionDetails() } }),
      buttonRow({ title: 'Pair Glasses', onTap: () => { void presentDetour('ocusmart/setup') } }),
      // Configure, firmware check/install/uninstall and Permissions live there.
      navRow({ title: 'Even G2', onTap: () => pushInTab('glasses', 'ocusmart/device') }),
    )
    container.addChild(section({ header: 'Connection', footer: state?.status, rows }))
  } })
  const refreshIfChanged = () => { if (shownKey(controller.connectionState, runtime.evenHubButton) !== shown) refresh() }
  let offs: (() => void)[] = []
  // The lens shows while the page is loaded: tab switches, a pushed page and app suspend unload or pause it.
  let releaseMirror: (() => void) | null = null
  page.on('loaded', () => {
    releaseMirror ??= runtime.acquireMirror()
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
  page.on('unloaded', () => { for (const off of offs) off(); offs = []; releaseMirror?.(); releaseMirror = null })
  return page
}
