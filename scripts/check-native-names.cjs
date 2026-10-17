#!/usr/bin/env node
/**
 * Checks the names the iOS JavaScript uses across the native boundary against the native headers.
 *
 *  1. Every Kotlin/ObjC protocol a JS object implements (kotlinListener(P, {...}) or a class with
 *     `static ObjCProtocols = [P]`) has every required method under its exact NativeScript name.
 *     A missing one is an "unrecognized selector" abort the first time native code calls it
 *     (build 37: onAudioPacketData:arm:arrivalMs_:, which Kotlin/Native mangled).
 *  2. Every method or property JS reaches on a native class, from `X.alloc().initWith...()`,
 *     `X.new()`, `X.staticCall()` and the variables and fields holding their results, exists.
 *  3. Every `declare const Faceclaw...: any` names a class or protocol that exists.
 *
 * Headers: FaceclawKit.h (Kotlin/Native, generated on macOS: CI passes the fresh one, local runs
 * use the snapshot in native/kotlin/FaceclawKit.h.snapshot), App_Resources/iOS/src/*.h, and the
 * @objc(...) names in App_Resources/iOS/src/*.swift.
 *
 * Usage: node scripts/check-native-names.cjs [--kotlin-header path] [--json]
 * Exit 1 on any error. Values the checker cannot trace to a native class (an `any` parameter, a
 * field set from elsewhere) are not checked.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

// ---------- ObjC headers ----------

function stripAttributes(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const at = text.indexOf('__attribute__', i);
    if (at < 0) { out += text.slice(i); break; }
    out += text.slice(i, at);
    let j = text.indexOf('(', at), depth = 0;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')' && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** The NativeScript JS name of a selector: `a:b:c:` -> `aBC`. */
function jsNameOf(selector) {
  const parts = selector.split(':').filter((part, index, all) => part || index < all.length - 1);
  return parts.map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1))).join('');
}

/** The return type and selector of `- (T)part:(T)arg part2:(T)arg2` (no attributes, no `;`). */
function parseMethod(decl) {
  const body = decl.replace(/^[-+]\s*/, '');
  let ret = '', rest = '', depth = 0;
  for (const c of body) {
    if (c === '(') { depth++; if (depth === 1) continue; }
    if (c === ')') { depth--; if (depth === 0) continue; }
    if (depth === 0) rest += c;
    else if (!rest.trim()) ret += c; // the first parenthesized group is the return type
  }
  const parts = [...rest.matchAll(/(\w+)\s*:/g)].map(m => m[1]);
  return { selector: parts.length ? parts.join(':') + ':' : rest.trim().split(/\s+/)[0], ret: ret.trim() };
}

function parseProperty(decl) {
  const getter = decl.match(/getter\s*=\s*(\w+)/);
  const block = decl.match(/\(\s*\^\s*(\w+)\s*\)/);
  const name = block ? block[1] : (decl.replace(/^@property\s*(\([^)]*\))?/, '').trim().match(/(\w+)\s*$/) || [])[1];
  return { name, getter: getter && getter[1] };
}

/** The class a return or property type refers to: `FaceclawKitFoo *`, `id<FaceclawKitP>`, `instancetype`. */
function typeRef(type) {
  if (!type) return null;
  if (/instancetype/.test(type)) return { self: true };
  const proto = type.match(/id\s*<\s*(\w+)\s*>/);
  if (proto) return { name: proto[1] };
  const cls = type.match(/^(?:nullable\s+|_Nullable\s+|const\s+)*(\w+)\s*\*/);
  return cls ? { name: cls[1] } : null;
}

function emptyType(kind, name) {
  return { kind, name, superclass: null, supers: [], instance: new Map(), statics: new Map(), required: new Map(), unavailable: new Set(), unavailableStatics: new Set() };
}

