import { ActionItem, Application, Dialogs, Frame, Label, StackLayout, Utils, type Page } from '@nativescript/core'
import { groupedPage, section, buttonRow, customRow } from './ui-kit'
import { presentOnTop } from './present'
import { clearErrorReports, listErrorReports, onErrorReport, type ErrorReport } from '../../native/error-reports'
import { APP_NAME } from '../../branding'

const when = (at: string) => { const date = new Date(at); return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` }
const reportKey = (report: ErrorReport) => `${report.source}\n${report.message}`

/** Everything a report holds, for Copy and Share: the owner pastes it into a bug. */
export function errorReportsText(reports: ErrorReport[]): string {
  return [`${APP_NAME} error reports (${reports.length})`, ...reports.map(report => [
    `--- ${report.at} ${report.source} x${report.count} (${report.platform} ${report.build})`,
    report.message,
    ...Object.entries(report.context ?? {}).map(([key, value]) => `${key}: ${value}`),
    report.stack,
  ].join('\n'))].join('\n\n')
}

function label(text: string, className: string): Label {
  const view = new Label()
  view.text = text; view.className = className; view.textWrap = true
  return view
}

/** Settings > General > Error Reports, and the sheet the notice opens (`modal`: with Done). */
export function createPage(modal = false): Page {
  const expanded = new Set<string>()
  const { page, refresh } = groupedPage({ title: 'Error Reports', largeTitle: false, build: container => {
    const reports = listErrorReports()
    container.addChild(section({ rows: reports.map(report => {
      const row = new StackLayout()
      row.className = 'os-row os-error-row'
      row.accessible = true; row.accessibilityRole = 'button'
      row.accessibilityLabel = `${report.source}: ${report.message}`
      row.addChild(label(report.source, 'os-row-title'))
      row.addChild(label(report.message, 'os-row-subtitle'))
      row.addChild(label(`${when(report.at)}${report.count > 1 ? ` · ${report.count} times` : ''} · ${report.build}`, 'os-row-subtitle'))
      const key = reportKey(report)
      if (expanded.has(key)) row.addChild(label(report.stack || '(no stack)', 'os-error-stack'))
      row.on('tap', () => { if (!expanded.delete(key)) expanded.add(key); refresh() })
      return customRow(row)
    }), footer: reports.length
      ? `Errors ${APP_NAME} caught and recovered from, newest first. Tap one for its stack.`
      : `${APP_NAME} has not caught any errors.` }))
    if (!reports.length) return
    container.addChild(section({ rows: [
      buttonRow({ title: 'Copy Reports', onTap: () => { UIPasteboard.generalPasteboard.string = errorReportsText(listErrorReports()) } }),
      buttonRow({ title: 'Share Reports', onTap: () => {
        const sheet = UIActivityViewController.alloc().initWithActivityItemsApplicationActivities([errorReportsText(listErrorReports())], null)
        // A popover (regular width) needs an anchor.
        if (sheet.popoverPresentationController) sheet.popoverPresentationController.sourceView = page.ios.view
        presentOnTop(sheet)
      } }),
    ] }))
    container.addChild(section({ rows: [buttonRow({ title: 'Clear Error Reports', role: 'destructive', onTap: () => { void confirmClear() } })] }))
  } })
  const confirmClear = async () => {
    if (!await Dialogs.confirm({ title: 'Clear Error Reports?', message: 'This deletes every saved error report.', okButtonText: 'Clear', cancelButtonText: 'Cancel' })) return
    clearErrorReports()
    refresh()
  }
  if (modal) {
    const done = new ActionItem()
    done.text = 'Done'; done.ios.position = 'right'
    done.on('tap', () => page.closeModal())
    page.actionBar.actionItems.addItem(done)
  }
  let off: (() => void) | null = null
  // New reports only: a repeat can come every frame, and its count shows on the next visit.
  page.on('loaded', () => { off?.(); off = onErrorReport((_report, isNew) => { if (isNew) refresh() }); refresh() })
  page.on('unloaded', () => { off?.(); off = null })
  return page
}

/**
 * The list as a sheet over the top NativeScript page (the shell, a detour or onboarding).
 * False when that page refused: a UIKit controller (an alert, a share sheet) is up on it.
 */
export function presentErrorReports(): boolean {
  const host = Frame.topmost()?.currentPage
  if (!host) return false
  const frame = new Frame()
  frame.navigate({ create: () => createPage(true) })
  host.showModal(frame, { fullscreen: false, closeCallback: () => {} })
  // NativeScript only traces a refused presentation.
  return host.modal === frame
}

const NOTICE_SECONDS = 6
let notice: { button: UIButton; count: number; timer: ReturnType<typeof setTimeout> | null } | null = null
/** New errors nobody has been told about yet: no window yet, or the app is not in front. */
let pending: { source: string; count: number } | null = null

/** Once at startup: the first time each distinct error is caught in a session, say so. */
export function installErrorNotice(): void {
  onErrorReport((report, isNew) => {
    if (!isNew) return
    pending = { source: report.source, count: (pending?.count ?? 0) + 1 }
    // Out of the catch block that reported it, which may be mid-layout.
    setTimeout(() => showPendingNotice(), 0)
  })
  // Every activation, the first included; applicationState may still read Inactive inside it.
  Application.on(Application.resumeEvent, () => showPendingNotice(true))
  // The banner only counts down while someone can see it.
  Application.on(Application.suspendEvent, () => { if (notice?.timer) { clearTimeout(notice.timer); notice.timer = null } })
}

function showPendingNotice(active = UIApplication.sharedApplication.applicationState === UIApplicationState.Active): void {
  const window = Utils.getWindow<UIWindow>()
  if (!window || !active) return // Kept pending until resumeEvent.
  if (pending) { updateNotice(window, pending.source, pending.count); pending = null }
  if (!notice) return
  if (notice.timer) clearTimeout(notice.timer)
  notice.timer = setTimeout(hideNotice, NOTICE_SECONDS * 1000)
}

/** A tappable banner over the window's top, not an alert: it must never block. One at a time; a burst counts up. */
function updateNotice(window: UIWindow, source: string, count: number): void {
  if (!notice) {
    // Kept when the sheet could not open, so the tap can be tried again.
    const button = UIButton.buttonWithTypePrimaryAction(UIButtonType.System, UIAction.actionWithHandler(() => { if (presentErrorReports()) hideNotice() }))
    button.translatesAutoresizingMaskIntoConstraints = false
    window.addSubview(button)
    const guide = window.safeAreaLayoutGuide
    NSLayoutConstraint.activateConstraints([
      button.topAnchor.constraintEqualToAnchorConstant(guide.topAnchor, 8),
      button.leadingAnchor.constraintEqualToAnchorConstant(guide.leadingAnchor, 16),
      button.trailingAnchor.constraintEqualToAnchorConstant(guide.trailingAnchor, -16),
    ])
    notice = { button, count: 0, timer: null }
  }
  notice.count += count
  const text = notice.count === 1 ? `${APP_NAME} caught an error in ${source}. Tap to view.`
    : `${APP_NAME} caught ${notice.count} errors, the latest in ${source}. Tap to view.`
  const config = UIButtonConfiguration.filledButtonConfiguration()
  config.title = text
  config.baseBackgroundColor = UIColor.systemRedColor
  config.cornerStyle = UIButtonConfigurationCornerStyle.Large
  notice.button.configuration = config
  notice.button.accessibilityLabel = text
  // Above a detour or sheet presented since the banner went up.
  window.bringSubviewToFront(notice.button)
  UIAccessibilityPostNotification(UIAccessibilityAnnouncementNotification, text)
}

function hideNotice(): void {
  if (!notice) return
  if (notice.timer) clearTimeout(notice.timer)
  notice.button.removeFromSuperview()
  notice = null
}
