const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function load(file, context = {}) {
  const sandbox = { exports: {}, console, Promise, ...context };
  vm.runInNewContext(ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
  }).outputText, sandbox);
  return sandbox.exports;
}
// Values built inside the sandbox are another realm's arrays and objects.
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const tick = () => new Promise(resolve => setImmediate(resolve));

const T = 1_800_000_000_000;
// FaceclawAlarmKit.swift runs its calls one at a time in call order; settle() is that queue draining.
function fakeKit({ state = 2, fail = null } = {}) {
  const ops = [];
  const kit = {
    state, scheduled: new Map(), calls: [], observer: null,
    isAvailable: () => true,
    authorizationState: () => kit.state,
    requestAuthorization(done) { kit.calls.push(['auth']); ops.push(() => { kit.state = 2; done(2); }); },
    scheduleAlarmAtMsTitleCompletion(id, atMs, title, done) {
      kit.calls.push(['schedule', id, atMs, title]);
      ops.push(() => { if (!fail) kit.scheduled.set(id, atMs); done(fail); });
    },
    cancelAlarm(id) { kit.calls.push(['cancel', id]); ops.push(() => kit.scheduled.delete(id)); },
    alarmIds: () => [...kit.scheduled.keys()].join(','),
    observeAlarms(handler) { kit.observer = handler; },
    settle() { while (ops.length) ops.shift()(); },
    schedules: () => kit.calls.filter(call => call[0] === 'schedule').map(call => call.slice(1)),
  };
  return kit;
}
const KIT7 = '00000000-0000-4000-8000-000000000007';

function alarms({ status = 2, alertSetting = 2, timeSensitive = 0, active = true, kit } = {}) {
  const clock = { now: T - 60_000 };
  const pending = new Map(), removedDelivered = [], opened = [], authRequests = [], store = new Map(), reports = [];
  const callbackErrors = load('app/native/callback-errors.ios.ts', { require: () => ({ reportError: (source, error) => reports.push([source, String(error?.message ?? error)]) }) });
  const settings = { authorizationStatus: status, alertSetting, timeSensitiveSetting: timeSensitive };
  const resume = [];
  const center = {
    delegate: null, categories: null,
    addNotificationRequestWithCompletionHandler(request) { pending.set(request.identifier, request); },
    removePendingNotificationRequestsWithIdentifiers(ids) { for (const id of ids) pending.delete(id); },
    removeDeliveredNotificationsWithIdentifiers(ids) { removedDelivered.push(...ids); },
    getNotificationSettingsWithCompletionHandler(done) { done(settings); },
    requestAuthorizationWithOptionsCompletionHandler(options, done) { authRequests.push(options); settings.authorizationStatus = 2; done(true, null); },
    setNotificationCategories(set) { this.categories = set; },
  };
  class FakeDate extends Date { static now() { return clock.now; } }
  const module = load('app/native/alarms.ios.ts', {
    Date: FakeDate,
    ...(kit ? { FaceclawAlarmKit: kit } : {}),
    require: name => ({
      '@nativescript/core': {
        Application: { resumeEvent: 'resume', on: (event, handler) => { if (event === 'resume') resume.push(handler); } },
        ApplicationSettings: { getString: (key, fallback) => store.get(key) ?? fallback, setString: (key, value) => store.set(key, value) },
        Utils: { openUrl: url => opened.push(url), executeOnMainThread: fn => fn() },
      },
      '../branding': { APP_NAME: 'OcuSmart' },
      './callback-errors.ios': callbackErrors,
    })[name],
    NativeClass: () => c => c,
    NSObject: class { static new() { return new this(); } },
    NSSet: { setWithArray: items => items },
    NSCalendar: { currentCalendar: { componentsFromDate: (_units, date) => date } },
    NSCalendarUnit: { CalendarUnitYear: 4, CalendarUnitMonth: 8, CalendarUnitDay: 16, CalendarUnitHour: 32, CalendarUnitMinute: 64, CalendarUnitSecond: 128 },
    UIApplication: { sharedApplication: { get applicationState() { return active ? 0 : 2; } } },
    UIApplicationState: { Active: 0 },
    UNUserNotificationCenter: { currentNotificationCenter: () => center },
    UNUserNotificationCenterDelegate: {},
    UNMutableNotificationContent: { new: () => ({}) },
    UNNotificationSound: { defaultSound: 'default' },
    UNNotificationRequest: { requestWithIdentifierContentTrigger: (identifier, content, trigger) => ({ identifier, content, trigger }) },
    UNCalendarNotificationTrigger: { triggerWithDateMatchingComponentsRepeats: components => ({ atMs: components.getTime() }) },
    UNTimeIntervalNotificationTrigger: { triggerWithTimeIntervalRepeats: seconds => ({ seconds }) },
    UNNotificationAction: { actionWithIdentifierTitleOptions: (identifier, title, options) => ({ identifier, title, options }) },
    UNNotificationCategory: { categoryWithIdentifierActionsIntentIdentifiersOptions: (identifier, actions) => ({ identifier, actions }) },
    UNNotificationActionOptions: { Destructive: 2 }, UNNotificationActionOptionNone: 0, UNNotificationCategoryOptionNone: 0,
    UNNotificationInterruptionLevel: { Passive: 0, Active: 1, TimeSensitive: 2 },
    UNNotificationPresentationOptions: { Sound: 2, List: 8, Banner: 16 },
    UNAuthorizationOptions: { Badge: 1, Sound: 2, Alert: 4 },
    UNAuthorizationStatus: { NotDetermined: 0, Denied: 1, Authorized: 2 },
    UNNotificationSetting: { NotSupported: 0, Disabled: 1, Enabled: 2 },
  });
  module.installPhoneAlarmDelegate();
  const respond = (identifier, actionIdentifier) => {
    let completed = false;
    center.delegate.userNotificationCenterDidReceiveNotificationResponseWithCompletionHandler(center,
      { actionIdentifier, notification: { request: { identifier } } }, () => { completed = true; });
    return completed;
  };
  return { module, clock, pending, removedDelivered, opened, authRequests, center, settings, respond, reports, store, resume: () => resume.forEach(fn => fn()) };
}