function parseHeader(text, model) {
  const clean = stripComments(text);
  const lines = clean.split('\n');
  let current = null, required = true, pending = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!current) {
      // `@interface Name<Generics> (Category) : Super<Generics> <Protocols>` / `@protocol Name <Protocols>`.
      const head = line.match(/^@(interface|protocol)\s+(\w+)\s*(<[^>]*>)?\s*(?:\(\s*\w*\s*\))?\s*(?::\s*(\w+)\s*(?:<[^>]*>)?)?\s*(?:<([^>]*)>)?/);
      if (!head || /;\s*$/.test(line)) continue; // a forward declaration (`@protocol X;`)
      const [, kind, name, angle, superName, trailing] = head;
      const protocols = kind === 'protocol' ? (angle || '').slice(1, -1) : trailing;
      current = model.get(name) || emptyType(kind, name);
      model.set(name, current);
      if (superName) current.superclass = superName;
      if (protocols) current.supers.push(...protocols.split(',').map(s => s.trim()).filter(Boolean));
      required = true;
      continue;
    }
    if (line.startsWith('@end')) { current = null; pending = ''; continue; }
    if (line === '@required') { required = true; continue; }
    if (line === '@optional') { required = false; continue; }
    if (!pending && !/^[-+]|^@property/.test(line)) continue;
    pending += ' ' + line;
    if (!/;\s*$/.test(line)) continue;
    // `availability(swift, unavailable, ...)` (K/N's `+new` on classes with an init()) hides it from Swift only.
    const unavailable = /__attribute__\(\(unavailable|NS_UNAVAILABLE/.test(pending);
    const decl = stripAttributes(pending).replace(/;\s*$/, '').replace(/\b(NS_DESIGNATED_INITIALIZER|NS_SWIFT_NAME\([^)]*\)|NS_UNAVAILABLE|API_AVAILABLE\([^)]*\))/g, '').trim();
    pending = '';
    if (decl.startsWith('@property')) {
      const isClass = /\(\s*[^)]*\bclass\b[^)]*\)/.test(decl);
      const prop = parseProperty(decl);
      const name = prop.name;
      if (!name) continue;
      const type = decl.replace(/^@property\s*(\([^)]*\))?/, '').replace(/\w+\s*$/, '').trim();
      const entry = { selector: name, ret: type, property: true };
      const table = isClass ? current.statics : current.instance;
      table.set(name, entry);
      if (prop.getter) table.set(prop.getter, entry);
      if (current.kind === 'protocol' && required && !isClass) current.required.set(name, entry);
      continue;
    }
    const isStatic = decl.startsWith('+');
    const { selector, ret } = parseMethod(decl);
    const name = jsNameOf(selector);
    if (unavailable) { (isStatic ? current.unavailableStatics : current.unavailable).add(name); continue; }
    const entry = { selector, ret };
    (isStatic ? current.statics : current.instance).set(name, entry);
    if (current.kind === 'protocol' && required && !isStatic) current.required.set(name, entry);
  }
  return model;
}

/** @objc(Name) classes and their @objc(selector:) members in a Swift file. */
function parseSwift(text, model, unparsed) {
  const clean = stripComments(text);
  let current = null;
  const re = /@objc(?:\(([^)]*)\))?\s*((?:public|open|final|static|class|override|@\w+|\s)*)\s*(class|func|var|let|init)\b\s*(\w*)/g;
  for (const m of clean.matchAll(re)) {
    const [, explicit, modifiers, keyword, ident] = m;
    if (keyword === 'class' && !/\bstatic\b/.test(modifiers) && !/func/.test(modifiers)) {
      const name = explicit || ident;
      current = model.get(name) || emptyType('interface', name);
      current.superclass = 'NSObject';
      model.set(name, current);
      continue;
    }
    if (!current) continue;
    if (!explicit) { unparsed.push(`${current.name}.${ident || keyword}`); continue; }
    const isStatic = /\b(static|class)\b/.test(modifiers);
    const name = keyword === 'func' || keyword === 'init' ? jsNameOf(explicit) : explicit;
    (isStatic ? current.statics : current.instance).set(name, { selector: explicit, ret: '' });
  }
}

