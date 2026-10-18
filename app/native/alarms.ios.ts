import { Application, ApplicationSettings, Utils } from '@nativescript/core'
import { APP_NAME } from '../branding'
import type { AlarmKind, AlarmReliabilityIssue, PhoneAlarmAction } from './alarms'
import { guardCallback, logJsError } from './callback-errors.ios'
import { kotlinListener } from './kotlin-listener.ios'
export type { AlarmKind, AlarmReliabilityIssue, PhoneAlarmAction } from './alarms'

// Local notifications stand in for Android's alarm service. Nothing runs at fire time while
// the app is suspended, so the escalation is pre-scheduled: 'fc-<id>' at T (silent while the
// glasses can carry it) and 'fc-<id>-esc' with sound at T+5s, moved to +30s once the glasses show it.
// With AlarmKit (iOS 26+, authorized) the sounding stage is a real alarm that breaks through Silent
// and Focus instead; it is loud at once, so 'fc-<id>' stays the silent record either way.
// kit = the fire time of an AlarmKit alarm AlarmKit confirmed.
type Entry = { id: number; at: number; title: string; text: string; kind: AlarmKind; snooze: number; kit?: number }
const ENTRIES_KEY = 'alarms.ios.entries'
const JOURNAL_KEY = 'alarms.ios.journal'
const CATEGORY = 'fc-alarm'
const DELIVERY_WAIT_MS = 5_000
const ACK_WAIT_S = 30
const STATUS_MAX_AGE_MS = 3 * 60_000

const center = () => UNUserNotificationCenter.currentNotificationCenter()
const ids = (id: number) => [`fc-${id}`, `fc-${id}-esc`]
function readJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(ApplicationSettings.getString(key, '')) ?? fallback } catch { return fallback }
}
const entries = () => readJson<Record<string, Entry>>(ENTRIES_KEY, {})
function saveEntry(id: number, entry: Entry | null): void {
  const all = entries()
  if (entry) all[id] = entry
  else delete all[id]
  ApplicationSettings.setString(ENTRIES_KEY, JSON.stringify(all))
}

// TS mirror of the Kotlin GlassesStatusGate.
let glasses = { connected: false, worn: false, charging: false, at: 0 }
const canCarry = () => glasses.at > 0 && Date.now() - glasses.at <= STATUS_MAX_AGE_MS && glasses.connected && glasses.worn && !glasses.charging

function post(identifier: string, entry: Entry, sound: boolean, trigger: UNNotificationTrigger): void {
  const content = UNMutableNotificationContent.new()
  content.title = entry.title
  content.body = entry.text
  content.categoryIdentifier = CATEGORY
  // TimeSensitive needs an entitlement a sideloaded build lacks; iOS then treats it as Active.
  content.interruptionLevel = sound ? UNNotificationInterruptionLevel.TimeSensitive : UNNotificationInterruptionLevel.Passive
  if (sound) content.sound = UNNotificationSound.defaultSound
  center().addNotificationRequestWithCompletionHandler(UNNotificationRequest.requestWithIdentifierContentTrigger(identifier, content, trigger), null as never) // types-ios drops a nullable block's parens
}
function at(ms: number): UNNotificationTrigger {
  if (ms - Date.now() < 1_000) return UNTimeIntervalNotificationTrigger.triggerWithTimeIntervalRepeats(1, false)
  const units = NSCalendarUnit.CalendarUnitYear | NSCalendarUnit.CalendarUnitMonth | NSCalendarUnit.CalendarUnitDay |
    NSCalendarUnit.CalendarUnitHour | NSCalendarUnit.CalendarUnitMinute | NSCalendarUnit.CalendarUnitSecond
  // Calendar components drop milliseconds: round up so the phone never fires early.
  return UNCalendarNotificationTrigger.triggerWithDateMatchingComponentsRepeats(NSCalendar.currentCalendar.componentsFromDate(units, new Date(Math.ceil(ms / 1000) * 1000)), false)
}
function arm(entry: Entry): void {
  const [main, esc] = ids(entry.id)
  saveEntry(entry.id, entry)
  const carry = canCarry(), useKit = kitReady()
  post(main, entry, !carry && !useKit, at(entry.at))
  if (carry || useKit) escalate(entry, entry.at + (carry ? DELIVERY_WAIT_MS : 0))
  else {
    center().removePendingNotificationRequestsWithIdentifiers([esc])
    cancelKit(entry.id)
  }
}
function escalate(entry: Entry, atMs: number, trigger = at(atMs)): void {
  const esc = ids(entry.id)[1]!
  cancelKit(entry.id)
  if (!kitReady()) return post(esc, entry, true, trigger)
  center().removePendingNotificationRequestsWithIdentifiers([esc])
  const fireAt = Math.max(atMs, Date.now() + 1_000)
  kitPending.set(entry.id, fireAt)
  FaceclawAlarmKit.scheduleAlarmAtMsTitleCompletion(kitId(entry.id), fireAt, entry.title, (error: string | null) => {
    if (kitPending.get(entry.id) !== fireAt) return
    kitPending.delete(entry.id)
    const current = entries()[entry.id]
    if (!current) return
    if (!error) return saveEntry(entry.id, { ...current, kit: fireAt })
    console.warn(`AlarmKit could not schedule ${entry.id}: ${error}`)
    post(esc, current, true, at(fireAt))
  })
}
function clear(id: number): void {
  center().removePendingNotificationRequestsWithIdentifiers(ids(id))
  center().removeDeliveredNotificationsWithIdentifiers(ids(id))
  cancelKit(id)
}
function rearm(): void {
  kitWasReady = kitReady()
  for (const entry of Object.values(entries())) if (entry.at > Date.now()) arm(entry)
}