test('iOS alarm: silent at T plus a sounding escalation at T+5s while the glasses can carry it', () => {
  const { module, pending, center } = alarms();
  assert.ok(center.delegate, 'the delegate is installed and kept by the module');
  same(center.categories[0].actions.map(a => a.identifier), ['snooze', 'dismiss']);
  module.setPhoneAlarmGlassesStatus(true, true, false);
  module.schedulePhoneAlarm(7, T + 400, 'Alarm', '7:00', 'alarm', 10);
  same([...pending.keys()], ['fc-7', 'fc-7-esc']);
  const main = pending.get('fc-7'), esc = pending.get('fc-7-esc');
  same(main.trigger, { atMs: T + 1000 }, 'rounded up to the whole second, never early');
  assert.equal(main.content.sound, undefined);
  assert.equal(main.content.interruptionLevel, 0);
  assert.equal(main.content.categoryIdentifier, 'fc-alarm');
  same([main.content.title, main.content.body], ['Alarm', '7:00']);
  same(esc.trigger, { atMs: T + 6000 });
  assert.equal(esc.content.sound, 'default');
  assert.equal(esc.content.interruptionLevel, 2);
});

test('iOS alarm: one sounding request when the glasses cannot carry it; a flip re-arms', () => {
  const { module, pending, clock } = alarms();
  module.schedulePhoneAlarm(7, T, 'Alarm', '7:00', 'alarm', 10);
  same([...pending.keys()], ['fc-7']);
  assert.equal(pending.get('fc-7').content.sound, 'default');
  module.setPhoneAlarmGlassesStatus(true, true, false);
  same([...pending.keys()].sort(), ['fc-7', 'fc-7-esc']);
  assert.equal(pending.get('fc-7').content.sound, undefined);
  module.setPhoneAlarmGlassesStatus(true, false, false);
  same([...pending.keys()], ['fc-7']);
  assert.equal(pending.get('fc-7').content.sound, 'default');
  clock.now = T + 3 * 60_000 + 1;
  module.setPhoneAlarmGlassesStatus(true, true, false);
  same([...pending.keys()], ['fc-7'], 'an entry already due is not re-armed');
});

