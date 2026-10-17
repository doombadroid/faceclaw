const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

// The suspend/wake logic both controllers share (app/g2/evenhub-suspend.ts), with a
// fake communicator, clock and host.
function setup({ setting = true, lease = true } = {}) {
  const calls = [], timers = new Map(), logs = [];
  let nextTimer = 0;
  const env = { setting, screenOn: false, glance: false, held: false, phase: 'connected', lease, leaseApplies: true };
  const communicator = {
    setG2ScreenOn: async on => { calls.push(`screen-on ${on}`); },
    setScreenBlanked: async blanked => { calls.push(`blank ${blanked}`); },
    suspendEvenHubSession: async () => { calls.push('suspend'); return true; },
    resumeEvenHubSession: async () => { calls.push('resume'); return true; },
    awaitEvenHubSessionReady: async ms => { calls.push(`ready ${ms}`); return true; },
    setFaceclawWakeLeaseEnabled: async on => { calls.push(`lease ${on}`); return env.leaseApplies; },
  };
  env.communicator = communicator;
  const { EvenHubSuspender } = loader({
    setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
  }, {
    '../native/frame-timings': { spanAsync: (_frame, _name, fn) => fn() },
    '../ui/dashboard-settings': { suspendEvenHubWhenScreenOffSetting: { get: () => env.setting } },
  })('app/g2/evenhub-suspend.ts');
  const suspender = new EvenHubSuspender({
    communicator: () => env.communicator, phase: () => env.phase, isScreenOn: () => env.screenOn,
    glanceVisible: () => env.glance, captureHeld: () => env.held, wantsWakeLease: () => env.lease,
    wakePreview: async () => { calls.push('preview'); return true; },
    onSuspended: () => calls.push('parked'), log: message => logs.push(message), formatError: String,
  });
  const fire = async () => {
    const [id, timer] = [...timers][0];
    timers.delete(id);
    timer.fn();
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    return timer.ms;
  };
  return { suspender, calls, timers, logs, env, fire };
}

test('screen off suspends after 5 s, refreshing the wake lease first, and parks a racing capture', async () => {
  const h = setup();
  h.suspender.scheduleSuspend();
  assert.equal(await h.fire(), 5000);
  assert.deepEqual(h.calls, ['lease true', 'suspend', 'parked']);
  assert.equal(h.suspender.suspended, true);
  assert.equal(h.suspender.wakeLeaseState, true);
  h.suspender.scheduleSuspend();
  assert.equal(h.timers.size, 0, 'already suspended');
});

test('a held capture or a showing Glanceboard keeps the session; an undelivered lease defers the suspend', async () => {
  const h = setup();
  h.env.held = true;
  h.suspender.scheduleSuspend();
  await h.fire();
  assert.deepEqual(h.calls, []);
  assert.equal(h.timers.size, 1, 're-armed while the capture holds');
  h.env.held = false; h.env.leaseApplies = false;
  await h.fire();
  assert.deepEqual(h.calls, ['lease true']);
  assert.match(h.logs.at(-1), /deferred/);
  assert.equal(h.suspender.suspended, false);
  h.env.glance = true;
  h.timers.clear(); h.suspender.scheduleSuspend();
  assert.equal(h.timers.size, 0);
});

test('the wake barrier runs screen-on, resume, unblank, await-ready once for concurrent callers', async () => {
  const h = setup();
  h.suspender.suspended = true;
  const first = h.suspender.ensureActive(7), second = h.suspender.ensureActive();
  assert.equal(first, second);
  assert.equal(await first, true);
  assert.deepEqual(h.calls, ['screen-on true', 'resume', 'blank false', 'ready 4500']);
  assert.equal(h.suspender.suspended, false);
  assert.equal(h.suspender.resumePromise, null);
  h.env.phase = 'disconnected';
  assert.equal(await h.suspender.ensureActive(), false);
  h.env.communicator = null;
  assert.equal(await h.suspender.ensureActive(), true);
  assert.equal(h.calls.at(-1), 'preview');
});

test('turning the setting off releases the lease and resumes a suspended session', async () => {
  const h = setup();
  h.suspender.suspended = true; h.suspender.wakeLeaseState = true;
  h.env.setting = false; h.env.lease = false;
  h.suspender.syncScreenOffSetting();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, ['lease false', 'resume']);
  assert.equal(h.suspender.suspended, false);
  assert.equal(h.suspender.wakeLeaseState, false);
  h.suspender.syncScreenOffSetting();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 2, 'nothing more to send');
});