function loadModel(kotlinHeader) {
  const model = new Map();
  const unparsedSwift = [];
  const src = path.join(ROOT, 'App_Resources/iOS/src');
  if (kotlinHeader) parseHeader(fs.readFileSync(kotlinHeader, 'utf8'), model);
  for (const file of fs.readdirSync(src).sort()) {
    const full = path.join(src, file);
    if (file.endsWith('.h')) parseHeader(fs.readFileSync(full, 'utf8'), model);
    if (file.endsWith('.swift')) parseSwift(fs.readFileSync(full, 'utf8'), model, unparsedSwift);
  }
  return { model, unparsedSwift };
}

// What JS calls on NSObject itself; the rest of NSObject is not used across this boundary.
const NSOBJECT_STATICS = new Set(['alloc', 'new', 'class', 'extend', 'ObjCProtocols']);
const NSOBJECT_INSTANCE = new Set(['init', 'description', 'respondsToSelector', 'isKindOfClass', 'isEqual', 'hash', 'retain', 'release']);

/** A member of a type, searching its superclass and protocols (the nearest declaration wins, an
 * `unavailable` one included). A superclass outside the headers other than NSObject (UIKit, WebKit)
 * leaves the type open; a protocol outside them (NSCopying, WKScriptMessageHandler) adds nothing JS
 * calls, so it closes, or every Kotlin class would be open through FaceclawKitBase <NSCopying>. */
function lookup(model, typeName, member, statics, seen = new Set(), viaProtocol = false) {
  if (typeName === 'NSObject') {
    if (!(statics ? NSOBJECT_STATICS : NSOBJECT_INSTANCE).has(member)) return null;
    return { selector: member, ret: member === 'alloc' || member === 'new' || member === 'init' ? 'instancetype' : '' };
  }
  const type = model.get(typeName);
  if (!type) return viaProtocol ? null : { open: true };
  if (seen.has(typeName)) return null;
  seen.add(typeName);
  const table = statics ? type.statics : type.instance;
  if (table.has(member)) return table.get(member);
  if ((statics ? type.unavailableStatics : type.unavailable).has(member)) return null;
  for (const proto of type.supers) {
    const hit = lookup(model, proto, member, statics, seen, true);
    if (hit) return hit;
  }
  return type.superclass ? lookup(model, type.superclass, member, statics, seen, false) : null;
}

function requiredMethods(model, protocolName, out = new Map(), seen = new Set()) {
  const proto = model.get(protocolName);
  if (!proto || seen.has(protocolName)) return out;
  seen.add(protocolName);
  for (const [name, entry] of proto.required) out.set(name, entry);
  for (const parent of proto.supers) requiredMethods(model, parent, out, seen);
  return out;
}

// ---------- TypeScript side ----------

const isNativeName = name => /^Faceclaw/.test(name);
const twin = name => (name.endsWith('_') ? name.slice(0, -1) : `${name}_`);

function memberName(node) {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isPrivateIdentifier(node.name)) return node.name.text;
  return null;
}

