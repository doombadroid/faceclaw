import type { Page } from '@nativescript/core'
import { groupedPage, section, navRow, buttonRow, tile, type TileColor } from './ui-kit'
import { getRuntime } from './runtime'
import type { SessionState } from '../../g2/ios-preview-controller'
import { restore } from './update-page'
import { pushInTab } from './shell'
import { firmwareSummary, reportedState } from './firmware-info'
import { deviceCell, deviceKey, deviceLine } from './device-page'
import { SETTINGS_CATEGORIES, settingsCategory } from '../../ui/dashboard/settings-catalog'
import { brightnessSetting, onAnySettingChanged } from '../../ui/dashboard-settings'
import { glanceboardEnabledSetting } from '../../apps/glanceboard/glanceboard-settings'
import { readNotificationSources } from '../../native/notification-sources'
import { BASE_STOCK_VERSION_TEXT } from '../../g2/firmware-compat'

const TILES: Record<string, [string, TileColor]> = {
  display: ['sun.max.fill', 'blue'], notifications: ['bell.badge.fill', 'red'], glanceboard: ['rectangle.grid.2x2.fill', 'purple'],
  customization: ['paintbrush.fill', 'indigo'], 'phone-display': ['iphone', 'gray'],
  voice: ['waveform', 'orange'], 'api-keys': ['key.fill', 'gray'], privacy: ['hand.raised.fill', 'blue'], developer: ['hammer.fill', 'teal'],
}
/** Root rows, by category id: every catalog category must appear once (the test checks). */
export const ROOT_GROUPS = [['display', 'notifications', 'glanceboard', 'customization', 'phone-display'], ['voice', 'api-keys', 'privacy', 'developer']]

/** The value a category row shows, where one setting sums it up. */
export function categoryValue(id: string): string {
  switch (id) {
    case 'display': return brightnessSetting.displayValue()
    case 'glanceboard': return glanceboardEnabledSetting.get() ? 'On' : 'Off'
    case 'notifications': {
      const sources = readNotificationSources()
      return sources.length ? `${sources.filter(source => source.showOnGlasses).length} of ${sources.length}` : ''
    }
    default: return ''
  }
}

/** Uninstall is offered only while the glasses (still) report Faceclaw's own firmware. */
export function runsFaceclawFirmware(state: SessionState | null): boolean {
  const kind = firmwareSummary(reportedState(state)).extension?.kind
  return kind === 'faceclaw' || kind === 'legacy-faceclaw'
}

const rootKey = (state: SessionState | null) => [deviceKey(state), ...SETTINGS_CATEGORIES.map(category => categoryValue(category.id))].join('\n')

export function createPage(): Page {
  const runtime = getRuntime(), controller = runtime.controller
  let shown = ''
  const { page, refresh } = groupedPage({ title: 'Settings', build: container => {
    const state = controller.connectionState
    shown = rootKey(state)
    container.addChild(section({ rows: [deviceCell(deviceLine(state), () => pushInTab('settings', 'ocusmart/device'))] }))
    for (const ids of ROOT_GROUPS) container.addChild(section({ rows: ids.flatMap(id => {
      const category = settingsCategory(id)
      if (!category) return []
      const [symbol, color] = TILES[id] ?? ['gearshape.fill', 'gray']
      return [navRow({ tile: tile(symbol, color), title: category.title, value: categoryValue(id),
        onTap: () => pushInTab('settings', 'ocusmart/settings-category', { category: id }) })]
    }) }))
    container.addChild(section({ rows: [
      navRow({ tile: tile('gearshape.fill', 'gray'), title: 'General', onTap: () => pushInTab('settings', 'ocusmart/about') }),
      navRow({ tile: tile('arrow.down.circle.fill', 'gray'), title: 'Software Update', badge: reportedState(state)?.firmwareWarning ? '1' : undefined,
        onTap: () => pushInTab('settings', 'ocusmart/update') }),
    ] }))
    if (runsFaceclawFirmware(state)) container.addChild(section({
      footer: `Puts Even's stock firmware ${BASE_STOCK_VERSION_TEXT} back on the glasses.`,
      rows: [buttonRow({ title: 'Uninstall Custom Firmware', role: 'destructive', onTap: () => { void restore('Uninstall Custom Firmware?', 'Continue') } })] }))
  } })
  let offs: (() => void)[] = []
  const refreshIfChanged = () => { if (rootKey(controller.connectionState) !== shown) refresh() }
  page.on('loaded', () => {
    for (const off of offs) off()
    offs = [runtime.on('connection', refreshIfChanged), onAnySettingChanged(refreshIfChanged),
      // Pairing or config inside a detour can change the saved glasses (and so the art).
      runtime.on('detour', open => { if (!open) refresh() })]
    refresh()
  })
  page.on('unloaded', () => { for (const off of offs) off(); offs = [] })
  return page
}