test('iOS alarm: delivered moves the escalation to +30s, acknowledge clears both', () => {
  const { module, pending, removedDelivered, clock } = alarms();
  module.setPhoneAlarmGlassesStatus(true, true, false);
  module.schedulePhoneAlarm(7, T, 'Alarm', '7:00', 'alarm', 10);
  clock.now = T;
  module.phoneAlarmDeliveredToGlasses(7);
  same(pending.get('fc-7-esc').trigger, { seconds: 30 });
  module.acknowledgePhoneAlarm(7);
  same([...pending.keys()], []);
  same(removedDelivered, ['fc-7', 'fc-7-esc']);
  module.phoneAlarmDeliveredToGlasses(7);
  same([...pending.keys()], [], 'nothing is re-armed for a forgotten item');
});

test('iOS alarm: the engine ringing an item the gate cannot carry sounds now', () => {
  const { module, pending, clock } = alarms();
  clock.now = T;
  module.ringPhoneAlarm(3, 'Timer finished', '5 min', 'timer', 5);
  same([...pending.keys()], ['fc-3']);
  same(pending.get('fc-3').trigger, { seconds: 1 });
  assert.equal(pending.get('fc-3').content.sound, 'default');
});

test('iOS alarm: a phone snooze journals, notifies, and re-arms natively; dismiss forgets', () => {
  const { module, pending, clock, respond } = alarms();
  module.schedulePhoneAlarm(7, T, 'Alarm', '7:00', 'alarm', 10);
  const heard = [];
  module.onPhoneAlarmAction(event => heard.push(event));
  clock.now = T + 2000;
  assert.equal(respond('fc-7-esc', 'snooze'), true, 'the completion handler runs');
  const event = { id: 7, action: 'snooze', minutes: 10, atMs: T + 2000 };
  same(heard, [event]);
  same(pending.get('fc-7').trigger, { atMs: T + 2000 + 600_000 });
  respond('fc-7', 'dismiss');
  same([...pending.keys()], []);
  assert.equal(respond('fc-7', 'com.apple.UNNotificationDefaultActionIdentifier'), true);
  same(module.drainPhoneAlarmJournal(), [event, { id: 7, action: 'dismiss', minutes: 0, atMs: T + 2000 }]);
  same(module.drainPhoneAlarmJournal(), []);
});

test('iOS alarm: foreground presentation is list-only for the silent request', () => {
  const { center } = alarms();
  const present = sound => { let options; center.delegate.userNotificationCenterWillPresentNotificationWithCompletionHandler(center, { request: { content: { sound } } }, o => { options = o; }); return options; };
  assert.equal(present(undefined), 8);
  assert.equal(present('default'), 16 | 2 | 8);
});

test('iOS alarm: a delegate method that throws files a report and still calls the completion handler', () => {
  const { center, respond, reports } = alarms();
  let options;
  const throwing = { get request() { throw new Error('no request'); } };
  assert.doesNotThrow(() => center.delegate.userNotificationCenterWillPresentNotificationWithCompletionHandler(center, throwing, o => { options = o; }));
  assert.equal(options, 16 | 2 | 8, 'an alarm that cannot be inspected is still presented');
  assert.equal(reports.length, 1);
  assert.match(reports[0][0], /WillPresent/);
  let completed = false;
  assert.doesNotThrow(() => center.delegate.userNotificationCenterDidReceiveNotificationResponseWithCompletionHandler(center, throwing, () => { completed = true; }));
  assert.ok(completed);
  assert.equal(reports.length, 2);
  assert.ok(respond('fc-1-ring', 'dismiss'), 'a normal response still completes');
});

test('iOS alarm: an action listener that throws files a report, and the next listener still hears it', () => {
  const { module, respond, reports } = alarms();
  module.schedulePhoneAlarm(7, T, 'Alarm', '7:00', 'alarm', 10);
  const heard = [];
  module.onPhoneAlarmAction(() => { throw new Error('engine gone'); });
  module.onPhoneAlarmAction(event => heard.push(event.action));
  assert.ok(respond('fc-7', 'dismiss'));
  same(heard, ['dismiss']);
  same(reports, [['phone alarm action listener', 'engine gone']]);
});