// AlarmKit, through FaceclawAlarmKit.swift. Item ids are below 2^48, so they fit the UUID's last group.
const hasKit = (): boolean => typeof FaceclawAlarmKit !== 'undefined' && FaceclawAlarmKit.isAvailable()
const kitState = (): number => (hasKit() ? Number(FaceclawAlarmKit.authorizationState()) : -1)
const kitReady = () => kitState() === 2
const kitId = (id: number) => `00000000-0000-4000-8000-${id.toString(16).padStart(12, '0')}`
const kitPending = new Map<number, number>()
function cancelKit(id: number): void {
  if (!hasKit()) return
  kitPending.delete(id)
  FaceclawAlarmKit.cancelAlarm(kitId(id))
  const entry = entries()[id]
  if (entry?.kit !== undefined) saveEntry(id, { ...entry, kit: undefined })
}
// AlarmKit drops a one-shot alarm once it has fired and been stopped, and our alarms have no other
// button, so a confirmed alarm missing after its fire time was stopped on the phone.
// ponytail: an alarm the system dropped for another reason also reads as a dismiss.
function reconcileKit(present: string): void {
  for (const entry of Object.values(entries())) {
    if (entry.kit !== undefined && entry.kit <= Date.now() && !present.includes(kitId(entry.id))) handleResponse(`fc-${entry.id}`, 'dismiss')
  }
}
function requestKitPermission(): Promise<void> {
  return new Promise(resolve => FaceclawAlarmKit.requestAuthorization((state: number) => {
    if (state === 2) rearm()
    resolve()
  }))
}
// Authorization can change in Settings while the app is away; arm() picks the tier.
let kitWasReady = false
function onResume(): void {
  if (!hasKit()) return
  reconcileKit(String(FaceclawAlarmKit.alarmIds()))
  if (kitReady() !== kitWasReady) rearm()
}

// UNNotificationSettings, cached: the query is async, and callers need an answer now.
let settings: { status: UNAuthorizationStatus; alerts: UNNotificationSetting; timeSensitive: UNNotificationSetting } | null = null
function refreshSettings(): Promise<void> {
  return new Promise(resolve => center().getNotificationSettingsWithCompletionHandler(value => {
    settings = { status: value.authorizationStatus, alerts: value.alertSetting, timeSensitive: value.timeSensitiveSetting }
    Utils.executeOnMainThread(resolve)
  }))
}
let askedThisLaunch = false
function askOnceInForeground(): void {
  const askAlerts = settings === null || settings.status === UNAuthorizationStatus.NotDetermined
  if (askedThisLaunch || (!askAlerts && kitState() !== 0)) return
  if (UIApplication.sharedApplication.applicationState !== UIApplicationState.Active) return
  askedThisLaunch = true
  void (askAlerts ? requestPhoneAlertPermission() : requestKitPermission())
}