function checkFile(file, model, report) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
  const rel = path.relative(ROOT, file);
  const where = node => `${rel}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const declared = new Set();
  const vars = new Map();   // identifier -> type ref
  const fields = new Map(); // `Class.field` -> type ref
  let currentClass = null;

  // `declare const FaceclawX: any`
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !isNativeName(decl.name.text)) continue;
      if (!report.kotlin && decl.name.text.startsWith('FaceclawKit')) continue; // no Kotlin header to check against
      declared.add(decl.name.text);
      if (!model.has(decl.name.text)) report.error(where(decl), `${decl.name.text} is not declared in any native header`);
    }
  }

  const protocolOf = node => (ts.isIdentifier(node) && declared.has(node.text) && model.get(node.text)?.kind === 'protocol' ? node.text : null);

  function checkImplementation(node, protocols, names, allowTwins, label) {
    for (const proto of protocols) {
      for (const [name, entry] of requiredMethods(model, proto)) {
        const ok = names.has(name) || (allowTwins && names.has(twin(name)));
        if (!ok) report.error(where(node), `${label} implements ${proto} without \`${name}\` (selector ${entry.selector}); native code calling it aborts with "unrecognized selector"`);
        else report.checked++;
      }
    }
    const known = new Set();
    for (const proto of protocols) for (const name of requiredMethods(model, proto).keys()) { known.add(name); known.add(twin(name)); }
    for (const proto of protocols) {
      const type = model.get(proto);
      if (type) for (const name of type.instance.keys()) { known.add(name); known.add(twin(name)); }
    }
    if (label.startsWith('kotlinListener')) {
      for (const name of names) {
        if (!known.has(name)) report.error(where(node), `${label} method \`${name}\` matches no method of ${protocols.join(', ')}; NativeScript never registers it`);
      }
    }
  }

  // Resolves the native type an expression evaluates to, checking member accesses on the way.
  function typeOf(expr) {
    if (!expr) return null;
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return typeOf(expr.expression);
    if (ts.isIdentifier(expr)) {
      if (declared.has(expr.text)) return { name: expr.text, statics: true };
      return vars.get(expr.text) || null;
    }
    if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword && currentClass) {
      return fields.get(`${currentClass}.${expr.name.text}`) || null;
    }
    const call = ts.isCallExpression(expr) ? expr : null;
    const access = call ? call.expression : expr;
    if (!ts.isPropertyAccessExpression(access)) { if (call) report.untraced++; return null; }
    const owner = typeOf(access.expression);
    if (!owner) { report.untraced++; return null; }
    const member = access.name.text;
    const hit = lookup(model, owner.name, member, owner.statics);
    if (!hit) {
      report.error(where(access.name), `${owner.statics ? '' : 'an instance of '}${owner.name} has no ${owner.statics ? 'class ' : ''}member \`${member}\``);
      return null;
    }
    if (hit.open) return null;
    report.checked++;
    if (member === 'alloc') return { name: owner.name, statics: false };
    const ref = typeRef(hit.ret);
    if (!ref) return null;
    if (ref.self) return { name: owner.name, statics: false };
    return model.has(ref.name) ? { name: ref.name, statics: false } : null;
  }

  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name) {
      const saved = currentClass;
      currentClass = node.name.text;
      // Field types first (`this.native = X.alloc()...` in the constructor, or initializers).
      const assignFields = n => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(n.left) && n.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const type = typeOfQuiet(n.right);
          if (type) fields.set(`${currentClass}.${n.left.name.text}`, type);
        }
        ts.forEachChild(n, assignFields);
      };
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member) && member.initializer && memberName(member)) {
          const type = typeOfQuiet(member.initializer);
          if (type) fields.set(`${currentClass}.${memberName(member)}`, type);
        }
      }
      ts.forEachChild(node, assignFields);
      const protocolsMember = node.members.find(m => ts.isPropertyDeclaration(m) && memberName(m) === 'ObjCProtocols');
      if (protocolsMember?.initializer && ts.isArrayLiteralExpression(protocolsMember.initializer)) {
        const protocols = protocolsMember.initializer.elements.map(protocolOf).filter(Boolean);
        const names = new Set(node.members.filter(m => ts.isMethodDeclaration(m)).map(memberName).filter(Boolean));
        if (protocols.length) checkImplementation(node, protocols, names, false, `class ${currentClass}`);
      }
      ts.forEachChild(node, visit);
      currentClass = saved;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const type = typeOfQuiet(node.initializer);
      if (type) vars.set(node.name.text, type);
      visitCalls(node.initializer);
      return;
    }
    if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) {
      visitCalls(node);
      return;
    }
    ts.forEachChild(node, visit);
  }

  function checkKotlinListener(node) {
    const [proto, methods] = node.arguments;
    const name = proto && protocolOf(proto);
    if (name && methods && ts.isObjectLiteralExpression(methods)) {
      const names = new Set(methods.properties.map(memberName).filter(Boolean));
      checkImplementation(node, [name], names, report.twins, `kotlinListener(${name})`);
    } else if (proto && ts.isIdentifier(proto) && declared.has(proto.text)) {
      report.error(where(node), `kotlinListener(${proto.text}): not a protocol in the native headers`);
    }
  }

  // A member chain is checked once, from its outermost node.
  function visitCalls(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'kotlinListener') checkKotlinListener(node);
    if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) {
      typeOf(node);
      if (ts.isCallExpression(node)) node.arguments.forEach(arg => visit(arg));
      let inner = ts.isCallExpression(node) ? node.expression : node.expression;
      while (inner && (ts.isCallExpression(inner) || ts.isPropertyAccessExpression(inner))) {
        if (ts.isCallExpression(inner)) inner.arguments.forEach(arg => visit(arg));
        inner = inner.expression;
      }
      return;
    }
    visit(node);
  }

  function typeOfQuiet(expr) {
    const saved = { error: report.error, checked: report.checked, untraced: report.untraced };
    report.error = () => {};
    try { return typeOf(expr); } finally { Object.assign(report, saved); }
  }

  visit(source);
}

function iosFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...iosFiles(full));
    else if (/\.ios\.ts$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function run({ kotlinHeader, files } = {}) {
  const { model, unparsedSwift } = loadModel(kotlinHeader);
  const errors = [];
  const report = { kotlin: !!kotlinHeader, checked: 0, untraced: 0, error: (at, message) => errors.push(`${at}: ${message}`) };
  const targets = files || iosFiles(path.join(ROOT, 'app'));
  // Either twin name only passes while kotlinListener really registers both.
  const helper = targets.find(f => f.endsWith('kotlin-listener.ios.ts')) || path.join(ROOT, 'app/native/kotlin-listener.ios.ts');
  report.twins = /extend\(withSelectorTwins\(/.test(fs.readFileSync(helper, 'utf8'));
  for (const file of targets) checkFile(file, model, report);
  return { errors: [...new Set(errors)], checked: report.checked, untraced: report.untraced, files: targets.length,
    types: model.size, unparsedSwift };
}

/** The hash of what FaceclawKit.h is generated from (iOS and common Kotlin, and the build script). */
function kotlinSourcesHash() {
  const hash = require('node:crypto').createHash('sha256');
  const shared = path.join(ROOT, 'native/kotlin/shared');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.kt') ? [path.join(dir, entry.name)] : []));
  const files = [path.join(shared, 'build.gradle.kts'), ...['commonMain', 'iosMain'].flatMap(set => walk(path.join(shared, 'src', set)))];
  for (const file of files) hash.update(path.relative(shared, file)).update('\0').update(fs.readFileSync(file)).update('\0');
  return hash.digest('hex');
}

module.exports = { run, parseHeader, jsNameOf, parseMethod, kotlinSourcesHash };

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--kotlin-header');
  const snapshot = path.join(ROOT, 'native/kotlin/FaceclawKit.h.snapshot');
  const kotlinHeader = at >= 0 ? args[at + 1] : (fs.existsSync(snapshot) ? snapshot : null);
  if (!kotlinHeader) console.warn('check-native-names: no FaceclawKit.h (pass --kotlin-header, or add the snapshot); Kotlin names unchecked');
  const result = run({ kotlinHeader });
  for (const error of result.errors) console.error(`error: ${error}`);
  for (const name of result.unparsedSwift) console.warn(`warning: Swift @objc member without an explicit selector, unchecked: ${name}`);
  console.log(`check-native-names: ${result.files} files, ${result.types} native types, ${result.checked} names checked, ` +
    `${result.errors.length} errors (${kotlinHeader ? path.relative(ROOT, kotlinHeader) : 'no Kotlin header'})`);
  process.exit(result.errors.length ? 1 : 0);
}
