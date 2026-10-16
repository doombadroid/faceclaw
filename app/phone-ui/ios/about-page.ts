import { Label, StackLayout, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, valueRow, customRow } from './ui-kit'
import { getRuntime } from './runtime'
import type { SessionState } from '../../g2/ios-preview-controller'
import { presentDetour } from './detour'
import { documentPage } from './settings-category-page'
import { firmwareSummary } from './firmware-info'
import { APP_NAME } from '../../branding'
import { FACECLAW_VERSION } from '../../version'

// The project docs webpack.config.js copies into the bundle's about/ folder.
const DOCUMENTS = [['README.md', 'README'], ['LICENSE', 'License'], ['PRIVACY', 'Privacy Policy'], ['ACKNOWLEDGEMENTS.md', 'Acknowledgements']] as const

/** What the glasses reported running, by the extension slot they sent. */
export function firmwareKind(state: SessionState | null): string {
  const extension = firmwareSummary(state).extension
  switch (extension?.kind) {
    case undefined: return 'Not reported yet'
    case 'faceclaw': return `Faceclaw r${extension.version}`
    case 'legacy-faceclaw': return 'Older Faceclaw'
    case 'none': return 'Even stock'
    case 'other': return 'Other custom firmware'
  }
}

const firmwareKey = (state: SessionState | null) => [state?.leftVersion, state?.rightVersion, state?.capabilities].join('\n')

export function createPage(): Page {
  const runtime = getRuntime(), controller = runtime.controller
  let shown = ''
  const { page, refresh } = groupedPage({ title: 'General', largeTitle: false, build: container => {
    const state = controller.connectionState
    shown = firmwareKey(state)
    const head = new StackLayout()
    head.className = 'os-row os-about-head'
    const name = new Label(), version = new Label()
    name.text = APP_NAME; name.className = 'os-about-name'
    version.text = `Version ${FACECLAW_VERSION}`; version.className = 'os-row-subtitle'
    head.addChild(name); head.addChild(version)
    container.addChild(section({ rows: [customRow(head)],
      footer: 'By James Babcock and other contributors. Distributed under the GNU General Public License, version 3.' }))
    container.addChild(section({ header: 'Glasses firmware', rows: [
      valueRow({ title: 'Left', value: state?.leftVersion || 'Not reported' }),
      valueRow({ title: 'Right', value: state?.rightVersion || 'Not reported' }),
      valueRow({ title: 'Firmware', value: firmwareKind(state) }),
    ], footer: state?.leftVersion || state?.rightVersion ? undefined : 'The glasses report their versions after they connect.' }))
    container.addChild(section({ header: 'Documents', rows: DOCUMENTS.map(([fileName, title]) =>
      navRow({ title, onTap: () => page.frame?.navigate({ create: () => documentPage(fileName, title) }) })) }))
    // The old menu opened Permissions without dropping the connection.
    container.addChild(section({ rows: [navRow({ title: 'Permissions', onTap: () => { void presentDetour('phone-ui/permissions-page', undefined, false) } })] }))
  } })
  let off: (() => void) | null = null
  page.on('loaded', () => {
    off?.()
    off = runtime.on('connection', state => { if (firmwareKey(state) !== shown) refresh() })
    refresh()
  })
  page.on('unloaded', () => { off?.(); off = null })
  return page
}
