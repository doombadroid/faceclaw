import type { NavigatedData, Page } from '@nativescript/core'
import { groupedPage, section, checkRow, type Row } from './ui-kit'
import { itemTitle, type CatalogItem } from '../../ui/dashboard/settings-catalog'
import { onAnySettingChanged, type ConfigSettingEnum } from '../../ui/dashboard-settings'

type EnumItem = Extract<CatalogItem, { kind: 'setting' }> & { setting: ConfigSettingEnum<string> }

/** The checkmark list for one enum setting; disabled values (isDisabled, or unavailable on iOS) stay visible but dimmed. */
export function choiceRows(item: EnumItem, changed: () => void = () => {}): Row[] {
  const { setting } = item, current = setting.get()
  return setting.values.map(value => {
    const reason = item.unavailable?.(value) ?? null
    return checkRow({ title: setting.displayValue(value), subtitle: reason ?? undefined, checked: value === current,
      enabled: !reason && !setting.isDisabled(value),
      onTap: () => {
        if (value === setting.get()) return
        setting.set(value)
        item.onChange?.(value)
        changed()
      } })
  })
}

// Values and their availability both follow other settings (e.g. Full Screen needs a bottom or popup switcher).
const choiceKey = (item: EnumItem | null) => item
  ? JSON.stringify([item.setting.get(), item.setting.values.map(value => [item.unavailable?.(value) ?? null, item.setting.isDisabled(value)])])
  : ''

export function createPage(): Page {
  let item: EnumItem | null = null, shown = ''
  const { page, refresh } = groupedPage({ title: 'Settings', largeTitle: false, build: container => {
    shown = choiceKey(item)
    if (item) container.addChild(section({ footer: item.setting.description, rows: choiceRows(item, refresh) }))
  } })
  page.on('navigatingTo', (args: NavigatedData) => {
    if (item) return
    item = (args.context as { item?: EnumItem } | undefined)?.item ?? null
    page.actionBar.title = item ? itemTitle(item) : 'Settings'
    refresh()
  })
  let off: (() => void) | null = null
  page.on('loaded', () => {
    off?.()
    off = onAnySettingChanged(() => { if (choiceKey(item) !== shown) refresh() })
    if (choiceKey(item) !== shown) refresh()
  })
  page.on('unloaded', () => { off?.(); off = null })
  return page
}
