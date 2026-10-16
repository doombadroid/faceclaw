import { Color, Frame, TabView, TabViewItem } from '@nativescript/core'
import { getRuntime } from './runtime'

export type TabName = 'glasses' | 'apps' | 'hub' | 'settings'
const TABS: { name: TabName; title: string; icon: string; moduleName: string }[] = [
  { name: 'glasses', title: 'My Glasses', icon: 'sys://eyeglasses', moduleName: 'ocusmart/glasses' },
  { name: 'apps', title: 'Apps', icon: 'sys://square.grid.2x2', moduleName: 'ocusmart/apps' },
  { name: 'hub', title: 'Hub', icon: 'sys://bag', moduleName: 'ocusmart/hub' },
  { name: 'settings', title: 'Settings', icon: 'sys://gearshape', moduleName: 'ocusmart/settings' },
]
const LIGHT_TINT = new Color('#0A62D0'), DARK_TINT = new Color('#4DA3FF')

let shell: { tabs: TabView; frames: Record<TabName, Frame> } | null = null
let offRuntime: (() => void)[] = []

export function hasShell(): boolean { return shell !== null }

/** Root TabView: one Frame (navigation stack) per tab. */
export function createShell(): TabView {
  const runtime = getRuntime()
  const tabs = new TabView()
  tabs.className = 'os-shell'
  const frames = {} as Record<TabName, Frame>
  tabs.items = TABS.map(tab => {
    const frame = new Frame()
    frame.navigate({ moduleName: tab.moduleName })
    frames[tab.name] = frame
    const item = new TabViewItem()
    item.title = tab.title; item.iconSource = tab.icon; item.view = frame
    return item
  })
  tabs.on('loaded', () => {
    // CSS colours are static; a dynamic UIColor follows appearance changes, and
    // tab bar and navigation bars (see ui-kit inheritBarTint) inherit it.
    tabs.ios.view.tintColor = UIColor.colorWithDynamicProvider(traits =>
      traits.userInterfaceStyle === UIUserInterfaceStyle.Dark ? DARK_TINT.ios : LIGHT_TINT.ios)
    runtime.start()
  })
  shell = { tabs, frames }
  // The keyboard panel lives on Remote; a glasses-started session must reach it from any tab.
  // Not under a detour: navigating a tab frame makes it Frame.topmost(), and the
  // shared pages' Frame.topmost().goBack() would then miss the detour, which
  // cannot be swiped away. The session waits for the detour to close.
  for (const off of offRuntime) off()
  offRuntime = [
    runtime.on('keyboardSession', session => { if (session && !runtime.inDetour) showRemote() }),
    runtime.on('detour', open => { if (!open && runtime.keyboardSession) showRemote() }),
  ]
  return tabs
}

export function selectTab(name: TabName): void {
  if (!shell) return
  const index = TABS.findIndex(tab => tab.name === name)
  shell.tabs.selectedIndex = index
  // On iOS 27 core configures the tab bar through UITabs only (it no longer assigns
  // viewControllers), but its selectedIndex setter still writes UITabBarController.selectedIndex,
  // an index into viewControllers. Select the UITab too (core names them by index) so the
  // visible tab follows; a no-op wherever selectedIndex already did. iOS < 18 has no UITabs.
  const controller = shell.tabs.ios as UITabBarController | undefined
  const tab = controller?.tabForIdentifier?.(String(index))
  if (controller && tab) controller.selectedTab = tab
}

export function pushInTab(name: TabName, moduleName: string, context?: object): void {
  if (!shell) return
  selectTab(name)
  shell.frames[name].navigate({ moduleName, context })
}

function showRemote(): void {
  selectTab('glasses')
  if (shell?.frames.glasses.currentEntry?.moduleName !== 'ocusmart/remote') pushInTab('glasses', 'ocusmart/remote')
}
