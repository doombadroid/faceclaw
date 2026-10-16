import { Dialogs, type Page } from '@nativescript/core'
import { groupedPage, section, checkRow } from './ui-kit'
import { getRuntime } from './runtime'
import { firmwareSummary, firmwareChannel, reportedState } from './firmware-info'
import { CHANNEL_NAMES, RESTORE_MESSAGE, firmwareKey, flash } from './update-page'
import { BASE_STOCK_VERSION_TEXT, REQUIRED_FACECLAW_FIRMWARE_VERSION } from '../../g2/firmware-compat'

// Subtitles say what switching installs; the checked row shows what the glasses report instead.
const CHANNELS = [
  { id: 'faceclaw', mode: 'install', subtitle: `Installs custom firmware revision ${REQUIRED_FACECLAW_FIRMWARE_VERSION}`,
    message: `This flashes Faceclaw's custom firmware (revision ${REQUIRED_FACECLAW_FIRMWARE_VERSION}) to both lenses.` },
  { id: 'even', mode: 'uninstall', subtitle: `Installs stock firmware ${BASE_STOCK_VERSION_TEXT}`, message: RESTORE_MESSAGE },
] as const

export function createPage(): Page {
  const runtime = getRuntime()
  let shown = ''
  const { page, refresh } = groupedPage({ title: 'Firmware Channel', largeTitle: false, build: container => {
    shown = firmwareKey(runtime.controller.connectionState)
    const summary = firmwareSummary(reportedState(runtime.controller.connectionState))
    const extension = summary.extension, current = firmwareChannel(extension)
    const rows = CHANNELS.map(channel => checkRow({ title: CHANNEL_NAMES[channel.id], checked: current === channel.id,
      subtitle: current === channel.id ? summary.line : channel.subtitle,
      onTap: () => { if (current !== channel.id) void switchTo(CHANNEL_NAMES[channel.id], channel.message, channel.mode) } }))
    // The design's order: Faceclaw, xeyes, Even Realities.
    rows.splice(1, 0, checkRow({ title: 'xeyes', subtitle: 'Not built yet', checked: false, enabled: false, onTap: () => {} }))
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
