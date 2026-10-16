import { Dialogs, GestureStateTypes, GridLayout, Image, Label, StackLayout, type GestureEventData, type ImageSource, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, type Row, type TileColor } from './ui-kit'
import { getRuntime } from './runtime'
import { selectTab } from './shell'
import { shell } from '../../ui/shell/shell'
import { onAnySettingChanged } from '../../ui/dashboard-settings'
import { ALL_APPS } from '../../apps/all-apps'
import { iosAppUnavailableReason } from '../../apps/ios-availability'
import { ONBOARDING_APP_ID } from '../../apps/onboarding/onboarding-progress'
import { setAppFolder } from '../../apps/launcher/launcher-folders'
import { getInstalledEvenHubApps, getInstalledEvenHubFingerprint, installedEvenHubAppId, renderInstalledEvenHubIcon } from '../../apps/evenhub/installed-apps'
import { renderIcon } from '../../graphics/icons'
import { GrayImage } from '../../graphics/image'
import { grayImageToWhiteIconSource } from '../../native/gray-image-preview'

type Draw = (size: number) => GrayImage | null
type AppItem = { appId: string; title: string; draw: Draw }

const PALETTE: TileColor[] = ['blue', 'red', 'purple', 'green', 'orange', 'gray', 'indigo', 'teal']
// The 18pt tile glyph at 3x.
const ICON_PX = 54

/** A stable tile colour per app (FNV-1a of the appId), the same on every launch. */
export function tileColor(appId: string): TileColor {
  let hash = 0x811c9dc5
  for (let i = 0; i < appId.length; i++) hash = Math.imul(hash ^ appId.charCodeAt(i), 0x01000193)
  return PALETTE[(hash >>> 0) % PALETTE.length]
}

const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title)

// The windows with a glasses switcher icon: a transient status-item host has none, and focusing it would keep it open.
// ponytail: reads the shell's private list; make switcherWindows public if a second caller needs it.
const glassesWindows = () => shell['switcherWindows']()

/** What the tab lists, from the same sources the glasses launcher uses. */
export function listApps() {
  // The launcher window is the glasses app grid itself, always open.
  const open = glassesWindows().filter(window => window.appId !== 'launcher').map(window => ({
    windowId: window.windowId, appId: window.appId, title: window.title,
    // A window whose glyph will not render draws nothing; null lets the tile show the initial.
    draw: ((size: number) => {
      const image = new GrayImage(size, size, 0); window.drawIcon(image, 0, 0, size)
      return image.withDrawsBaked().pixels.some(pixel => pixel > 0) ? image : null
    }) as Draw,
  }))
  const builtIn: AppItem[] = [], unavailable: (AppItem & { reason: string })[] = []
  for (const app of ALL_APPS) {
    // The glasses Settings app duplicates the Settings tab.
    if (app.showInLauncher === false || app.appId === ONBOARDING_APP_ID || app.appId === 'settings') continue
    const item = { appId: app.appId, title: app.title, draw: (size: number) => app.renderIcon?.(size) ?? renderIcon(app.icon, size) }
    const reason = iosAppUnavailableReason(app.appId)
    if (reason) unavailable.push({ ...item, reason })
    else builtIn.push(item)
  }
  const hub = getInstalledEvenHubApps().map(app => ({
    appId: installedEvenHubAppId(app.packageId), title: app.name, version: app.version,
    draw: (size: number) => renderInstalledEvenHubIcon(app.packageId, size, app) ?? renderIcon('package', size),
  }))
  return { open, builtIn: builtIn.sort(byTitle), hub: hub.sort(byTitle), unavailable: unavailable.sort(byTitle) }
}

/** Built-ins never change at runtime; open windows and installs do. */
export function shownKey(): string {
  return JSON.stringify([glassesWindows().map(window => [window.windowId, window.appId, window.title]), getInstalledEvenHubFingerprint()])
}

/** The app's own glyph in white on its palette tile; its initial if the glyph will not render. */
function appTile(item: AppItem, color = tileColor(item.appId)): GridLayout {
  const box = new GridLayout()
  box.className = `os-tile os-tile-${color}`
  let source: ImageSource | null = null
  try {
    const image = item.draw(ICON_PX)
    source = image && grayImageToWhiteIconSource(image)
  } catch { source = null }
  if (source) {
    const icon = new Image()
    icon.imageSource = source; icon.className = 'os-tile-icon'
    box.addChild(icon)
  } else {
    const initial = new Label()
    initial.text = (Array.from(item.title.trim())[0] ?? '').toUpperCase(); initial.className = 'os-app-initial'
    box.addChild(initial)
  }
  return box
}

