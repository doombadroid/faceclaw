const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), url = require('node:url'), vm = require('node:vm');
const { registerHooks } = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'node_modules/@nativescript/core');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function load(file, modules = {}, globals = {}) {
  const context = { exports: {}, require: name => {
    if (!(name in modules)) throw new Error(`Missing mock: ${name} in ${file}`);
    return modules[name];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

// NativeScript's own selector engine and CSS parser, so specificity and :not()
// are what the device computes. Their few platform imports are stubbed.
let engine;
async function cssEngine() {
  if (engine) return engine;
  const stub = source => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === '../core/properties') return stub('export const isCssVariable = n => n.startsWith("--")');
    if (specifier === '../../media-query-list') return stub('export const checkIfMediaQueryMatches = () => true');
    if (specifier === '../../globals') return stub('');
    // Core's ESM build uses extensionless relative imports (resolved by the bundler).
    if (specifier.startsWith('.') && !path.extname(specifier)) specifier += '.js';
    return next(specifier, context);
  } });
  const tslib = require(path.join(ROOT, 'node_modules/tslib'));
  globalThis.__decorate ??= tslib.__decorate; globalThis.__metadata ??= tslib.__metadata;
  const selectors = await import(url.pathToFileURL(path.join(CORE, 'ui/styling/css-selector.js')).href);
  const { parse } = await import(url.pathToFileURL(path.join(CORE, 'css/lib/parse/index.js')).href);
  return engine = { ...selectors, parse };
}