test('iOS alarm: reliability reports denied and Time Sensitive off, and fixes open Settings', () => {
  const { module, opened } = alarms({ status: 1, timeSensitive: 1 });
  same(module.checkPhoneAlarmReliability().map(issue => [issue.code, issue.fixable]),
    [['ios-notifications', true], ['ios-time-sensitive', true], ['ios-silent', false]]);
  module.openPhoneAlarmReliabilityFix('ios-notifications');
  same(opened, ['app-settings:']);
  assert.equal(module.hasPhoneAlertPermission(), false);
});

test('iOS alarm: authorization is asked when scheduling in the foreground, or from the fix', async () => {
  const background = alarms({ status: 0, active: false });
  background.module.schedulePhoneAlarm(1, T, 'Alarm', '', 'alarm', 10);
  same(background.authRequests, []);
  background.module.openPhoneAlarmReliabilityFix('ios-notifications');
  same([background.authRequests, background.opened], [[7], []]);
  const foreground = alarms({ status: 0 });
  foreground.module.schedulePhoneAlarm(1, T, 'Alarm', '', 'alarm', 10);
  same(foreground.authRequests, [7]);
  await tick();
  assert.equal(foreground.module.hasPhoneAlertPermission(), true);
  same(foreground.module.checkPhoneAlarmReliability().map(issue => issue.code), ['ios-silent']);
});

test('iOS AlarmKit: the sounding stage is an AlarmKit alarm; the notification stays the silent record', () => {
  const kit = fakeKit();
  const { module, pending } = alarms({ kit });
  module.setPhoneAlarmGlassesStatus(true, true, false);
  module.schedulePhoneAlarm(7, T + 400, 'Alarm', '7:00', 'alarm', 10);
  same([...pending.keys()], ['fc-7'], 'no sounding notification request');
  assert.equal(pending.get('fc-7').content.sound, undefined);
  same(kit.schedules(), [[KIT7, T + 5400, 'Alarm']]);
  module.setPhoneAlarmGlassesStatus(true, false, false);
  same([...pending.keys()], ['fc-7']);
  assert.equal(pending.get('fc-7').content.sound, undefined, 'AlarmKit rings, so the record stays silent');
  same(kit.schedules().at(-1), [KIT7, T + 400, 'Alarm'], 'rings at T when the glasses cannot carry it');
  kit.settle();
  same([...kit.scheduled], [[KIT7, T + 400]], 'each re-arm cancels the alarm before it');
});

test('iOS AlarmKit: delivered moves the alarm to +30s, acknowledge cancels it, nothing is journaled', () => {
  const kit = fakeKit();
  const { module, clock } = alarms({ kit });
  module.setPhoneAlarmGlassesStatus(true, true, false);
  module.schedulePhoneAlarm(7, T, 'Alarm', '7:00', 'alarm', 10);
  kit.settle();
  clock.now = T + 1000;
  module.phoneAlarmDeliveredToGlasses(7);
  kit.settle();
  same([...kit.scheduled], [[KIT7, T + 31_000]]);
  module.acknowledgePhoneAlarm(7);
  kit.settle();
  same([...kit.scheduled], []);
  clock.now = T + 60_000;
  kit.observer(kit.alarmIds());
  same(module.drainPhoneAlarmJournal(), []);
});

test('iOS AlarmKit: a scheduled alarm gone after its fire time was stopped on the phone', () => {
  const kit = fakeKit();
  const { module, clock, pending } = alarms({ kit });
  module.schedulePhoneAlarm(7, T, 'Alarm', '7:00', 'alarm', 10);
  const heard = [];
  module.onPhoneAlarmAction(event => heard.push(event));
  kit.observer('');
  same(heard, [], 'not yet confirmed by AlarmKit');
  kit.settle();
  kit.observer('');
  same(heard, [], 'gone before its fire time is not a dismiss');
  clock.now = T + 5000;
  kit.observer(kit.alarmIds());
  same(heard, [], 'still alerting');
  kit.scheduled.clear();
  kit.observer('');
  same(heard, [{ id: 7, action: 'dismiss', minutes: 0, atMs: T + 5000 }]);
  same([...pending.keys()], []);
  kit.observer('');
  same(module.drainPhoneAlarmJournal().length, 1, 'journaled once');
});