/** Dimmed, not tappable, with the reason the glasses show when it is opened. */
function unavailableRow(item: AppItem & { reason: string }): Row {
  const grid = new GridLayout()
  grid.columns = 'auto,*'; grid.className = 'os-row os-disabled'
  grid.accessible = true; grid.accessibilityLabel = item.title; grid.accessibilityValue = item.reason
  const icon = appTile(item, 'gray')
  icon.verticalAlignment = 'middle'
  grid.addChild(icon)
  const text = new StackLayout()
  text.verticalAlignment = 'middle'
  for (const [value, className] of [[item.title, 'os-row-title'], [item.reason, 'os-row-subtitle']]) {
    const label = new Label()
    label.text = value; label.className = className; label.textWrap = true
    text.addChild(label)
  }
  GridLayout.setColumn(text, 1); grid.addChild(text)
  return { view: grid, inset: 56 }
}

export function createPage(): Page {
  const controller = getRuntime().controller
  let shown = ''
  const launch = (appId: string) => { void controller.launchApp(appId) }
  // Set while the uninstall alert is up: the tap that ends the same hold must not launch the app.
  let confirming = false
  const uninstall = async (app: { appId: string; title: string }) => {
    confirming = true
    const confirmed = await Dialogs.confirm({ title: `Uninstall ${app.title}?`,
      message: 'It closes on the glasses and is removed from this iPhone.', okButtonText: 'Uninstall', cancelButtonText: 'Cancel' })
      .finally(() => { confirming = false })
    if (!confirmed) return
    // As the glasses launcher does, so a reinstall does not land in the old folder.
    setAppFolder(app.appId, null)
    await controller.uninstallApp(app.appId)
    refresh()
  }
  const { page, refresh } = groupedPage({ title: 'Apps', build: container => {
    shown = shownKey()
    const { open, builtIn, hub, unavailable } = listApps()
    container.addChild(open.length
      ? section({ header: 'On Glasses Now', footer: 'Tap a window to bring it to the front on the glasses.',
        rows: open.map(window => navRow({ tile: appTile(window), title: window.title, onTap: () => controller.focusWindow(window.windowId) })) })
      : section({ header: 'On Glasses Now', footer: 'No apps are open on the glasses.', rows: [] }))
    container.addChild(section({ header: 'Built In',
      footer: 'Built-in apps run on this iPhone and draw to the glasses. Tap one to open it there. The glasses menu sorts apps alphabetically; folders are arranged on the glasses.',
      rows: builtIn.map(app => navRow({ tile: appTile(app), title: app.title, onTap: () => launch(app.appId) })) }))
    container.addChild(hub.length
      ? section({ header: 'From Even Hub', footer: 'Tap an app to open it on the glasses. Touch and hold to uninstall it.',
        rows: hub.map(app => {
          const row = navRow({ tile: appTile(app), title: app.title, value: app.version, onTap: () => { if (!confirming) launch(app.appId) } })
          row.view.accessibilityHint = 'Touch and hold to uninstall.'
          // iOS sends a hold as began, changed per move, then ended: confirm once.
          row.view.on('longPress', (args: GestureEventData & { state?: GestureStateTypes }) => { if (args.state === GestureStateTypes.began && !confirming) void uninstall(app) })
          return row
        }) })
      : section({ header: 'From Even Hub', footer: 'Apps you install from Even Hub appear here.',
        rows: [navRow({ title: 'Browse Even Hub', onTap: () => selectTab('hub') })] }))
    if (unavailable.length) container.addChild(section({ header: 'Not Available on iPhone',
      footer: 'The glasses menu still lists these and shows the same reason when one is opened.', rows: unavailable.map(unavailableRow) }))
  } })
  const refreshIfChanged = () => { if (shownKey() !== shown) refresh() }
  let offs: (() => void)[] = []
  // TabView unloads hidden tabs, so 'loaded' also covers re-selecting the tab.
  page.on('loaded', () => {
    for (const off of offs) off()
    // Installs and uninstalls (from the glasses store too) write a setting.
    offs = [controller.onWindowsChanged(refreshIfChanged), onAnySettingChanged(refreshIfChanged)]
    refreshIfChanged()
  })
  page.on('unloaded', () => { for (const off of offs) off(); offs = [] })
  return page
}
