import { Dialogs, Label, knownFolders, type NavigatedData, type NavigationEntry, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, switchRow, buttonRow, type Row } from './ui-kit'
import { getRuntime } from './runtime'
import { itemTitle, settingsCategory, type CatalogItem, type CatalogSection, type SettingsCategory } from '../../ui/dashboard/settings-catalog'
import { ConfigSettingBoolean, ConfigSettingEnum, onAnySettingChanged, type ConfigSettingString } from '../../ui/dashboard-settings'
import { readNotificationSources, setNotificationSourceEnabled } from '../../native/notification-sources'
import { isNotificationListenerEnabled, notificationEmptyMessage } from '../../native/notification-access'
import { onAndroidNotificationsChanged } from '../../native/notification-icons'
import { remoteTokens, remoteInputStatus, remoteInterfaceSelection, selectRemoteInterface } from '../../remote/service'
import { PERMISSIONS, type Permission } from '../../remote/protocol'
import { isTunnelInterface } from '../../remote/listeners'
import { copyRemoteToken, remoteInterfaces } from '../../native/remote-input'
import { IOS_PRIVACY_NOTICE } from '../../analytics/privacy-disclosure'
import { ASR_MODELS, asrModelState, cancelAsrModelDownload, deleteAsrModel, onAsrModelStateChanged, startAsrModelDownload, type AsrModelId } from '../../native/asr-model'

// The controller's iOS text-setting prompt (Dialogs.prompt, re-asks on a
// validation error). It is private on IosPreviewController; the glasses reach
// it through their LayerActions, the phone page directly.
type TextEditor = { editSetting(setting: ConfigSettingString): Promise<boolean> }
export const editTextSetting = (setting: ConfigSettingString) =>
  (getRuntime().controller as unknown as TextEditor).editSetting(setting)

/**
 * A bundled doc (webpack.config.js copies them into about/) as an OcuSmart
 * page: the shared document-page has no dark styling or bar tint.
 */
export function documentPage(fileName: string, title: string): Page {
  let text = ''
  try { text = knownFolders.currentApp().getFile(`about/${fileName}`).readTextSync() } catch { /* shown as missing */ }
  return groupedPage({ title, largeTitle: false, build: container => {
    const label = new Label()
    label.text = text || `(${fileName} is missing from this build)`; label.textWrap = true; label.className = 'os-document-text'
    container.addChild(label)
  } }).page
}

const shortValue = (text: string) => !text ? 'Not set' : text.length <= 22 ? text : `${text.slice(0, 21)}…`

// Same wording as the glasses token menu (remote-input-menu.ts).
const PERMISSION_LABELS: Record<Permission, string> = { input: 'Provide input', text: 'Text to foreground window', assistant: 'Text to voice assistant' }
const permissionSummary = (permissions: Permission[]) => permissions.map(p => PERMISSION_LABELS[p]).join(', ') || 'No permissions'

/** One row per catalog entry: bool → switch, enum → choice list, string → the controller's prompt. */
export function settingRows(item: CatalogItem, open: (entry: NavigationEntry) => void, written: () => void = () => {}): Row[] {
  switch (item.kind) {
    case 'setting': {
      const setting = item.setting, title = itemTitle(item)
      if (setting instanceof ConfigSettingBoolean) return [switchRow({ title, value: setting.get(), onChange: value => { setting.set(value); written() } })]
      if (setting instanceof ConfigSettingEnum) return [navRow({ title, value: setting.displayValue(),
        onTap: () => open({ moduleName: 'ocusmart/settings-choice', context: { item } }) })]
      // The shared key formatters write '(not set)' and '...' for the glasses' font.
      return [navRow({ title, value: setting.get() ? shortValue(setting.displayValue().replace(/\.\.\.$/, '…')) : 'Not set',
        onTap: () => { void editTextSetting(setting) } })]
    }
    case 'notification-sources':
      return readNotificationSources().map(source => switchRow({ title: source.appName, value: source.showOnGlasses,
        onChange: value => { setNotificationSourceEnabled(source, value); written() } }))
    case 'input-tokens':
      return [
        ...remoteTokens.list().map(record => navRow({ title: record.name, subtitle: permissionSummary(record.permissions),
          onTap: () => { void editToken(record.id) } })),
        buttonRow({ title: 'Create Token…', onTap: () => { void createToken() } }),
        navRow({ title: 'Listening Interfaces', value: interfaceChoices().find(choice => choice.value === remoteInterfaceSelection())?.label ?? '',
          onTap: () => { void chooseInterface() } }),
        buttonRow({ title: 'Connection Information', onTap: () => { void Dialogs.alert({ title: 'Connection Information', message: connectionInformation(), okButtonText: 'OK' }) } }),
      ]
    case 'ios-privacy-notice':
      return [buttonRow({ title: 'iOS / TestFlight Privacy', onTap: () => {
        void Dialogs.alert({ title: 'iOS / TestFlight Privacy', message: IOS_PRIVACY_NOTICE.replace('Privacy policy', 'Privacy Policy'), okButtonText: 'OK' })
      } })]
    case 'document':
      return [navRow({ title: item.title, onTap: () => open({ create: () => documentPage(item.fileName, item.title) }) })]
    case 'asr-model':
      return [navRow({ title: asrModelTitle(item.model), value: asrModelValue(item.model), onTap: () => { void manageAsrModel(item.model) } })]
  }
}

