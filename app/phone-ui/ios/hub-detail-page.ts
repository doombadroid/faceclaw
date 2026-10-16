import { GridLayout, Label, StackLayout, type NavigatedData, type Page } from '@nativescript/core'
import { groupedPage, section, navRow, valueRow, customRow, type Row } from './ui-kit'
import { actionPill, artworkTile, hubAction, runHubAction } from './hub-page'
import { evenHubApi, type EvenHubStoreApp } from '../../apps/evenhub/even-api'
import { getInstalledEvenHubApp, getInstalledEvenHubFingerprint, installedEvenHubPackagePath, readEvenHubPackageManifest } from '../../apps/evenhub/installed-apps'
import { describeUpdate } from '../../apps/evenhub/updates'
import { permissionDetail, permissionLabel } from '../../apps/evenhub/permissions'
import { openPrivacyPolicyOnPhone } from '../../apps/evenhub/privacy-policy'
import { onSettingsStoreChanged } from '../../native/settings-store'

function text(value: string, className: string): Label {
  const label = new Label()
  label.text = value; label.className = className; label.textWrap = true
  return label
}

function paragraph(value: string): Row {
  const box = new StackLayout()
  box.className = 'os-row os-hub-paragraph'
  box.addChild(text(value, 'os-row-title'))
  return customRow(box)
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : value
}

/** What the installed copy is, or the install's progress while one runs. */
export function standingLine(app: EvenHubStoreApp, status: string): string {
  if (status) return status
  const installed = getInstalledEvenHubApp(app.packageId)
  if (!installed) return ''
  const standing = describeUpdate(installed, app)
  if (standing.packageMissing) return 'Installed, but its package is missing. Reinstall to use it.'
  if (standing.updateAvailable) return `Version ${installed.version} installed; ${app.version} is available.`
  return `Version ${installed.version} installed. Open runs it on your glasses.`
}

export function createPage(): Page {
  let app: EvenHubStoreApp | null = null, status = '', fingerprint = ''
  const { page, refresh } = groupedPage({ title: '', largeTitle: false, build: container => {
    if (!app) return
    const shown = app
    fingerprint = getInstalledEvenHubFingerprint()

    const header = new GridLayout()
    header.columns = 'auto,*'
    header.className = 'os-row os-hub-header'
    const art = artworkTile(shown, 80)
    art.marginRight = 14; art.verticalAlignment = 'top'
    header.addChild(art)
    const titles = new StackLayout()
    titles.addChild(text(shown.name, 'os-hub-title'))
    if (shown.creatorName) titles.addChild(text(shown.creatorName, 'os-row-subtitle'))
    const pill = actionPill(shown, () => {
      if (hubAction(shown) !== 'OPEN') { status = 'Starting…'; refresh() }
      void runHubAction(shown, next => { status = next; refresh() }).then(refresh)
    })
    pill.horizontalAlignment = 'left'; pill.marginTop = 10
    titles.addChild(pill)
    GridLayout.setColumn(titles, 1); header.addChild(titles)
    container.addChild(section({ footer: standingLine(shown, status) || undefined, rows: [customRow(header)] }))

    const about = shown.description || shown.tagline
    if (about) container.addChild(section({ header: 'About', rows: [paragraph(about)] }))
    if (shown.changelog) container.addChild(section({ header: "What's New", footer: shown.version ? `Version ${shown.version}` : undefined, rows: [paragraph(shown.changelog)] }))

    const info: Row[] = []
    if (shown.creatorName) info.push(valueRow({ title: 'Developer', value: shown.creatorName }))
    if (shown.version) info.push(valueRow({ title: 'Version', value: shown.version }))
    if (shown.fileSize > 0) info.push(valueRow({ title: 'Size', value: formatBytes(shown.fileSize) }))
    if (shown.categories.length) info.push(valueRow({ title: 'Category', value: shown.categories.join(', ') }))
    if (shown.firstPublishedAt) info.push(valueRow({ title: 'Released', value: formatDate(shown.firstPublishedAt) }))
    if (info.length) container.addChild(section({ header: 'Information', rows: info }))

    // The store record carries no permissions or policy; the package does.
    const manifest = getInstalledEvenHubApp(shown.packageId) ? readEvenHubPackageManifest(installedEvenHubPackagePath(shown.packageId)) : null
    if (manifest) {
      const rows: Row[] = manifest.permissions.map(permission => {
        const box = new StackLayout()
        box.className = 'os-row'
        box.addChild(text(permissionLabel(permission.name), 'os-row-title'))
        const detail = permissionDetail(permission)
        if (detail) box.addChild(text(detail, 'os-row-subtitle'))
        return customRow(box)
      })
      if (!rows.length) rows.push(valueRow({ title: 'None declared', value: '' }))
      if (manifest.privacyPolicyUrl) rows.push(navRow({ title: 'Privacy Policy', onTap: () => openPrivacyPolicyOnPhone(manifest.privacyPolicyUrl, shown.name) }))
      container.addChild(section({ header: 'Permissions', rows,
        footer: 'Declared by the installed version. An update that asks for more asks you first.' }))
    } else {
      container.addChild(section({ header: 'Permissions',
        footer: "Even Hub sends an app's permissions and privacy policy with its package. Before it installs, you'll see each permission and can open the policy or cancel.",
        rows: [] }))
    }
  } })

  let off: (() => void) | null = null
  page.on('navigatingTo', (args: NavigatedData) => {
    if (app || args.isBackNavigation) return
    app = (args.context as { app?: EvenHubStoreApp } | undefined)?.app ?? null
    if (!app) return
    page.actionBar.title = app.name
    refresh()
    // List rows can be partial; the detail record fills in description and changelog.
    const packageId = app.packageId
    void evenHubApi.getStoreAppDetail(packageId).then(detail => {
      if (detail && app?.packageId === packageId) { app = { ...app, ...detail }; refresh() }
    }).catch(error => console.log(`hub: details unavailable for ${packageId}: ${String((error as Error)?.message ?? error)}`))
  })
  // Installs from the glasses change the button too, including while this tab was unloaded.
  const sync = () => { if (app && getInstalledEvenHubFingerprint() !== fingerprint) refresh() }
  page.on('loaded', () => {
    off?.()
    off = onSettingsStoreChanged(sync)
    sync()
  })
  page.on('unloaded', () => { off?.(); off = null })
  return page
}
