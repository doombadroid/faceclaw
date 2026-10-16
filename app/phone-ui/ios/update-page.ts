import { Dialogs, Label, StackLayout, GridLayout, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, buttonRow, valueRow, customRow, tile, type Row } from './ui-kit'
import { getRuntime } from './runtime'
import { presentDetour } from './detour'
import { firmwareSummary, firmwareChannel, firmwareImageBytes, firmwareKindLabel, formatMegabytes, reportedState, updateStatus } from './firmware-info'
import { BASE_STOCK_VERSION_TEXT, REQUIRED_FACECLAW_FIRMWARE_VERSION, classifyOnboardingFirmware, describeFirmwareExtension } from '../../g2/firmware-compat'
import type { SessionState } from '../../g2/ios-preview-controller'
import { APP_NAME } from '../../branding'

export const flash = (mode: 'install' | 'uninstall') => presentDetour('phone-ui/onboarding-flash-page', { mode, fromOnboarding: false })
export const CHANNEL_NAMES = { faceclaw: 'Faceclaw', even: 'Even Realities' }

// The flash page's own guidance (onboarding-flash-view-model.ts, MIN_FLASH_BATTERY_PERCENT).
const FLASH_GUIDANCE = 'Keep both lenses powered on and nearby — each lens takes a few minutes, and the glasses ' +
  'will reboot when each lens finishes. Both lenses need at least 30% battery. Do not close the app during flashing.'

/** Frame acks also emit 'connection'; only the reported firmware, or the session dropping, changes this page. */
export const firmwareKey = (state: SessionState | null) => [state?.phase, state?.capabilities, state?.leftVersion, state?.rightVersion].join('\n')

function text(value: string, className: string): Label {
  const view = new Label()
  view.text = value; view.className = className; view.textWrap = true
  return view
}

function header(subtitle: string, status: string): Row {
  const grid = new GridLayout()
  grid.columns = 'auto,*'; grid.rows = 'auto,auto'; grid.className = 'os-update-header'
  const icon = tile('eyeglasses', 'gray')
  icon.className += ' os-update-icon'; icon.verticalAlignment = 'middle'
  grid.addChild(icon)
  const heading = new StackLayout()
  heading.verticalAlignment = 'middle'
  heading.addChild(text(`Faceclaw r${REQUIRED_FACECLAW_FIRMWARE_VERSION}`, 'os-update-title'))
  heading.addChild(text(subtitle, 'os-row-subtitle'))
  GridLayout.setColumn(heading, 1); grid.addChild(heading)
  const body = text(status, 'os-update-body')
  GridLayout.setRow(body, 1); GridLayout.setColumnSpan(body, 2); grid.addChild(body)
  return customRow(grid)
}

export function createPage(): Page {
  const runtime = getRuntime()
  let shown = ''
  const { page, refresh } = groupedPage({ title: 'Software Update', largeTitle: false, build: container => {
    shown = firmwareKey(runtime.controller.connectionState)
    const state = reportedState(runtime.controller.connectionState)
    const summary = firmwareSummary(state), status = updateStatus(summary.extension)
    const statusText = !summary.extension ? 'Connect your glasses to check whether it is installed.'
      : status === 'current' ? 'Installed. Your glasses are up to date.'
      : status === 'newer' ? `Your glasses run ${describeFirmwareExtension(summary.extension)}, newer than the revision ` +
        `${REQUIRED_FACECLAW_FIRMWARE_VERSION} this version of ${APP_NAME} bundles. Installing would downgrade them.`
      : `Available for your glasses, which run ${describeFirmwareExtension(summary.extension)} (${summary.version}).`
    const about = `Faceclaw's custom firmware, built on this iPhone from Even's stock ${BASE_STOCK_VERSION_TEXT} ` +
      'download and verified against pinned hashes before flashing.'
    container.addChild(section({ rows: [header(`Faceclaw channel · ${formatMegabytes(firmwareImageBytes())}`, `${statusText} ${about}`)] }))

    let footer = FLASH_GUIDANCE
    if (state && classifyOnboardingFirmware({ leftVersion: state.leftVersion, rightVersion: state.rightVersion, extension: state.capabilities }).kind === 'newer-stock-unvalidated')
      footer = `Your glasses run stock firmware ${summary.version}, newer than the ${BASE_STOCK_VERSION_TEXT} release ` +
        `Faceclaw's image is built from. Flashing may not work correctly and carries extra risk. ${footer}`
    container.addChild(section({ footer, rows: [buttonRow({ title: status === 'current' ? 'Reinstall'
      : status === 'newer' ? `Downgrade to r${REQUIRED_FACECLAW_FIRMWARE_VERSION}` : 'Download and Install', onTap: () => { void flash('install') } })] }))

    const channel = firmwareChannel(summary.extension)
    container.addChild(section({ rows: [navRow({ title: 'Firmware Channel', value: channel ? CHANNEL_NAMES[channel] : undefined,
      onTap: () => page.frame?.navigate({ moduleName: 'ocusmart/firmware-channel' }) })] }))

    const installed: Row[] = summary.extension ? [
      valueRow({ title: 'Left', value: state?.leftVersion || 'Not reported' }),
      valueRow({ title: 'Right', value: state?.rightVersion || 'Not reported' }),
      valueRow({ title: 'Firmware', value: firmwareKindLabel(summary.extension) }),
    ] : []
    // Restoring stock onto stock would be a no-op reflash.
    const restorable = summary.extension?.kind !== 'none'
    if (restorable) installed.push(buttonRow({ title: 'Restore Even Firmware', role: 'destructive', onTap: () => { void restore() } }))
    container.addChild(section({ header: 'Installed', rows: installed,
      footer: [summary.extension ? '' : 'Connect your glasses to see the installed versions.',
        summary.extension && 'text' in summary.extension ? `The glasses report "${summary.extension.text}".` : '',
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
