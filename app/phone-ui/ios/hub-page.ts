import { Button, Dialogs, GridLayout, Image, ImageSource, Label, SearchBar, SegmentedBar, SegmentedBarItem, StackLayout, type Page, type ScrollView, type View } from '@nativescript/core'
import { groupedPage, section, buttonRow, valueRow, type TileColor } from './ui-kit'
import { getRuntime } from './runtime'
import { pushInTab } from './shell'
import { APP_NAME } from '../../branding'
import { evenHubApi, EvenHubAuthenticationError, type EvenHubStoreApp, type EvenHubStorePage } from '../../apps/evenhub/even-api'
import { clearEvenHubSession, evenHubEmailSetting, hasEvenHubCredentials } from '../../apps/evenhub/credentials'
import { getInstalledEvenHubApp, getInstalledEvenHubFingerprint, installedEvenHubAppId } from '../../apps/evenhub/installed-apps'
import { checkForEvenHubUpdates, describeUpdate } from '../../apps/evenhub/updates'
import { cleanError, installStoreApp, type PermissionRequest } from '../../apps/evenhub/store-install'
import { permissionDetail, permissionLabel } from '../../apps/evenhub/permissions'
import { openPrivacyPolicyOnPhone } from '../../apps/evenhub/privacy-policy'
import { onSettingsStoreChanged } from '../../native/settings-store'

export type HubAction = 'GET' | 'OPEN' | 'UPDATE' | 'REINSTALL'

/** The store button for an app, from its installed copy (same mapping as the glasses detail page). */
export function hubAction(app: EvenHubStoreApp): HubAction {
  const installed = getInstalledEvenHubApp(app.packageId)
  if (!installed) return 'GET'
  const standing = describeUpdate(installed, app)
  return standing.packageMissing ? 'REINSTALL' : standing.updateAvailable ? 'UPDATE' : 'OPEN'
}

export type Listing = { apps: EvenHubStoreApp[]; nextPage: number; exhausted: boolean }
export const emptyListing = (): Listing => ({ apps: [], nextPage: 1, exhausted: false })

/**
 * Append one page. /ranking and /search may ignore paging, so a page that adds
 * nothing new (or a short page with no total) ends the list (store-layer.ts).
 */
export function mergePage(listing: Listing, page: EvenHubStorePage): Listing {
  const seen = new Set(listing.apps.map(app => app.packageId))
  const fresh = page.apps.filter(app => !seen.has(app.packageId))
  const apps = [...listing.apps, ...fresh]
  return { apps, nextPage: page.page + 1,
    exhausted: (page.total > 0 && apps.length >= page.total) || fresh.length === 0 || (page.total === 0 && page.apps.length < page.pageSize) }
}

/** The phone's permission prompt: every declared permission is in the message, above Allow. */
export async function confirmOnPhone(request: PermissionRequest): Promise<boolean> {
  const lines = request.permissions.map(permission => {
    const detail = permissionDetail(permission)
    return detail ? `${permissionLabel(permission.name)}: ${detail}` : permissionLabel(permission.name)
  })
  const message = (lines.length ? `${request.appName} will be able to use:\n\n${lines.join('\n')}` : `${request.appName} declares no permissions.`)
    + (request.privacyPolicyUrl ? '\n\nIt has a privacy policy you can read first.' : '')
  for (;;) {
    const choice = await Dialogs.confirm({ title: `Install ${request.appName}?`, message, okButtonText: 'Allow', cancelButtonText: 'Cancel',
      neutralButtonText: request.privacyPolicyUrl ? 'View Privacy Policy' : undefined })
    if (choice !== undefined || !request.privacyPolicyUrl) return !!choice
    // Safari takes over; the prompt is waiting again on return.
    openPrivacyPolicyOnPhone(request.privacyPolicyUrl, request.appName)
  }
}

// The glasses store can be installing too; this only stops double taps here.
// ponytail: no lock shared with the glasses store's Update All.
const busy = new Set<string>()
export const isInstalling = (packageId: string) => busy.has(packageId)

/** OPEN launches the installed app; anything else installs. Resolves once done. */
export async function runHubAction(app: EvenHubStoreApp, onStatus: (status: string) => void): Promise<void> {
  if (hubAction(app) === 'OPEN') {
    await getRuntime().controller.launchApp(installedEvenHubAppId(app.packageId))
    return
  }
  if (busy.has(app.packageId)) return
  busy.add(app.packageId)
  try {
    const result = await installStoreApp(app, { appendLog: message => console.log(message), onStatus, confirmPermissions: confirmOnPhone })
    onStatus(result ? '' : 'Installation canceled.')
  } catch (error) {
    onStatus('')
    await Dialogs.alert({ title: error instanceof EvenHubAuthenticationError ? 'Signed Out of Even Hub' : `Could Not Install ${app.name}`,
      message: cleanError(error), okButtonText: 'OK' })
  } finally { busy.delete(app.packageId) }
}