// The bundler inlines each @import where it stands, so app.ios.css's own rules come last.
function cssRules({ parse }, file, skip) {
  if (file === skip) return [];
  return parse(fs.readFileSync(file, 'utf8'), { source: file }).stylesheet.rules.flatMap(rule => {
    if (rule.type !== 'import') return rule.type === 'rule' ? [rule] : [];
    const target = rule.import.replace(/^['"]|['"]$/g, '');
    return cssRules({ parse }, target.startsWith('.') ? path.resolve(path.dirname(file), target) : path.join(ROOT, 'node_modules', target), skip);
  });
}

const ONBOARDING_CSS = path.join(ROOT, 'app/phone-ui/ios/onboarding.ios.css');
async function styler({ without } = {}) {
  const css = await cssEngine();
  const scope = new css.StyleSheetSelectorScope(cssRules(css, path.join(ROOT, 'app/app.ios.css'), without).map(css.fromAstNode));
  return node => {
    const style = {};
    for (const selector of scope.query(node).selectors) {
      if (selector.dynamic && !selector.match(node)) continue;
      for (const { property, value } of selector.ruleset.declarations) style[property] = value;
    }
    return style;
  };
}

// A view chain as NativeScript's selectors see it: lowercase cssType, class set, parent.
function tree(dark, ...path) {
  let node = { cssType: 'frame', cssClasses: new Set(['ns-root', 'ns-ios', 'ns-phone', dark ? 'ns-dark' : 'ns-light']), cssPseudoClasses: new Set() };
  for (const spec of path) {
    const [type, ...classes] = spec.split('.');
    node = { cssType: type.toLowerCase(), cssClasses: new Set(classes), cssPseudoClasses: new Set(), parent: node };
  }
  return node;
}

test('shared device pages take the OcuSmart tokens in light and dark', async () => {
  const style = await styler();
  const cases = [
    [['Page'], 'background-color', '#F2F2F7', '#000000'],
    [['Page'], 'color', '#000000', '#FFFFFF'],
    [['Page', 'GridLayout.p-20', 'GridLayout', 'Button.-primary'], 'background-color', '#0A62D0', '#0A6CDB'],
    [['Page', 'GridLayout.p-20', 'GridLayout', 'Button.-primary'], 'color', '#FFFFFF', '#FFFFFF'],
    [['Page', 'GridLayout.p-20', 'GridLayout', 'Button'], 'background-color', '#FFFFFF', '#1C1C1E'],
    [['Page', 'GridLayout.p-20', 'GridLayout', 'Button'], 'color', '#0A62D0', '#4DA3FF'],
    [['Page', 'GridLayout.p-16', 'StackLayout', 'GridLayout', 'Button.pairing-link'], 'background-color', 'transparent', 'transparent'],
    [['Page', 'GridLayout.p-16', 'StackLayout', 'GridLayout', 'Button.pairing-link'], 'color', '#0A62D0', '#4DA3FF'],
    [['Page', 'ScrollView', 'StackLayout', 'GridLayout.pairing-row'], 'background-color', '#FFFFFF', '#1C1C1E'],
    [['Page', 'ScrollView', 'StackLayout', 'GridLayout.pairing-row.pairing-row-selected'], 'border-color', '#0A62D0', '#4DA3FF'],
    [['Page', 'ScrollView', 'StackLayout', 'GridLayout.pairing-row.pairing-row-incomplete'], 'background-color', '#FFFFFF', '#1C1C1E'],
    [['Page', 'ScrollView', 'StackLayout', 'Label.h2.pairing-section'], 'color', '#6E6E73', '#98989F'],
    [['Page', 'ScrollView', 'StackLayout', 'Label.h1.text-center'], 'color', '#000000', '#FFFFFF'],
    [['Page', 'GridLayout.p-20', 'ScrollView', 'StackLayout', 'Progress'], 'color', '#0A62D0', '#4DA3FF'],
    [['Page', 'GridLayout.p-20', 'StackLayout', 'TextField'], 'background-color', '#FFFFFF', '#1C1C1E'],
  ];
  for (const [chain, property, light, dark] of cases) {
    assert.equal(style(tree(false, ...chain))[property], light, `${chain.join(' > ')} ${property} (light)`);
    assert.equal(style(tree(true, ...chain))[property], dark, `${chain.join(' > ')} ${property} (dark)`);
  }
  const primary = style(tree(false, 'Page', 'GridLayout', 'Button.-primary'));
  assert.equal(primary['border-radius'], '14');
  assert.equal(primary['white-space'], 'normal', 'labels wrap rather than truncate on narrow phones');
  // An incomplete row dims its art and title but not the warning the wearer must read first.
  const incomplete = ['Page', 'ScrollView', 'StackLayout', 'GridLayout.pairing-row.pairing-row-incomplete'];
  for (const dark of [false, true]) {
    assert.equal(style(tree(dark, ...incomplete)).opacity, undefined, 'the row itself keeps full opacity');
    assert.equal(style(tree(dark, ...incomplete, 'StackLayout.m-l-8', 'Label.pairing-warning')).opacity, undefined);
    assert.equal(style(tree(dark, ...incomplete, 'StackLayout.m-l-8', 'GridLayout', 'Label.pairing-title')).opacity, '0.6');
    assert.equal(style(tree(dark, ...incomplete, 'GridLayout.pairing-art')).opacity, '0.6');
  }
  // Utility margins in the XML (m-t-*) must survive the restyle.
  assert.equal(style(tree(false, 'Page', 'ScrollView', 'StackLayout', 'Label.h2.pairing-section.m-t-16'))['margin-top'], '16');
  assert.equal(style(tree(false, 'Page', 'ScrollView', 'StackLayout', 'Label.body-text.m-t-24'))['margin-top'], '24');
});

test('the device-page restyle leaves OcuSmart pages and the Remote page as they were', async () => {
  const withIt = await styler(), withoutIt = await styler({ without: ONBOARDING_CSS });
  const chains = [
    ['Page.os-page'], ['Page.os-page', 'ScrollView', 'StackLayout.os-grouped', 'Button.os-filled-button'],
    ['Page.os-page', 'StackLayout.os-card', 'GridLayout.os-row', 'Label.os-row-title'],
    ['Page.main-page'], ['Page.main-page', 'GridLayout', 'StackLayout.system-name-modal', 'Label.h2'],
    ['Page.main-page', 'GridLayout', 'StackLayout.system-name-modal', 'Button.-primary'],
    ['Page.main-page', 'GridLayout', 'GridLayout.remote-controls', 'Button.tab-button.tab-button-selected'],
  ];
  for (const dark of [false, true]) for (const chain of chains) {
    assert.deepEqual(withIt(tree(dark, ...chain)), withoutIt(tree(dark, ...chain)), `${chain.join(' > ')} (${dark ? 'dark' : 'light'})`);
  }
});

test('the Set Up intro is a system-background sheet with a radius-14 filled Continue', async () => {
  const style = await styler();
  assert.equal(style(tree(false, 'Page.os-page.os-setup'))['background-color'], '#FFFFFF');
  assert.equal(style(tree(true, 'Page.os-page.os-setup'))['background-color'], '#000000');
  const next = ['Page.os-page.os-setup', 'GridLayout', 'StackLayout.os-setup-bottom', 'Button.os-filled-button.os-setup-continue'];
  assert.deepEqual([style(tree(false, ...next))['background-color'], style(tree(true, ...next))['background-color']], ['#0A62D0', '#0A6CDB']);
  assert.equal(style(tree(false, ...next))['border-radius'], '14');
  const cancel = ['Page.os-page.os-setup', 'GridLayout', 'Button.os-setup-cancel'];
  assert.deepEqual([style(tree(false, ...cancel)).color, style(tree(true, ...cancel)).color], ['#0A62D0', '#4DA3FF']);
});

test('every class the restyle names exists on a shared device page or the Set Up page', () => {
  const pages = ['onboarding', 'onboarding-unpair', 'pairing', 'config', 'permissions', 'onboarding-firmware-check', 'onboarding-flash', 'document'];
  const known = new Set(['os-page', 'main-page', 'ns-dark']);
  for (const page of pages) {
    for (const [, classes] of read(`app/phone-ui/${page}-page.xml`).matchAll(/class="([^"{]+)"/g)) classes.split(/\s+/).forEach(c => known.add(c));
  }
  // Classes bound from the view models (rowClass, proximityClass, primaryClass).
  for (const file of ['pairing-view-model.ts', 'permissions-view-model.ts']) {
    for (const [name] of read(`app/phone-ui/${file}`).matchAll(/(?:pairing|permissions)-[a-z-]+/g)) known.add(name);
  }
  for (const [, classes] of read('app/phone-ui/ios/setup-page.ts').matchAll(/'(os-[a-z -]+)'/g)) classes.split(/\s+/).forEach(c => known.add(c));
  const css = fs.readFileSync(ONBOARDING_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const unknown = [...new Set([...css.matchAll(/\.(-?[a-z][a-z0-9-]*)/gi)].map(m => m[1]))].filter(c => !known.has(c));
  assert.deepEqual(unknown, []);
});

function setupPage() {
  const views = [];
  class View {
    events = new Map(); children = [];
    constructor() { views.push(this); }
    on(event, fn) { this.events.set(event, fn); }
    addChild(view) { this.children.push(view); }
    static setRow(view, row) { view.row = row; } static setColumn(view, col) { view.col = col; }
  }
  const core = { Button: View, GridLayout: View, Image: View, Label: View, Page: View, ScrollView: View, StackLayout: View };
  const setup = load('app/phone-ui/ios/setup-page.ts', {
    '@nativescript/core': core,
    '../../g2/glasses-artwork': { GENERIC_G2_IMAGE_PATH: '~/images/glasses/even_realities_g2.png' },
    '../../branding': { APP_NAME: 'OcuSmart' },
  });
  const page = setup.createPage(), calls = [];
  page.frame = { goBack: () => calls.push('back'), navigate: entry => calls.push(entry) };
  return { setup, page, views, calls };
}

test('Set Up: Cancel leaves the detour, Continue opens the existing unpair page in the same Frame', () => {
  const { page, views, calls } = setupPage();
  assert.equal(page.actionBarHidden, true);
  const button = text => views.find(v => v.text === text);
  button('Cancel').events.get('tap')();
  assert.deepEqual(calls, ['back'], "a detour's first page closes it with goBack()");
  button('Continue').events.get('tap')();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { moduleName: 'phone-ui/onboarding-unpair-page' });
  assert.match(read('app/phone-ui/onboarding-register.ios.ts'), /registerModule\('phone-ui\/onboarding-unpair-page'/, 'iOS bundles the Continue target');
});

test('Set Up describes what the pairing flow actually asks for', () => {
  const { setup, views } = setupPage();
  const texts = views.map(v => v.text).filter(Boolean);
  assert.ok(texts.includes('Set Up Even G2'));
  for (const step of setup.SETUP_STEPS) assert.ok(texts.includes(step));
  assert.ok(texts.includes(setup.SETUP_FOOTER));
  // Pairing scans for glasses out of the case (pairing-view-model), after other apps disconnect (unpair page).
  assert.match(setup.SETUP_STEPS.join(' '), /out of the case/);
  assert.doesNotMatch(setup.SETUP_STEPS.join(' '), /case open/);
  assert.match(read('app/phone-ui/pairing-view-model.ts'), /Make sure they are out of the case/);
  assert.match(setup.SETUP_STEPS[0], /Even Realities app/);
  // The firmware step Continue leads to downloads Even's image, so the footer cannot claim the flow is offline.
  assert.match(read('app/g2/firmware-builder.ts'), /FIRMWARE_URL = "https:\/\/cdn\.evenreal\.co\//);
  assert.match(setup.SETUP_FOOTER, /downloads Even's official firmware from Even Realities/);
  assert.match(setup.SETUP_BODY, /^OcuSmart .*Faceclaw's custom firmware/, 'the app is OcuSmart; the firmware keeps its name');
});

test('onboarding names the app OcuSmart on iOS and stays byte-identical on Android', () => {
  const step = isIOS => {
    const branding = load('app/branding.ts', {}, { global: { isIOS } });
    class Observable { notifyPropertyChange() {} }
    const { OnboardingViewModel } = load('app/phone-ui/onboarding-view-model.ts', {
      './onboarding-navigation': {}, '@nativescript/core': { Observable, Frame: {}, Screen: { mainScreen: { heightDIPs: 800 } } },
      '../analytics/privacy-disclosure': { IOS_PRIVACY_NOTICE: '' }, './onboarding-state': {}, '../branding': branding,
    }, { global: { isIOS } });
    return [new OnboardingViewModel(1).headline, new OnboardingViewModel(3).body];
  };
  assert.deepEqual(step(false), ['Faceclaw', "Faceclaw only runs on Even Realities G2 glasses that have Faceclaw's custom firmware installed. You have two choices:\n\n• Preview Only — explore Faceclaw's interface on your phone's screen without pairing any glasses. Nothing is written to a headset.\n\n• Flash Firmware — install the custom firmware on your glasses now, then use Faceclaw for real.\n\nFlashing replaces the official firmware. You can uninstall and return to the official firmware later, by reconnecting the official Even Realities app. Installing custom firmware is not covered by warranty."]);
  const [headline, body] = step(true);
  assert.equal(headline, 'OcuSmart');
  assert.match(body, /^OcuSmart only runs on .* Faceclaw's custom firmware installed/);
  assert.doesNotMatch(body.replace(/Faceclaw's custom firmware/g, ''), /Faceclaw/);
});