export function hasPhoneAlertPermission(): boolean {
  return settings !== null && settings.status >= UNAuthorizationStatus.Authorized
}
export const refreshPhoneAlertPermission = refreshSettings
/** Ask for alerts; iOS asks only once, so a denied state opens the app's Settings page instead. */
export function requestPhoneAlertPermission(): Promise<boolean> {
  if (settings?.status === UNAuthorizationStatus.Denied) {
    Utils.openUrl('app-settings:')
    return Promise.resolve(false)
  }
  return new Promise<boolean>(resolve => center().requestAuthorizationWithOptionsCompletionHandler(
    UNAuthorizationOptions.Alert | UNAuthorizationOptions.Sound | UNAuthorizationOptions.Badge,
    granted => { void refreshSettings().then(() => resolve(Boolean(granted))) }))
    // One system prompt at a time: AlarmKit's follows the notification one.
    .then(granted => (kitState() === 0 ? requestKitPermission() : Promise.resolve()).then(() => granted))
}

const actionListeners = new Set<(action: PhoneAlarmAction) => void>()
function handleResponse(identifier: string, action: string): void {
  const id = Number(/^fc-(-?\d+)/.exec(identifier)?.[1])
  if (!Number.isFinite(id) || (action !== 'dismiss' && action !== 'snooze')) return
  const entry = entries()[id]
  const event: PhoneAlarmAction = { id, action, minutes: action === 'snooze' ? entry?.snooze ?? 10 : 0, atMs: Date.now() }
  ApplicationSettings.setString(JOURNAL_KEY, JSON.stringify([...readJson<unknown[]>(JOURNAL_KEY, []), { id, action, minutes: event.minutes, at: event.atMs }]))
  clear(id)
  // Re-armed here so a snooze rings even if the engine never runs before it is due.
  if (action === 'snooze' && entry) arm({ ...entry, at: event.atMs + event.minutes * 60_000 })
  else saveEntry(id, null)
  for (const listener of [...actionListeners]) {
    try { listener(event) } catch (error) { logJsError('phone alarm action listener', error) }
  }
}

// UNUserNotificationCenter.delegate is weak: this module keeps the only strong reference.
let delegate: UNUserNotificationCenterDelegate | null = null

/** Install before Application.run, so an action tapped on a cold background launch is not lost. */
export function installPhoneAlarmDelegate(): void {
  if (delegate) return
  // An inline literal, not a class or a named object: only a fresh literal gets tsc's check against misspelled
  // optional delegate methods (see kotlinListener). Bodies under guardCallback (a throw into UIKit ends the app);
  // iOS still gets its completion call.
  delegate = kotlinListener(UNUserNotificationCenterDelegate, {
    userNotificationCenterWillPresentNotificationWithCompletionHandler(_center: UNUserNotificationCenter, notification: UNNotification, done: (options: UNNotificationPresentationOptions) => void): void {
      const loud = UNNotificationPresentationOptions.Banner | UNNotificationPresentationOptions.Sound | UNNotificationPresentationOptions.List
      const options = guardCallback('userNotificationCenterWillPresentNotification', () => notification.request.content.sound ? loud : UNNotificationPresentationOptions.List)
      done(options ?? loud)
    },
    userNotificationCenterDidReceiveNotificationResponseWithCompletionHandler(_center: UNUserNotificationCenter, response: UNNotificationResponse, done: () => void): void {
      guardCallback('userNotificationCenterDidReceiveNotificationResponse', () => handleResponse(String(response.notification.request.identifier), String(response.actionIdentifier)))
      done()
    },
  })
  center().delegate = delegate
  // No customDismissAction: a swipe-away must not count as a dismiss. The *OptionNone names are
  // header static consts with no exported symbol, so pass 0 rather than trust the runtime to resolve them.
  center().setNotificationCategories(NSSet.setWithArray([UNNotificationCategory.categoryWithIdentifierActionsIntentIdentifiersOptions(CATEGORY, [
    UNNotificationAction.actionWithIdentifierTitleOptions('snooze', 'Snooze', 0 as UNNotificationActionOptions),
    UNNotificationAction.actionWithIdentifierTitleOptions('dismiss', 'Dismiss', UNNotificationActionOptions.Destructive),
  ], [], 0 as UNNotificationCategoryOptions)]))
  void refreshSettings()
  kitWasReady = kitReady()
  if (hasKit()) FaceclawAlarmKit.observeAlarms((present: string) => reconcileKit(String(present)))
  Application.on(Application.resumeEvent, onResume)
}

