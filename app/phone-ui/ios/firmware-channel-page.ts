import { Dialogs, type Page } from '@nativescript/core'
import { groupedPage, section, checkRow } from './ui-kit'
import { getRuntime } from './runtime'
import { firmwareSummary, firmwareChannel } from './firmware-info'
import { CHANNEL_NAMES, firmwareKey, flash } from './update-page'
import { BASE_STOCK_VERSION_TEXT, REQUIRED_FACECLAW_FIRMWARE_VERSION } from '../../g2/firmware-compat'

const CHANNELS = [
  { id: 'faceclaw', mode: 'install', subtitle: `Custom firmware, revision ${REQUIRED_FACECLAW_FIRMWARE_VERSION}`,
    message: `This flashes Faceclaw's custom firmware (revision ${REQUIRED_FACECLAW_FIRMWARE_VERSION}) to both lenses.` },
  { id: 'even', mode: 'uninstall', subtitle: `Stock firmware ${BASE_STOCK_VERSION_TEXT}`,
    message: `This flashes Even's stock firmware ${BASE_STOCK_VERSION_TEXT} to both lenses and removes Faceclaw's custom features.` },
] as const

export function createPage(): Page {
  const runtime = getRuntime()
  let shown = ''
  const { page, refresh } = groupedPage({ title: 'Firmware Channel', largeTitle: false, build: container => {
    const state = runtime.controller.connectionState
    shown = firmwareKey(state)
    const extension = firmwareSummary(state).extension, current = firmwareChannel(extension)
    const rows = CHANNELS.map(channel => checkRow({ title: CHANNEL_NAMES[channel.id], subtitle: channel.subtitle, checked: current === channel.id,
      onTap: () => { if (current !== channel.id) void switchTo(CHANNEL_NAMES[channel.id], channel.message, channel.mode) } }))
    rows.push(checkRow({ title: 'xeyes', subtitle: 'Not built yet', checked: false, enabled: false, onTap: () => {} }))
    const where = !extension ? 'Connect your glasses to see which channel they are on. '
      : current ? '' : 'Your glasses report custom firmware from a different source. '
    container.addChild(section({ header: 'Channel', rows,
      footer: `${where}A channel is the firmware family your glasses run. Switching reflashes both lenses; ` +
        `the Faceclaw image is built on this iPhone from Even's stock ${BASE_STOCK_VERSION_TEXT} download, and ` +
        'images are always verified against pinned hashes before flashing.' }))
  } })

  let offs: (() => void)[] = []
  page.on('loaded', () => {
    for (const off of offs) off()
    offs = [runtime.on('connection', state => { if (firmwareKey(state) !== shown) refresh() }),
      runtime.on('detour', open => { if (!open) refresh() })]
    refresh()
  })
  page.on('unloaded', () => { for (const off of offs) off(); offs = [] })
  return page
}

async function switchTo(name: string, message: string, mode: 'install' | 'uninstall'): Promise<void> {
  if (await Dialogs.confirm({ title: `Switch to ${name}?`, message, okButtonText: 'Switch', cancelButtonText: 'Cancel' })) await flash(mode)
}
