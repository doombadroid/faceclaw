import { Dialogs, Label, StackLayout, GridLayout, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, buttonRow, valueRow, customRow, tile, type Row } from './ui-kit'
import { getRuntime } from './runtime'
import { presentDetour } from './detour'
import { firmwareSummary, firmwareChannel, firmwareImageBytes, formatMegabytes, updateStatus } from './firmware-info'
import { BASE_STOCK_VERSION_TEXT, REQUIRED_FACECLAW_FIRMWARE_VERSION, classifyOnboardingFirmware, describeFirmwareExtension } from '../../g2/firmware-compat'
import type { SessionState } from '../../g2/ios-preview-controller'
import { APP_NAME } from '../../branding'

export const flash = (mode: 'install' | 'uninstall') => presentDetour('phone-ui/onboarding-flash-page', { mode, fromOnboarding: false })
export const CHANNEL_NAMES = { faceclaw: 'Faceclaw', even: 'Even Realities' }

// The flash page's own guidance (onboarding-flash-view-model.ts, MIN_FLASH_BATTERY_PERCENT).
const FLASH_GUIDANCE = 'Keep both lenses powered on and nearby — each lens takes a few minutes, and the glasses ' +
  'will reboot when each lens finishes. Both lenses need at least 30% battery. Do not close the app during flashing.'

/** Frame acks also emit 'connection'; only the reported firmware changes this page. */
export const firmwareKey = (state: SessionState | null) => [state?.capabilities, state?.leftVersion, state?.rightVersion].join('\n')

function text(value: string, className: string): Label {
  const view = new Label()
  view.text = value; view.className = className; view.textWrap = true
  return view
}

function header(subtitle: string, status: string): Row {
  const grid = new GridLayout()
  grid.columns = 'auto,*'; grid.className = 'os-update-header'
  const icon = tile('eyeglasses', 'gray')
  icon.className += ' os-update-icon'; icon.verticalAlignment = 'top'
  grid.addChild(icon)
  const body = new StackLayout()
  body.addChild(text(`Faceclaw r${REQUIRED_FACECLAW_FIRMWARE_VERSION}`, 'os-update-title'))
  body.addChild(text(subtitle, 'os-row-subtitle'))
  body.addChild(text(status, 'os-update-body'))
  GridLayout.setColumn(body, 1); grid.addChild(body)
  return customRow(grid)
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

export function createPage(): Page {
  const runtime = getRuntime()
  let shown = ''
  const { page, refresh } = groupedPage({ title: 'Software Update', largeTitle: false, build: container => {
    const state = runtime.controller.connectionState
    shown = firmwareKey(state)
    const summary = firmwareSummary(state), status = updateStatus(summary.extension)
    const statusText = !summary.extension ? 'Connect your glasses to check whether it is installed.'
      : status === 'current' ? 'Installed. Your glasses are up to date.'
      : `Available for your glasses, which run ${describeFirmwareExtension(summary.extension)} (${summary.version}).`
    const about = `Faceclaw's custom firmware, built on this iPhone from Even's stock ${BASE_STOCK_VERSION_TEXT} ` +
      'download and verified against pinned hashes before flashing.'
    container.addChild(section({ rows: [header(`Faceclaw channel · ${formatMegabytes(firmwareImageBytes())}`, `${statusText} ${about}`)] }))

    let footer = FLASH_GUIDANCE
    if (state && classifyOnboardingFirmware({ leftVersion: state.leftVersion, rightVersion: state.rightVersion, extension: state.capabilities }).kind === 'newer-stock-unvalidated')
      footer = `Your glasses run stock firmware ${summary.version}, newer than the ${BASE_STOCK_VERSION_TEXT} release ` +
        `Faceclaw's image is built from. Flashing may not work correctly and carries extra risk. ${footer}`
    container.addChild(section({ footer, rows: [buttonRow({ title: status === 'current' ? 'Reinstall' : 'Download and Install', onTap: () => { void flash('install') } })] }))

    const channel = firmwareChannel(summary.extension)
    container.addChild(section({ rows: [navRow({ title: 'Firmware Channel', value: channel ? CHANNEL_NAMES[channel] : undefined,
      onTap: () => page.frame?.navigate({ moduleName: 'ocusmart/firmware-channel' }) })] }))

    const installed: Row[] = summary.extension ? [
      valueRow({ title: 'Left', value: state?.leftVersion || 'Not reported' }),
      valueRow({ title: 'Right', value: state?.rightVersion || 'Not reported' }),
      valueRow({ title: 'Firmware', value: capitalize(describeFirmwareExtension(summary.extension)) }),
    ] : []
    // Restoring stock onto stock would be a no-op reflash.
    const restorable = summary.extension?.kind !== 'none'
    if (restorable) installed.push(buttonRow({ title: 'Restore Even Firmware', role: 'destructive', onTap: () => { void restore() } }))
    container.addChild(section({ header: 'Installed', rows: installed,
      footer: [summary.extension ? '' : 'Connect your glasses to see the installed versions.',
        restorable ? `Restoring flashes Even's stock firmware ${BASE_STOCK_VERSION_TEXT}.` : ''].filter(Boolean).join(' ') || undefined }))
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

export async function restore(): Promise<void> {
  const ok = await Dialogs.confirm({ title: 'Restore Even Firmware?',
    message: `This flashes Even's stock firmware ${BASE_STOCK_VERSION_TEXT} to both lenses and removes Faceclaw's custom features. ` +
      `${APP_NAME} needs Faceclaw firmware to work with your glasses.`,
    okButtonText: 'Restore', cancelButtonText: 'Cancel' })
  if (ok) await flash('uninstall')
}
