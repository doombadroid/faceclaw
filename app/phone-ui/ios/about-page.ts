import { Label, StackLayout, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, valueRow, customRow, buttonRow } from './ui-kit'
import { getRuntime } from './runtime'
import { presentDetour } from './detour'
import { documentPage, editTextSetting } from './settings-category-page'
import { firmwareKindLabel, firmwareSummary, reportedState } from './firmware-info'
import { firmwareKey } from './update-page'
import { APP_NAME } from '../../branding'
import { FACECLAW_VERSION } from '../../version'
import { listErrorReports, onErrorReport } from '../../native/error-reports'
import { flushRemoteLog, remoteLogStatus, sendRemoteLogTest } from '../../native/remote-log.ios'
import { remoteLogUrlSetting } from '../../ui/dashboard-settings'

// The project docs webpack.config.js copies into the bundle's about/ folder.
const DOCUMENTS = [['README.md', 'README'], ['LICENSE', 'License'], ['PRIVACY', 'Privacy Policy'], ['ACKNOWLEDGEMENTS.md', 'Acknowledgements']] as const

// The On-device (Parakeet) transcription model's CC BY 4.0 attribution, and FluidAudio's license.
export const PARAKEET_CREDIT = 'On-device (Parakeet) transcription uses NVIDIA\'s Parakeet TDT 0.6B v3 model (huggingface.co/nvidia/parakeet-tdt-0.6b-v3), ' +
  'licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0), as converted to Core ML by FluidInference ' +
  '(huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml). It runs with FluidAudio by FluidInference, under the Apache License 2.0.'

// Five taps on the app name show Developer (Remote Log URL, Translate Tests) until relaunch; a set URL keeps it shown.
let nameTaps = 0

const clock = (iso: string) => iso ? new Date(iso).toLocaleTimeString() : 'never'

function remoteLogText(): string {
  const s = remoteLogStatus()
  if (!s.on) return `Off. ${s.queued ? `${s.queued} lines wait for a URL.` : 'Set a URL to start sending.'}`
  return [`${s.sending ? 'Sending' : s.retryInMs ? `Retrying in ${Math.ceil(s.retryInMs / 1000)} s` : 'On'}. Sent ${s.sent}, queued ${s.queued}` + (s.dropped ? `, dropped ${s.dropped}` : ''),
    `Last success: ${clock(s.lastSuccessAt)}`, `Last error: ${s.lastError ? `${clock(s.lastErrorAt)} ${s.lastError}` : 'none'}`].join('\n')
}

export function createPage(): Page {
  const runtime = getRuntime(), controller = runtime.controller
  let shown = '', shownReports = 0, logStatus: Label | null = null
  const { page, refresh } = groupedPage({ title: 'General', largeTitle: false, build: container => {
    shown = firmwareKey(controller.connectionState)
    shownReports = listErrorReports().length
    const state = reportedState(controller.connectionState), extension = firmwareSummary(state).extension
    const head = new StackLayout()
    head.className = 'os-row os-about-head'
    const name = new Label(), version = new Label()
    name.text = APP_NAME; name.className = 'os-about-name'
    version.text = `Version ${FACECLAW_VERSION}`; version.className = 'os-row-subtitle'
    head.addChild(name); head.addChild(version)
    head.on('tap', () => { if (++nameTaps === 5) refresh() })
    container.addChild(section({ rows: [customRow(head)],
      footer: 'By James Babcock and other contributors. Distributed under the GNU General Public License, version 3.' }))
    container.addChild(section({ header: 'Glasses firmware', rows: [
      valueRow({ title: 'Left', value: state?.leftVersion || 'Not reported' }),
      valueRow({ title: 'Right', value: state?.rightVersion || 'Not reported' }),
      valueRow({ title: 'Firmware', value: extension ? firmwareKindLabel(extension) : 'Not reported' }),
    ], footer: state?.leftVersion || state?.rightVersion ? undefined : 'The glasses report their versions after they connect.' }))
    container.addChild(section({ header: 'Documents', rows: DOCUMENTS.map(([fileName, title]) =>
      navRow({ title, onTap: () => page.frame?.navigate({ create: () => documentPage(fileName, title) }) })), footer: PARAKEET_CREDIT }))
    container.addChild(section({ rows: [navRow({ title: 'Error Reports', value: String(shownReports),
      onTap: () => page.frame?.navigate({ moduleName: 'ocusmart/error-reports' }) }),
    ...nameTaps >= 5 ? [navRow({ title: 'Translate Tests', onTap: () => page.frame?.navigate({ moduleName: 'ocusmart/translate-tests' }) })] : []],
      footer: `Errors ${APP_NAME} caught and recovered from, kept for bug reports.` }))
    logStatus = null
    const url = remoteLogUrlSetting.get()
    if (nameTaps >= 5 || url) {
      // A new label per build: the old section keeps its row (see translate-tests-page.ts).
      logStatus = new Label()
      logStatus.className = 'os-error-stack'; logStatus.textWrap = true; logStatus.text = remoteLogText()
      container.addChild(section({ header: 'Developer', rows: [
        navRow({ title: 'Remote Log URL', value: url ? url.replace(/^https?:\/\//, '').split('/')[0]! : 'Off', onTap: () => {
          void editTextSetting(remoteLogUrlSetting).then(saved => { if (saved) { flushRemoteLog(); refresh() } })
        } }),
        customRow(logStatus),
        buttonRow({ title: 'Send Test Line', enabled: !!url, onTap: () => { sendRemoteLogTest(); if (logStatus) logStatus.text = remoteLogText() } }),
      ], footer: 'Sends error reports, the app log and console output to <URL>/log while set. API keys and tokens are redacted.' }))
    }
    // The old menu opened Permissions without dropping the connection.
    container.addChild(section({ rows: [navRow({ title: 'Permissions', onTap: () => { void presentDetour('phone-ui/permissions-page', undefined, false) } })] }))
  } })
  let offs: (() => void)[] = []
  let statusTimer: ReturnType<typeof setInterval> | null = null
  const reportsChanged = () => { if (listErrorReports().length !== shownReports) refresh() }
  page.on('loaded', () => {
    for (const off of offs) off()
    offs = [runtime.on('connection', state => { if (firmwareKey(state) !== shown) refresh() }), onErrorReport((_report, isNew) => { if (isNew) reportsChanged() })]
    refresh()
    if (statusTimer === null) statusTimer = setInterval(() => { if (logStatus) logStatus.text = remoteLogText() }, 1000)
  })
  // Back from the list after Clear.
  page.on('navigatedTo', reportsChanged)
  page.on('unloaded', () => {
    for (const off of offs) off()
    offs = []
    if (statusTimer !== null) clearInterval(statusTimer)
    statusTimer = null
  })
  return page
}
