const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const ACTIVE = 0, BACKGROUND = 2;

/** error-reports-page.ts's notice over a fake window, app state, clock and NativeScript frame. */
function harness() {
  const h = { listeners: [], events: {}, timers: new Map(), nextTimer: 1, state: ACTIVE, topFrame: null };
  const anchors = () => ({ topAnchor: anchor, leadingAnchor: anchor, trailingAnchor: anchor });
  const anchor = { constraintEqualToAnchorConstant: () => ({}) };
  h.window = { subviews: [], safeAreaLayoutGuide: anchors(), addSubview(view) { this.subviews.push(view); }, bringSubviewToFront() {} };
  h.windowReady = true;
  class Frame { static topmost() { return h.topFrame; } navigate() {} }
  const core = {
    ActionItem: class {}, Dialogs: {}, Label: class {}, StackLayout: class {}, Frame,
    Utils: { getWindow: () => h.windowReady ? h.window : null },
    Application: { resumeEvent: 'resume', suspendEvent: 'suspend', launchEvent: 'launch', on: (name, fn) => (h.events[name] ??= []).push(fn) },
  };
  const page = loader({
    UIApplication: { sharedApplication: { get applicationState() { return h.state; } } },
    UIApplicationState: { Active: ACTIVE, Inactive: 1, Background: BACKGROUND },
    UIButton: { buttonWithTypePrimaryAction: (_type, onTap) => {
      const button = { ...anchors(), onTap, removeFromSuperview() { h.window.subviews = h.window.subviews.filter(view => view !== button); } };
      return button;
    } },
    UIButtonType: { System: 1 }, UIAction: { actionWithHandler: fn => fn },
    NSLayoutConstraint: { activateConstraints() {} }, UIButtonConfiguration: { filledButtonConfiguration: () => ({}) },
    UIColor: {}, UIButtonConfigurationCornerStyle: {}, UIAccessibilityPostNotification() {}, UIAccessibilityAnnouncementNotification: 1,
    setTimeout: (fn, ms) => { const id = h.nextTimer++; h.timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => h.timers.delete(id),
  }, {
    '@nativescript/core': core, './ui-kit': {}, './present': {}, '../../branding': { APP_NAME: 'OcuSmart' },
    '../../native/error-reports': { onErrorReport: fn => { h.listeners.push(fn); return () => {}; } },
  })('app/phone-ui/ios/error-reports-page.ts');
  page.installErrorNotice();
  h.report = source => { for (const fn of h.listeners) fn({ source }, true); };
  h.fire = name => { for (const fn of h.events[name] ?? []) fn(); };
  /** Runs the zero-delay timers: the notice leaves the reporting catch block first. */
  h.tick = () => { for (const [id, timer] of [...h.timers]) if (!timer.ms) { h.timers.delete(id); timer.fn(); } };
  h.hideTimers = () => [...h.timers.values()].filter(timer => timer.ms === 6000).length;
  h.banner = () => h.window.subviews[0]?.accessibilityLabel;
  return h;
}

test('A report caught before the window exists is announced once the app is in front', () => {
  const h = harness();
  h.windowReady = false; h.state = 1;
  h.report('bootstrap');
  h.tick();
  assert.equal(h.window.subviews.length, 0);
  h.windowReady = true;
  h.fire('resume');
  assert.equal(h.banner(), 'OcuSmart caught an error in bootstrap. Tap to view.');
});

test('A burst while in the background shows one coalesced notice on return, and only then starts hiding', () => {
  const h = harness();
  h.state = BACKGROUND;
  for (const source of ['ble.a', 'ble.b', 'ble.c']) h.report(source);
  h.tick();
  assert.equal(h.window.subviews.length, 0, 'nobody is looking');
  assert.equal(h.hideTimers(), 0);
  h.fire('resume');
  assert.equal(h.window.subviews.length, 1);
  assert.equal(h.banner(), 'OcuSmart caught 3 errors, the latest in ble.c. Tap to view.');
  assert.equal(h.hideTimers(), 1);
});

test('The hide timer runs only while the app is in front', () => {
  const h = harness();
  h.report('render');
  h.tick();
  assert.equal(h.hideTimers(), 1);
  h.fire('suspend');
  assert.equal(h.hideTimers(), 0, 'paused in the background');
  assert.equal(h.window.subviews.length, 1);
  h.fire('resume');
  assert.equal(h.hideTimers(), 1);
});

test('Tapping keeps the banner when the sheet could not open', () => {
  const h = harness();
  h.report('render');
  h.tick();
  const host = { showModal() { /* refused: an alert is up */ } };
  h.topFrame = { currentPage: host };
  h.window.subviews[0].onTap();
  assert.equal(h.window.subviews.length, 1);
  host.showModal = function (frame) { this.modal = frame; };
  h.window.subviews[0].onTap();
  assert.equal(h.window.subviews.length, 0);
});