// ponytail: 2 requests per item against iOS's 64 pending; past 32 armed items the latest are dropped.
export function schedulePhoneAlarm(itemId: number, triggerAtMs: number, title: string, text: string, kind: AlarmKind, snoozeMinutes: number): void {
  askOnceInForeground()
  arm({ id: itemId, at: triggerAtMs, title, text, kind, snooze: snoozeMinutes })
}
export function cancelPhoneAlarm(itemId: number): void {
  clear(itemId)
  saveEntry(itemId, null)
}
export function ringPhoneAlarm(itemId: number, title: string, text: string, kind: AlarmKind, snoozeMinutes: number): void {
  arm({ id: itemId, at: Date.now(), title, text, kind, snooze: snoozeMinutes })
}
export function phoneAlarmDeliveredToGlasses(itemId: number): void {
  const entry = entries()[itemId]
  if (entry) escalate(entry, Date.now() + ACK_WAIT_S * 1000, UNTimeIntervalNotificationTrigger.triggerWithTimeIntervalRepeats(ACK_WAIT_S, false))
}
export const acknowledgePhoneAlarm = cancelPhoneAlarm
export function setPhoneAlarmGlassesStatus(connected: boolean, worn: boolean, charging: boolean): void {
  const before = canCarry()
  glasses = { connected, worn, charging, at: Date.now() }
  if (canCarry() === before) return
  rearm()
}
export function onPhoneAlarmAction(listener: (action: PhoneAlarmAction) => void): () => void {
  actionListeners.add(listener)
  return () => { actionListeners.delete(listener) }
}
export function drainPhoneAlarmJournal(): PhoneAlarmAction[] {
  if (hasKit()) reconcileKit(String(FaceclawAlarmKit.alarmIds()))
  const journal = readJson<any[]>(JOURNAL_KEY, [])
  ApplicationSettings.setString(JOURNAL_KEY, '[]')
  return (Array.isArray(journal) ? journal : [])
    .filter(entry => entry && Number.isFinite(Number(entry.id)))
    .map(entry => ({ id: Number(entry.id), action: entry.action === 'snooze' ? 'snooze' : 'dismiss', minutes: Number(entry.minutes) || 0, atMs: Number(entry.at) || 0 }))
}
export function checkPhoneAlarmReliability(): AlarmReliabilityIssue[] {
  void refreshSettings()
  const issues: AlarmReliabilityIssue[] = []
  if (settings && (settings.status < UNAuthorizationStatus.Authorized || settings.alerts === UNNotificationSetting.Disabled)) {
    issues.push({ code: 'ios-notifications', message: `Notifications are not allowed for ${APP_NAME}, so the phone cannot alert.`, fixable: true })
  }
  // An AlarmKit alarm rings through Silent and Focus; below iOS 26 or without it, alerts are notifications.
  if (kitReady()) return issues
  if (hasKit()) issues.push({ code: 'ios-alarmkit', message: `Alarms are not allowed for ${APP_NAME}, so phone alerts follow Silent and Focus.`, fixable: true })
  if (settings?.timeSensitive === UNNotificationSetting.Disabled) {
    issues.push({ code: 'ios-time-sensitive', message: 'Time Sensitive notifications are off, so Focus can hold phone alerts.', fixable: true })
  }
  issues.push({ code: 'ios-silent', message: 'Phone alerts are one short sound that follows the Ring/Silent switch and Focus.', fixable: false })
  return issues
}
export function openPhoneAlarmReliabilityFix(code: string): void {
  if (code === 'ios-notifications' && settings?.status === UNAuthorizationStatus.NotDetermined) void requestPhoneAlertPermission()
  else if (code === 'ios-alarmkit' && kitState() === 0) void requestKitPermission()
  else Utils.openUrl('app-settings:')
}
export function readPhoneAlarmLog(): string { return '' }