test('iOS AlarmKit: a Stop while the app was suspended is found on resume and at drain', () => {
  const kit = fakeKit();
  const { module, clock, resume } = alarms({ kit });
  module.schedulePhoneAlarm(7, T, 'Alarm', '', 'alarm', 10);
  module.schedulePhoneAlarm(8, T, 'Timer', '', 'timer', 5);
  kit.settle();
  clock.now = T + 5000;
  kit.scheduled.delete(KIT7);
  resume();
  same(module.drainPhoneAlarmJournal().map(event => event.id), [7]);
  kit.scheduled.clear();
  same(module.drainPhoneAlarmJournal().map(event => event.id), [8]);
});

test('iOS AlarmKit: a failed schedule falls back to the sounding notification', () => {
  const kit = fakeKit({ fail: 'AlarmError' });
  const { module, pending } = alarms({ kit });
  module.setPhoneAlarmGlassesStatus(true, true, false);
  module.schedulePhoneAlarm(7, T, 'Alarm', '7:00', 'alarm', 10);
  same([...pending.keys()], ['fc-7']);
  kit.settle();
  same([...pending.keys()], ['fc-7', 'fc-7-esc']);
  assert.equal(pending.get('fc-7-esc').content.sound, 'default');
  same(pending.get('fc-7-esc').trigger, { atMs: T + 5000 });
});

test('iOS AlarmKit: not authorized keeps the notification tier and reports a fixable issue', async () => {
  const kit = fakeKit({ state: 1 });
  const { module, pending, opened } = alarms({ kit });
  module.schedulePhoneAlarm(7, T, 'Alarm', '7:00', 'alarm', 10);
  assert.equal(pending.get('fc-7').content.sound, 'default');
  same(kit.schedules(), []);
  same(module.checkPhoneAlarmReliability().map(issue => [issue.code, issue.fixable]), [['ios-alarmkit', true], ['ios-silent', false]]);
  module.openPhoneAlarmReliabilityFix('ios-alarmkit');
  same(opened, ['app-settings:']);
  const granted = fakeKit({ state: 2 });
  const ready = alarms({ kit: granted, timeSensitive: 1 });
  same(ready.module.checkPhoneAlarmReliability(), [], 'AlarmKit breaks through Silent and Focus');
});

test('iOS AlarmKit: asked once in the foreground; a grant moves armed items onto AlarmKit', async () => {
  const kit = fakeKit({ state: 0 });
  const { module, pending, authRequests } = alarms({ kit });
  module.schedulePhoneAlarm(7, T, 'Alarm', '7:00', 'alarm', 10);
  module.schedulePhoneAlarm(8, T, 'Alarm', '7:00', 'alarm', 10);
  same([authRequests, kit.calls.filter(call => call[0] === 'auth').length], [[], 1]);
  kit.settle();
  same(kit.schedules().map(call => call[0]), [KIT7, '00000000-0000-4000-8000-000000000008']);
  assert.equal(pending.get('fc-7').content.sound, undefined);
  const fresh = alarms({ kit: fakeKit({ state: 0 }), status: 0 });
  fresh.module.schedulePhoneAlarm(7, T, 'Alarm', '', 'alarm', 10);
  await tick();
  same(fresh.authRequests, [7], 'notifications first, then AlarmKit');
});

test('iOS AlarmKit: losing authorization moves armed items back on resume', () => {
  const kit = fakeKit();
  const { module, pending, resume } = alarms({ kit });
  module.schedulePhoneAlarm(7, T, 'Alarm', '7:00', 'alarm', 10);
  assert.equal(pending.get('fc-7').content.sound, undefined);
  kit.state = 1;
  resume();
  assert.equal(pending.get('fc-7').content.sound, 'default');
});