const asrModelTitle = (id: AsrModelId) => `${ASR_MODELS[id].label} Model`
const asrModelMb = (id: AsrModelId) => `${Math.round(ASR_MODELS[id].totalBytes / 1e6)} MB`

function asrModelValue(id: AsrModelId): string {
  const state = asrModelState(id)
  if (state.status === 'ready') return 'Downloaded'
  if (state.status === 'downloading') return `${state.totalBytes > 0 ? Math.floor(state.bytesDownloaded / state.totalBytes * 100) : 0}%`
  return asrModelMb(id)
}

/** The glasses menu's Download / Cancel / Delete, as an action sheet. */
async function manageAsrModel(id: AsrModelId): Promise<void> {
  const status = asrModelState(id).status
  const choice = status === 'downloading' ? 'Cancel Download' : status === 'ready' ? 'Delete Model' : `Download (${asrModelMb(id)})`
  const picked = await Dialogs.action({ title: asrModelTitle(id), message: 'Transcribes voice input on the phone itself, with no API key or cloud service.',
    cancelButtonText: 'Close', actions: [choice] })
  if (picked !== choice) return
  if (status === 'downloading') cancelAsrModelDownload(id)
  else if (status === 'ready') deleteAsrModel(id)
  else startAsrModelDownload(id)
}

function sectionFooter(entry: CatalogSection): string | undefined {
  if (!entry.items.some(item => item.kind === 'notification-sources')) return entry.footer
  const lines = ['Apps appear here once they post a notification while the glasses are connected. Turn one off to keep its notifications off the glasses.']
  if (!isNotificationListenerEnabled()) lines.unshift(notificationEmptyMessage())
  return lines.join('\n\n')
}

/** What the page shows, so a store change that touches none of it skips the rebuild. */
export function categoryKey(category: SettingsCategory | null): string {
  if (!category) return ''
  return JSON.stringify(category.sections().map(entry => [sectionFooter(entry), entry.items.map(item => {
    switch (item.kind) {
      case 'setting': return [item.setting.label, item.setting.displayValue()]
      case 'notification-sources': return [readNotificationSources(), isNotificationListenerEnabled()]
      case 'input-tokens': return [remoteTokens.list().map(record => [record.id, record.name, record.permissions]), remoteInterfaceSelection()]
      case 'ios-privacy-notice': case 'document': return item.kind
      case 'asr-model': return asrModelValue(item.model)
    }
  })]))
}

export function createPage(): Page {
  let category: SettingsCategory | null = null, shown = ''
  const { page, refresh } = groupedPage({ title: 'Settings', largeTitle: false, build: container => {
    shown = categoryKey(category)
    if (!category) return
    const open = (entry: NavigationEntry) => page.frame?.navigate(entry)
    for (const entry of category.sections()) {
      // A switch already shows its new value; rebuilding under it would cut its animation.
      const rows = entry.items.flatMap(item => settingRows(item, open, () => { shown = categoryKey(category) }))
      const footer = sectionFooter(entry)
      if (rows.length || footer) container.addChild(section({ header: entry.header, footer, rows }))
    }
  } })
  page.on('navigatingTo', (args: NavigatedData) => {
    if (category) return
    category = settingsCategory((args.context as { category?: string } | undefined)?.category)
    page.actionBar.title = category?.title ?? 'Settings'
    refresh()
  })
  let offs: (() => void)[] = []
  page.on('loaded', () => {
    for (const off of offs) off()
    const update = () => { if (categoryKey(category) !== shown) refresh() }
    // Glasses-side changes, the rows that depend on other settings, and the
    // ANCS session state behind the Notifications footer (not a stored setting).
    offs = [onAnySettingChanged(update), onAndroidNotificationsChanged(update),
      ...(Object.keys(ASR_MODELS) as AsrModelId[]).map(id => onAsrModelStateChanged(id, update))]
    update()
  })
  page.on('unloaded', () => { for (const off of offs) off(); offs = [] })
  return page
}

