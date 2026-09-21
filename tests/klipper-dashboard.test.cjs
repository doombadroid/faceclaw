const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');

// bdffont.ts and http.ts only touch these at call time (file loading, User-Agent), never while drawing.
const load = loader({ setTimeout, clearTimeout }, { '@nativescript/core': {}, '../version': { USER_AGENT: 'test' } });
const { GrayImage } = load('app/graphics/image.ts');
const { BdfFont } = load('app/graphics/bdffont.ts');
const { moonrakerCandidates, OFFLINE } = load('app/apps/klipper/moonraker.ts');
const { paintDashboard, remainingSeconds, formatDuration } = load('app/apps/klipper/klipper-dashboard.ts');

const bdf = (name) => BdfFont.parse(fs.readFileSync(path.join(__dirname, '../app/fonts/terminus', name), 'utf8'));
const fonts = { small: bdf('ter-u18n.bdf'), medium: bdf('ter-u18n.bdf'), large: bdf('ter-u18n.bdf') };
const printing = { ...OFFLINE, state: 'printing', klippy: 'ready', filename: 'parts/RimHanger-Body_ABS_5h40m.gcode',
  progress: 0.41, printSeconds: 8364, layer: 87, totalLayers: 212, nozzle: 250, nozzleTarget: 250, bed: 100, bedTarget: 100 };

function render(view, width = 576, height = 288) {
  const image = new GrayImage(width, height, 0);
  paintDashboard(image, fonts, { notice: '', tabs: [], cursor: 0, footer: '', focused: true, ...view }, new Date(2026, 8, 20, 21, 0));
  image.bakeDeferredDrawsInPlace(); // text is queued as glyph runs until the compositor bakes it
  if (process.env.KLIPPER_DUMP) {
    const pixels = Buffer.from(Array.from({ length: width * height }, (_, i) => image.getPixel(i % width, (i / width) | 0)));
    fs.writeFileSync(path.join(process.env.KLIPPER_DUMP, `${view.name}.pgm`), Buffer.concat([Buffer.from(`P5 ${width} ${height} 255\n`), pixels]));
  }
  return image;
}
const lit = (image, x0, y0, x1, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (image.getPixel(x, y) > 0) n++; return n; };

test('address clean-up matches what users type', () => {
  assert.deepEqual([...moonrakerCandidates('')], []);
  assert.deepEqual([...moonrakerCandidates('192.168.1.50')], ['http://192.168.1.50', 'http://192.168.1.50:7125']);
  assert.deepEqual([...moonrakerCandidates('voron.local:7125/')], ['http://voron.local:7125']);
  assert.deepEqual([...moonrakerCandidates('http://mainsail.lan/#/console')], ['http://mainsail.lan', 'http://mainsail.lan:7125']);
  assert.deepEqual([...moonrakerCandidates('https://printer.lan/moonraker/')], ['https://printer.lan/moonraker']);
});

test('time left needs real progress', () => {
  assert.equal(remainingSeconds({ ...printing, progress: 0.005 }), null);
  assert.equal(remainingSeconds({ ...printing, state: 'paused' }), null);
  assert.equal(formatDuration(remainingSeconds(printing)), '3h21m');
});

test('cockpit paints every region without overflowing the frame', () => {
  const image = render({ name: 'printing', snap: printing, tabs: ['PAUSE', 'CANCEL', 'SPOOL'], footer: 'hint' });
  assert.ok(lit(image, 16, 0, 200, 30) > 50, 'state chip');
  assert.ok(lit(image, 16, 30, 560, 50) > 500, 'progress bar');
  assert.ok(lit(image, 16, 60, 220, 200) > 800, 'big percentage');
  assert.ok(lit(image, 440, 60, 560, 210) > 300, 'thermometers');
  assert.ok(lit(image, 16, 225, 200, 262) > 1000, 'selected tab is filled');
  assert.equal(lit(image, 0, 0, 8, 288) + lit(image, 568, 0, 576, 288), 0, 'side margins stay dark');
});

test('idle, paused, notice and a short window all render', () => {
  render({ name: 'idle', snap: { ...OFFLINE, state: 'standby', klippy: 'ready', message: 'Filament encoder inserted', nozzle: 46, bed: 70 }, tabs: ['START A JOB', 'PREHEAT', 'SPOOL', 'HEATERS OFF'], cursor: 1, footer: 'hint' });
  render({ name: 'paused', snap: { ...printing, state: 'paused' }, tabs: ['RESUME', 'CANCEL', 'SPOOL'], footer: 'Pausing' });
  render({ name: 'notice', snap: OFFLINE, notice: 'Set the printer address: long-press, then Settings.' });
  render({ name: 'short', snap: printing, tabs: ['PAUSE', 'CANCEL', 'SPOOL'] }, 400, 170);
});