test('iOS AlarmKit: every selector alarms.ios.ts calls is exported by FaceclawAlarmKit.swift', () => {
  const swift = read('App_Resources/iOS/src/FaceclawAlarmKit.swift');
  assert.match(swift, /@objc\(FaceclawAlarmKit\) public final class FaceclawAlarmKit: NSObject/);
  const exported = [...swift.matchAll(/@objc\(([a-zA-Z:]+)\)\s*public static func/g)]
    .map(([, selector]) => selector.split(':').filter(Boolean).map((part, i) => (i ? part[0].toUpperCase() + part.slice(1) : part)).join(''));
  const called = [...new Set([...read('app/native/alarms.ios.ts').matchAll(/FaceclawAlarmKit\.(\w+)\(/g)].map(match => match[1]))];
  assert.ok(called.length >= 6, called.join());
  for (const name of called) assert.ok(exported.includes(name), `${name} is not in ${exported.join()}`);
  const flags = read('App_Resources/iOS/build.xcconfig');
  assert.match(flags, /^OTHER_LDFLAGS = .*-weak_framework AlarmKit(\s|$)/m);
  assert.doesNotMatch(flags, /-framework AlarmKit/, 'a strong link crashes iOS 15-25 at launch');
  assert.match(flags, /^SWIFT_VERSION = 5\.0;$/m);
});

function permissions({ speech = 0, microphone = 3, location = 0, confirm = true } = {}) {
  const calls = [];
  const card = id => vm.cards.find(c => c.id === id);
  const tap = id => card(id).onCardTap({ object: { bindingContext: card(id) } });
  const exports = load('app/phone-ui/permissions-view-model.ts', {
    global: { isIOS: true },
    FaceclawSpeech: {
      authorizationStatus: () => speech, microphoneAuthorizationStatus: () => microphone,
      requestAuthorization: done => { calls.push('speech'); done(3); }, requestMicrophoneAuthorization: done => done(3),
    },
    CLLocationManager: { new: () => ({ authorizationStatus: location }) },
    require: name => ({
      '@nativescript/core': {
        Application: { on() {}, off() {}, resumeEvent: 'resume' },
        Dialogs: { confirm: async options => { calls.push(options.title); return confirm; }, alert: async options => { calls.push(options.message); } },
        Frame: {}, Observable: class { notifyPropertyChange() {} },
        Utils: { openUrl: url => calls.push(url), executeOnMainThread: fn => fn() },
      },
      '../native/ios-bluetooth': { iosBluetooth: () => ({ state: 5 }) },
      '../branding': { APP_NAME: 'OcuSmart' },
      '../g2/android-permissions': {},
      '../native/calendar-permissions': { hasCalendarPermission: () => false, ensureCalendarPermission: async () => true },
      '../native/battery-optimization': {}, '../native/file-access': {},
      '../native/notification-access': { isNotificationListenerEnabled: () => false, requestNotificationListenerAccess() {} },
      '../native/location-permissions': { hasLocationPermission: () => false, ensureFineLocationPermission: async () => { calls.push('location'); return true; } },
      '../native/alarms': { hasPhoneAlertPermission: () => true, requestPhoneAlertPermission: async () => true, refreshPhoneAlertPermission: async () => { calls.push('prefetch'); } },
    })[name],
  });
  const vm = new exports.PermissionsViewModel();
  return { vm, calls, card, tap };
}

test('iOS Permissions lists every iOS permission the app uses', async () => {
  const { vm, card, calls } = permissions();
  same(vm.cards.map(c => c.id),
    ['nearby-devices', 'post-notifications', 'microphone', 'speech-recognition', 'location', 'read-notifications', 'calendar']);
  same(vm.cards.filter(c => c.optionalVisibility === 'collapse').map(c => c.id), ['nearby-devices']);
  assert.equal(card('post-notifications').checkVisibility, 'visible');
  assert.equal(card('microphone').checkVisibility, 'visible');
  assert.equal(card('speech-recognition').checkVisibility, 'collapse');
  vm.onPageLoaded();
  await tick();
  same(calls, ['prefetch'], 'the async notification status is fetched when the page loads');
});

test('iOS Permissions asks once, then sends a declined card to Settings', async () => {
  const fresh = permissions({ speech: 0 });
  fresh.tap('speech-recognition');
  await tick();
  same(fresh.calls, ['speech']);
  const denied = permissions({ speech: 2, location: 2 });
  denied.tap('speech-recognition');
  await tick();
  denied.tap('location');
  await tick();
  denied.tap('read-notifications');
  await tick();
  same(denied.calls.slice(0, 4), ['Speech Recognition Access', 'app-settings:', 'Location Access', 'app-settings:']);
  assert.match(denied.calls[4], /Share System Notifications/);
  const location = permissions({ location: 0 });
  location.tap('location');
  await tick();
  same(location.calls, ['location']);
});
