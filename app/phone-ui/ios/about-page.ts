import { Label, StackLayout, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, valueRow, customRow } from './ui-kit'
import { getRuntime } from './runtime'
import { presentDetour } from './detour'
import { documentPage } from './settings-category-page'
import { firmwareKindLabel, firmwareSummary, reportedState } from './firmware-info'
import { firmwareKey } from './update-page'
import { APP_NAME } from '../../branding'
import { FACECLAW_VERSION } from '../../version'

// The project docs webpack.config.js copies into the bundle's about/ folder.
const DOCUMENTS = [['README.md', 'README'], ['LICENSE', 'License'], ['PRIVACY', 'Privacy Policy'], ['ACKNOWLEDGEMENTS.md', 'Acknowledgements']] as const

export function createPage(): Page {
  const runtime = getRuntime(), controller = runtime.controller
  let shown = ''
  const { page, refresh } = groupedPage({ title: 'General', largeTitle: false, build: container => {
    shown = firmwareKey(controller.connectionState)
    const state = reportedState(controller.connectionState), extension = firmwareSummary(state).extension
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
      valueRow({ title: 'Firmware', value: extension ? firmwareKindLabel(extension) : 'Not reported' }),
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
