import { GridLayout, Image, Label, Page, ScrollView, StackLayout, Switch, type PropertyChangeData, type View } from '@nativescript/core'

// Code-built inset-grouped lists. ListView is a plain UITableView, so sections
// are StackLayouts; colours live in ocusmart.css (light + .ns-dark).

export type TileColor = 'blue' | 'red' | 'purple' | 'green' | 'orange' | 'gray' | 'indigo' | 'teal'
/** A row and the separator inset under it (to the text). */
export type Row = { view: View; inset: number }

export function groupedPage({ title, largeTitle = true, build }: {
  title: string; largeTitle?: boolean; build: (container: StackLayout) => void
}): { page: Page; refresh: () => void } {
  const page = new Page()
  page.className = 'os-page'
  page.actionBar.title = title
  // Typed on ActionBarBase only; the iOS ActionBar maps it to prefersLargeTitles.
  page.actionBar.set('iosLargeTitle', largeTitle)
  inheritBarTint(page)
  const container = new StackLayout()
  container.className = 'os-grouped'
  const scroll = new ScrollView()
  scroll.content = container
  page.content = scroll
  const refresh = () => { container.removeChildren(); build(container) }
  refresh()
  return { page, refresh }
}

/**
 * NativeScript writes the bar's inherited CSS text colour into navBar.tintColor
 * on every update, hiding the shell's dynamic tint; keep it for the title only.
 */
export function inheritBarTint(page: Page): void {
  const bar = page.actionBar as unknown as { setColor(navBar: UINavigationBar | null, color: unknown): void }
  const setColor = bar.setColor.bind(bar) as typeof bar.setColor
  bar.setColor = (navBar, color) => { setColor(navBar, color); if (navBar) navBar.tintColor = null }
}

function label(text: string, className: string): Label {
  const view = new Label()
  view.text = text; view.className = className; view.textWrap = true
  return view
}

export function section({ header, footer, rows }: { header?: string; footer?: string; rows: Row[] }): StackLayout {
  const box = new StackLayout()
  box.className = 'os-section'
  if (header) box.addChild(label(header, 'os-section-header'))
  if (rows.length) {
    const card = new StackLayout()
    card.className = 'os-card'
    rows.forEach((row, i) => {
      card.addChild(row.view)
      if (i === rows.length - 1) return
      const separator = new StackLayout()
      separator.className = 'os-separator'; separator.marginLeft = row.inset
      card.addChild(separator)
    })
    box.addChild(card)
  }
  if (footer) box.addChild(label(footer, 'os-section-footer'))
  return box
}

export function tile(symbol: string, color: TileColor): GridLayout {
  const box = new GridLayout()
  box.className = `os-tile os-tile-${color}`
  const icon = new Image()
  icon.src = `sys://${symbol}`; icon.className = 'os-tile-icon'
  box.addChild(icon)
  return box
}

function glyph(name: string, className: string): Image {
  const view = new Image()
  view.src = `sys://${name}`; view.className = className
  view.verticalAlignment = 'middle'
  return view
}

/** Columns: tile | title (+subtitle) | value/badge/switch | accessory. */
function baseRow(title: string, options: { tile?: GridLayout; subtitle?: string; titleClass?: string; enabled?: boolean; onTap?: () => void }): GridLayout {
  const grid = new GridLayout()
  grid.columns = 'auto,*,auto,auto'
  grid.className = options.enabled === false ? 'os-row os-disabled' : 'os-row'
  grid.accessible = true; grid.accessibilityLabel = title
  if (options.tile) { options.tile.verticalAlignment = 'middle'; grid.addChild(options.tile) }
  const text = new StackLayout()
  text.verticalAlignment = 'middle'
  text.addChild(label(title, options.titleClass ?? 'os-row-title'))
  if (options.subtitle) text.addChild(label(options.subtitle, 'os-row-subtitle'))
  GridLayout.setColumn(text, 1); grid.addChild(text)
  if (options.onTap && options.enabled !== false) {
    grid.accessibilityRole = 'button'
    grid.on('tap', () => options.onTap())
  }
  return grid
}

function cell(grid: GridLayout, view: View, column: number): void {
  view.verticalAlignment = 'middle'
  GridLayout.setColumn(view, column); grid.addChild(view)
}

const inset = (hasTile: boolean) => hasTile ? 56 : 16

export function navRow({ tile: icon, title, subtitle, value, badge, onTap }: {
  tile?: GridLayout; title: string; subtitle?: string; value?: string; badge?: string; onTap: () => void
}): Row {
  const grid = baseRow(title, { tile: icon, subtitle, onTap })
  if (badge) cell(grid, label(badge, 'os-badge'), 2)
  else if (value) cell(grid, label(value, 'os-row-value'), 2)
  cell(grid, glyph('chevron.right', 'os-chevron'), 3)
  return { view: grid, inset: inset(!!icon) }
}

export function switchRow({ tile: icon, title, value, onChange }: {
  tile?: GridLayout; title: string; value: boolean; onChange: (value: boolean) => void
}): Row {
  const grid = baseRow(title, { tile: icon })
  const toggle = new Switch()
  toggle.checked = value; toggle.accessibilityLabel = title
  toggle.on('checkedChange', (args: PropertyChangeData) => onChange(!!args.value))
  cell(grid, toggle, 3)
  return { view: grid, inset: inset(!!icon) }
}

export function buttonRow({ title, role = 'default', enabled, onTap }: {
  title: string; role?: 'default' | 'destructive'; enabled?: boolean; onTap: () => void
}): Row {
  return { view: baseRow(title, { titleClass: role === 'destructive' ? 'os-row-title os-destructive' : 'os-row-title os-tint', enabled, onTap }), inset: 16 }
}

export function valueRow({ title, value }: { title: string; value: string }): Row {
  const grid = baseRow(title, {})
  cell(grid, label(value, 'os-row-value'), 2)
  grid.accessibilityValue = value
  return { view: grid, inset: 16 }
}

export function checkRow({ title, subtitle, checked, enabled, onTap }: {
  title: string; subtitle?: string; checked: boolean; enabled?: boolean; onTap: () => void
}): Row {
  const grid = baseRow(title, { subtitle, enabled, onTap })
  const mark = glyph('checkmark', 'os-check')
  mark.visibility = checked ? 'visible' : 'hidden'
  cell(grid, mark, 3)
  if (checked) grid.accessibilityState = 'selected'
  return { view: grid, inset: 16 }
}

export function customRow(view: View): Row {
  return { view, inset: 16 }
}