const PALETTE: TileColor[] = ['blue', 'red', 'purple', 'green', 'orange', 'indigo', 'teal', 'gray']
export function paletteFor(id: string): TileColor {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

// Keyed by CDN path; null = undecodable (SVG included: Image cannot draw it), the
// tile keeps its initial. A failed download is forgotten so the next build retries.
const icons = new Map<string, Promise<ImageSource | null>>()
function storeIcon(path: string): Promise<ImageSource | null> {
  let icon = icons.get(path)
  if (!icon) icons.set(path, icon = evenHubApi.downloadPublicAsset(path).then(({ bytes, extension }) => {
    if (extension === 'svg') return null
    const copy = bytes.slice()
    const image = UIImage.imageWithData(NSData.dataWithBytesLength(interop.handleof(copy.buffer), copy.byteLength))
    return image ? new ImageSource(image) : null
  }, () => { icons.delete(path); return null }))
  return icon
}

/** Store artwork on a palette tile, initial first so a missing icon still reads. */
export function artworkTile(app: EvenHubStoreApp, size: number): GridLayout {
  const box = new GridLayout()
  box.className = `os-hub-art os-tile-${paletteFor(app.packageId)}`
  box.width = size; box.height = size; box.borderRadius = Math.round(size * 0.23)
  const initial = new Label()
  initial.text = (app.name.trim()[0] ?? '?').toUpperCase(); initial.className = 'os-hub-initial'
  initial.fontSize = Math.round(size * 0.41)
  box.addChild(initial)
  if (app.iconPath) void storeIcon(app.iconPath).then(icon => {
    if (!icon) return
    const image = new Image()
    image.imageSource = icon
    image.stretch = 'aspectFill'
    initial.visibility = 'collapse'
    box.addChild(image)
  })
  return box
}

export function actionPill(app: EvenHubStoreApp, onTap: () => void): Button {
  const pill = new Button()
  pill.className = 'os-hub-pill'
  pill.text = isInstalling(app.packageId) ? '…' : hubAction(app)
  // An install already running here (from the list or the app page) owns the button.
  pill.on('tap', () => { if (!isInstalling(app.packageId)) onTap() })
  return pill
}

function appRow(app: EvenHubStoreApp, afterAction: () => void): View {
  const grid = new GridLayout()
  grid.columns = 'auto,*,auto'
  grid.className = 'os-hub-row'
  const art = artworkTile(app, 56)
  art.marginRight = 13
  grid.addChild(art)
  const text = new StackLayout()
  text.verticalAlignment = 'middle'
  const name = new Label()
  name.text = app.name; name.className = 'os-hub-name'
  const subtitle = new Label()
  subtitle.className = 'os-row-subtitle'
  const blurb = app.tagline || (app.creatorName ? `by ${app.creatorName}` : '')
  subtitle.text = blurb
  text.addChild(name); text.addChild(subtitle)
  // The text, not the whole row, is the VoiceOver button: an accessible row hides the pill.
  text.accessible = true; text.accessibilityRole = 'button'
  text.accessibilityLabel = blurb ? `${app.name}, ${blurb}` : app.name
  GridLayout.setColumn(text, 1); grid.addChild(text)
  const pill = actionPill(app, () => {
    if (hubAction(app) === 'OPEN') { void runHubAction(app, () => {}); return }
    pill.text = '…'
    void runHubAction(app, status => { subtitle.text = status || blurb }).then(afterAction)
  })
  pill.verticalAlignment = 'middle'
  GridLayout.setColumn(pill, 2); grid.addChild(pill)
  grid.on('tap', () => pushInTab('hub', 'ocusmart/hub-detail', { app }))
  return grid
}

/** The design's storefront list: full-width rows on the page under a 22pt heading. */
function storeList(title: string, rows: View[], footer?: string): StackLayout {
  const box = new StackLayout()
  box.className = 'os-hub-list'
  const heading = new Label()
  heading.text = title; heading.className = 'os-hub-heading'; heading.textWrap = true
  box.addChild(heading)
  for (const row of rows) box.addChild(row)
  if (footer) {
    const note = new Label()
    note.text = footer; note.className = 'os-hub-note'; note.textWrap = true
    box.addChild(note)
  }
  return box
}

/** Email and password in a native alert, then the remember choice. */
async function signIn(): Promise<boolean> {
  const form = await Dialogs.login({ title: 'Sign In to Even Hub', message: 'Use your Even Realities account.',
    userName: evenHubEmailSetting.get(), userNameHint: 'Email', passwordHint: 'Password', okButtonText: 'Next', cancelButtonText: 'Cancel' })
  if (!form.result) return false
  if (!form.userName.trim() || !form.password) {
    await Dialogs.alert({ title: 'Sign In to Even Hub', message: 'Enter your email and password.', okButtonText: 'OK' })
    return false
  }
  const remember = await Dialogs.action({ title: 'Stay signed in?',
    message: `Remember Me keeps the session token on this iPhone. Your password is never stored.`,
    cancelButtonText: 'Cancel', actions: ['Remember Me', 'This Session Only'] })
  if (remember !== 'Remember Me' && remember !== 'This Session Only') return false
  try {
    await evenHubApi.signIn(form.userName, form.password, remember === 'Remember Me')
    return true
  } catch (error) {
    await Dialogs.alert({ title: 'Could Not Sign In', message: cleanError(error), okButtonText: 'OK' })
    return false
  }
}

type Mode = 'top' | 'new' | 'search'
const MODE_HEADERS = { top: 'Top Apps', new: 'New Apps' }
const STORAGE_FOOTER = `Even Hub uses your Even Realities account. Your password goes only to Even Realities and is never stored. `
  + `With Remember Me, the session token is kept in ${APP_NAME}'s app settings on this iPhone (not the Keychain); `
  + `otherwise it stays in memory until ${APP_NAME} quits or the Even Hub window on the glasses closes.`

export function createPage(): Page {
  const listings: Record<Mode, Listing> = { top: emptyListing(), new: emptyListing(), search: emptyListing() }
  const errors: Record<Mode, string> = { top: '', new: '', search: '' }
  // Mode → the search epoch its request was sent under (0 outside search). Each
  // submit bumps the epoch, so a new search goes out at once and stale replies drop.
  const loading = new Map<Mode, number>()
  let searchEpoch = 0
  let mode: Mode = 'top', browseMode: Exclude<Mode, 'search'> = 'top', query = ''
  let updates: EvenHubStoreApp[] = [], updatesChecked = false
  let shown = ''
  const shownKey = () => `${hasEvenHubCredentials()}\n${getInstalledEvenHubFingerprint()}`

  const search = new SearchBar()
  search.hint = 'Search Even Hub'; search.className = 'os-hub-search'
  // The default style paints a gray bar over the grouped background.
  search.on('loaded', () => { (search.ios as UISearchBar).searchBarStyle = UISearchBarStyle.Minimal })
  search.on('submit', () => {
    search.dismissSoftInput()
    const text = search.text?.trim() ?? ''
    if (!text) { mode = browseMode; refresh(); return }
    query = text; mode = 'search'; listings.search = emptyListing(); errors.search = ''; searchEpoch++
    void loadMore('search')
  })
  search.on('clear', () => { query = ''; mode = browseMode; refresh() })
  const tabs = new SegmentedBar()
  tabs.className = 'os-hub-segments'
  tabs.items = (['Top', 'New']).map(title => { const item = new SegmentedBarItem(); item.title = title; return item })
  tabs.on('selectedIndexChange', () => {
    browseMode = tabs.selectedIndex === 1 ? 'new' : 'top'
    if (mode === 'search') return
    mode = browseMode
    if (!listings[mode].apps.length && !errors[mode]) void loadMore(mode)
    else refresh()
  })

  // The list and the update check fail together on an expired session; say it once.
  let alerting = false
  const signedOut = async (error: unknown) => {
    for (const key of Object.keys(listings) as Mode[]) { listings[key] = emptyListing(); errors[key] = '' }
    updates = []; updatesChecked = false
    refresh()
    if (alerting) return
    alerting = true
    try { await Dialogs.alert({ title: 'Signed Out of Even Hub', message: cleanError(error), okButtonText: 'OK' }) } finally { alerting = false }
  }

  async function loadMore(which: Mode): Promise<void> {
    const asked = which === 'search' ? searchEpoch : 0
    if (loading.get(which) === asked || listings[which].exhausted) return
    loading.set(which, asked); errors[which] = ''
    refresh()
    // A newer search replaced this one while it was in flight; that one redraws.
    const stale = () => which === 'search' && asked !== searchEpoch
    try {
      const listing = listings[which]
      const page = which === 'new' ? await evenHubApi.listNewApps(listing.nextPage)
        : which === 'search' ? await evenHubApi.searchApps(query, listing.nextPage)
          : await evenHubApi.listApps(listing.nextPage)
      if (stale()) return
      listings[which] = mergePage(listing, page)
    } catch (error) {
      if (stale()) return
      if (error instanceof EvenHubAuthenticationError) { loading.delete(which); await signedOut(error); return }
      errors[which] = cleanError(error)
    } finally { if (loading.get(which) === asked) loading.delete(which) }
    refresh()
  }

  async function checkUpdates(): Promise<void> {
    updatesChecked = true
    try {
      updates = (await checkForEvenHubUpdates()).flatMap(update => update.latest ? [update.latest] : [])
      if (updates.length) refresh()
    } catch (error) {
      if (error instanceof EvenHubAuthenticationError) await signedOut(error)
    }
  }

  const { page, refresh } = groupedPage({ title: 'Hub', build: container => {
    shown = shownKey()
    const signedIn = hasEvenHubCredentials()
    search.visibility = signedIn ? 'visible' : 'collapse'
    tabs.visibility = signedIn && mode !== 'search' ? 'visible' : 'collapse'
    if (!signedIn) {
      container.addChild(section({ header: 'Even Hub',
        footer: `Even Hub is Even Realities' store of apps for G2. Sign in to browse, install and update them here; they run in ${APP_NAME} and show on your glasses.`,
        rows: [buttonRow({ title: 'Sign In to Even Hub', onTap: () => { void signIn().then(ok => { if (ok) { mode = browseMode; sync() } }) } })] }))
      container.addChild(section({ footer: STORAGE_FOOTER, rows: [] }))
      return
    }
    if (mode !== 'search' && updates.length) {
      container.addChild(storeList('Updates', updates.map(app => appRow(app, () => {
        updates = updates.filter(entry => hubAction(entry) !== 'OPEN'); refresh()
      }))))
    }
    const listing = listings[mode], rows = listing.apps.map(app => appRow(app, () => refresh()))
    if (loading.has(mode)) rows.push(buttonRow({ title: 'Loading…', enabled: false, onTap: () => {} }).view)
    else if (errors[mode]) rows.push(buttonRow({ title: 'Try Again', onTap: () => { void loadMore(mode) } }).view)
    else if (!listing.exhausted && listing.apps.length) rows.push(buttonRow({ title: 'Load More', onTap: () => { void loadMore(mode) } }).view)
    const empty = !loading.has(mode) && !errors[mode] && listing.exhausted && !listing.apps.length
    container.addChild(storeList(mode === 'search' ? `Results for “${query}”` : MODE_HEADERS[mode], rows,
      errors[mode] || (empty ? (mode === 'search' ? 'No apps match.' : 'Even Hub returned no apps.') : undefined)))
    const email = evenHubEmailSetting.get()
    container.addChild(section({ header: 'Account', footer: STORAGE_FOOTER, rows: [
      ...(email ? [valueRow({ title: 'Signed In As', value: email })] : []),
      buttonRow({ title: 'Sign Out', role: 'destructive', onTap: () => {
        clearEvenHubSession()
        for (const key of Object.keys(listings) as Mode[]) { listings[key] = emptyListing(); errors[key] = '' }
        updates = []; updatesChecked = false
        refresh()
      } }),
    ] }))
  } })
  page.className = 'os-page os-hub-page'
  // A rebuild tears down every native view it removes, which would close the
  // keyboard mid-typing; the search field and segments sit above the rebuilt body.
  const scroll = page.content as ScrollView, body = scroll.content
  const top = new StackLayout()
  scroll.content = top
  top.addChild(search); top.addChild(tabs); top.addChild(body)

  let off: (() => void) | null = null
  const sync = () => {
    if (shownKey() !== shown) refresh()
    if (!hasEvenHubCredentials()) return
    if (!listings[mode].apps.length && !errors[mode] && !loading.has(mode) && mode !== 'search') void loadMore(mode)
    if (!updatesChecked) void checkUpdates()
  }
  page.on('loaded', () => {
    off?.()
    // Sign-in and installs from the glasses land in the settings store too.
    off = onSettingsStoreChanged(() => { if (shownKey() !== shown) refresh() })
    sync()
  })
  page.on('navigatedTo', sync)
  page.on('unloaded', () => { off?.(); off = null })
  return page
}