function interfaceChoices(): { value: string; label: string }[] {
  let interfaces: ReturnType<typeof remoteInterfaces> = []
  try { interfaces = remoteInterfaces().filter(isTunnelInterface) } catch { /* the native listener is not up yet */ }
  const names = [...new Set(interfaces.map(item => item.name))]
  return [
    { value: 'tailscale', label: 'Localhost + Tailscale (auto)' },
    { value: 'localhost', label: 'Localhost / USB only' },
    ...names.map(name => ({ value: `interface:${name}`, label: `${name}: ${interfaces.filter(item => item.name === name).map(item => item.address).join(', ')}` })),
  ]
}

async function chooseInterface(): Promise<void> {
  const choices = interfaceChoices(), current = remoteInterfaceSelection()
  const picked = await Dialogs.action({ title: 'Listening Interfaces', cancelButtonText: 'Cancel',
    actions: choices.map(choice => choice.value === current ? `✓ ${choice.label}` : choice.label) })
  const choice = choices.find(item => picked === item.label || picked === `✓ ${item.label}`)
  if (choice) selectRemoteInterface(choice.value)
}

const connectionInformation = () => `${remoteInputStatus()}\n\niOS USB: iproxy 8791 8791\n\nTailscale: use --host with the displayed tunnel IP. Listening Interfaces lets you select a tunnel if auto detection fails. Wi-Fi/LAN addresses are never selected.\n\nUse scripts/faceclaw-input.cjs with FACECLAW_TOKEN set. Tokens grant only the selected permissions. Revoking a token takes effect on the next request. Text is blocked while the glasses are locked.`

/** Toggle permissions in an action sheet until the user picks `done`. */
async function pickPermissions(title: string, get: () => Permission[], set: (values: Permission[]) => void, done: string): Promise<boolean> {
  while (true) {
    const current = get()
    const actions = PERMISSIONS.map(p => `${PERMISSION_LABELS[p]}: ${current.includes(p) ? 'On' : 'Off'}`)
    const picked = await Dialogs.action({ title, message: 'Tap a permission to turn it on or off.', cancelButtonText: 'Cancel', actions: [...actions, done] })
    if (picked === done) return true
    const index = actions.indexOf(picked)
    if (index < 0) return false
    const permission = PERMISSIONS[index]
    set(current.includes(permission) ? current.filter(p => p !== permission) : [...current, permission])
  }
}

async function editToken(id: string): Promise<void> {
  const record = () => remoteTokens.list().find(item => item.id === id)
  const name = record()?.name
  if (!name) return
  try {
    if (!await pickPermissions(name, () => record()?.permissions ?? [], values => remoteTokens.permissions(id, values), 'Revoke Token…')) return
    if (await Dialogs.confirm({ title: `Revoke ${name}?`, message: 'Apps using this token lose access on their next request.', okButtonText: 'Revoke', cancelButtonText: 'Cancel' })) remoteTokens.revoke(id)
  } catch (error) { await showTokenError(error) }
}

async function createToken(): Promise<void> {
  const named = await Dialogs.prompt({ title: 'Create Input Token', message: 'Token name', defaultText: 'My app', okButtonText: 'Next', cancelButtonText: 'Cancel' })
  if (!named.result) return
  let permissions: Permission[] = ['input']
  if (!await pickPermissions('Token Permissions', () => permissions, values => { permissions = values }, 'Generate Token')) return
  try {
    const { token } = remoteTokens.create((named.text.trim() || 'My app').slice(0, 80), permissions)
    // The secret exists only here; it cannot be shown again once this sheet closes.
    while (true) {
      const picked = await Dialogs.action({ title: 'Save Your Token Now', message: 'Save it in the calling app or FACECLAW_TOKEN. The secret cannot be shown again after you close this.',
        cancelButtonText: 'Done', actions: ['Copy Token', 'Show Token'] })
      if (picked === 'Copy Token') { copyRemoteToken(token); await Dialogs.alert({ title: 'Copied', message: 'Token copied to the clipboard.', okButtonText: 'OK' }) }
      else if (picked === 'Show Token') await Dialogs.alert({ title: 'Input Token', message: token, okButtonText: 'OK' })
      else return
    }
  } catch (error) { await showTokenError(error) }
}

const showTokenError = (error: unknown) => Dialogs.alert({ title: 'Input Tokens',
  message: error instanceof Error ? error.message : 'Could not update token.', okButtonText: 'OK' })
