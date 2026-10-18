#!/usr/bin/env node
/**
 * The iOS JavaScript reaches native code by ObjC selector, with no compiler in between unless the
 * native surface is typed. This script generates those types and checks what tsc cannot.
 *
 *  1. Generates native/faceclaw-native.ts: TypeScript declarations for every class and protocol in
 *     FaceclawKit.h (Kotlin/Native; CI passes the header it builds, local runs use the snapshot in
 *     native/kotlin/FaceclawKit.h.snapshot), App_Resources/iOS/src/*.h and the @objc(...) members of
 *     App_Resources/iOS/src/*.swift, under their NativeScript names (`a:b:c:` -> `aBC`). tsc then
 *     checks member names, arity, parameter and return types, and protocol implementations:
 *     kotlinListener(P, {...}) and `class X extends NSObject implements P` must have every required
 *     method under its exact name, so build 37's missing `onAudioPacketDataArmArrivalMs_` (the selector
 *     Kotlin/Native mangled) no longer compiles. It is a .ts, not a .d.ts, so tsc checks the
 *     declarations themselves too (skipLibCheck skips every .d.ts).
 *  2. Checks the generated file is current (`npm test`, and CI with the header it built).
 *  3. Checks the rules tsc cannot express:
 *     - a class with `static ObjCProtocols = [P]` must also `implements P`: NativeScript's ClassBuilder
 *       silently skips a misnamed protocol method, and only `implements` makes tsc look;
 *     - no `NSObject.extend(..., { protocols })` outside kotlinListener, for the same reason;
 *     - no local `declare const Faceclaw...`: it would shadow the generated type with an untyped one.
 *
 * Usage: node scripts/check-native-names.cjs [--kotlin-header path]   check (exit 1 on any error)
 *        node scripts/check-native-names.cjs --write                    regenerate native/faceclaw-native.ts
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'native/kotlin/FaceclawKit.h.snapshot');
const TYPES = path.join(ROOT, 'native/faceclaw-native.ts');

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

/** The balanced `(...)` starting at text[start]: [its contents, the index after it]. */
function group(text, start, open = '(', close = ')') {
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    if (text[j] === open) depth++;
    else if (text[j] === close && --depth === 0) return [text.slice(start + 1, j), j + 1];
  }
  throw new Error(`unbalanced ${open}${close} in: ${text}`);
}

/** Splits on commas outside (), <> and []. */
function splitTop(text) {
  const out = [];
  let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('(<['.includes(c)) depth++;
    else if (')>]'.includes(c) && !(c === '>' && text[i - 1] === '-')) depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out.map(s => s.trim()).filter(Boolean);
}

/** The NativeScript JS name of a selector: `a:b:c:` -> `aBC`. */
function jsNameOf(selector) {
  const parts = selector.split(':').filter((part, index, all) => part || index < all.length - 1);
  return parts.map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1))).join('');
}

/** `- (T)part:(T)arg part2:(T)arg2` (no attributes, no `;`): its return type, selector and parameters. */
function parseMethod(decl) {
  let body = decl.replace(/^[-+]\s*/, '').trim(), ret = '';
  if (body.startsWith('(')) { const [type, end] = group(body, 0); ret = type.trim(); body = body.slice(end); }
  const parts = [], params = [];
  const label = /\s*(\w*)\s*:\s*/y;
  for (let i = 0, m; (label.lastIndex = i, m = label.exec(body));) {
    const [type, end] = group(body, label.lastIndex);
    const name = body.slice(end).match(/^\s*(\w+)/);
    parts.push(m[1]);
    params.push({ type: type.trim(), name: name ? name[1] : `p${params.length}` });
    i = end + (name ? name[0].length : 0);
  }
  return { selector: parts.length ? parts.join(':') + ':' : body.trim().split(/\s+/)[0], ret: ret.trim(), params };
}

/** `@property (attrs) Type name` -> its name, type and attributes. */
function parseProperty(decl) {
  const attrs = (decl.match(/^@property\s*\(([^)]*)\)/) || [, ''])[1].split(',').map(s => s.trim());
  const rest = decl.replace(/^@property\s*(\([^)]*\))?/, '').trim();
  const block = rest.match(/\(\s*\^\s*(?:_Nullable\s+|_Nonnull\s+)?(\w+)\s*\)/);
  const name = block ? block[1] : (rest.match(/(\w+)\s*$/) || [])[1];
  const type = block ? rest.replace(block[0], block[0].replace(/\w+\s*\)$/, ')')) : rest.replace(/\w+\s*$/, '').trim();
  const getter = attrs.map(a => a.match(/^getter\s*=\s*(\w+)$/)).find(Boolean);
  return { name, type, getter: getter && getter[1], readonly: attrs.includes('readonly'), isClass: attrs.includes('class'),
    nullable: attrs.includes('nullable') };
}

function emptyType(kind, name) {
  return { kind, name, superclass: null, superArgs: [], generics: [], supers: [], members: [], instance: new Map(), statics: new Map(),
    required: new Map(), unavailable: new Set(), unavailableStatics: new Set() };
}

const typeParams = angle => (angle || '').slice(1, -1).split(',').map(s => s.replace(/__(co|contra)variant/, '').trim()).filter(Boolean);

function parseHeader(text, model) {
  const lines = stripComments(text).split('\n');
  let current = null, required = true, pending = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!current) {
      // `@interface Name<Generics> (Category) : Super<Generics> <Protocols>` / `@protocol Name <Protocols>`.
      const head = line.match(/^@(interface|protocol)\s+(\w+)\s*(<[^>]*>)?\s*(?:\(\s*\w*\s*\))?\s*(?::\s*(\w+)(<[^>]*>)?)?\s*(?:<([^>]*)>)?/);
      if (!head || /;\s*$/.test(line)) continue; // a forward declaration (`@protocol X;`)
      const [, kind, name, angle, superName, superAngle, trailing] = head;
      const protocols = kind === 'protocol' ? (angle || '').slice(1, -1) : trailing;
      current = model.get(name) || emptyType(kind, name);
      model.set(name, current);
      if (kind === 'interface' && angle && !current.generics.length) current.generics = typeParams(angle);
      if (superName) { current.superclass = superName; current.superArgs = typeParams(superAngle); }
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
    const optional = current.kind === 'protocol' && !required;
    if (decl.startsWith('@property')) {
      const prop = parseProperty(decl);
      if (!prop.name) continue;
      const entry = { selector: prop.name, ret: prop.type, property: true, name: prop.name, isStatic: prop.isClass,
        readonly: prop.readonly, nullable: prop.nullable, optional, params: [] };
      current.members.push(entry);
      const table = prop.isClass ? current.statics : current.instance;
      table.set(prop.name, entry);
      if (prop.getter) table.set(prop.getter, entry);
      if (current.kind === 'protocol' && required && !prop.isClass) current.required.set(prop.name, entry);
      continue;
    }
    const isStatic = decl.startsWith('+');
    const { selector, ret, params } = parseMethod(decl);
    const name = jsNameOf(selector);
    const entry = { selector, ret, params, name, isStatic, optional, unavailable };
    current.members.push(entry);
    if (unavailable) { (isStatic ? current.unavailableStatics : current.unavailable).add(name); continue; }
    (isStatic ? current.statics : current.instance).set(name, entry);
    if (current.kind === 'protocol' && required && !isStatic) current.required.set(name, entry);
  }
  return model;
}

/** @objc(Name) classes and their @objc(selector:) members in a Swift file. */
function parseSwift(text, model, file) {
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
    const where = `${file}: ${current.name}.${ident || keyword}`;
    if (!explicit) throw new Error(`${where}: give it an explicit @objc(selector:) so its JS name is fixed`);
    if (keyword !== 'func') throw new Error(`${where}: only @objc funcs are typed (add var/let/init support to check-native-names.cjs)`);
    const after = clean.slice(m.index + m[0].length);
    const [paramText, end] = group(after, after.indexOf('('));
    const ret = after.slice(end).match(/^\s*(?:throws\s*)?(?:->\s*([^{]+?))?\s*\{/);
    const params = splitTop(paramText).map((param, i) => {
      const colon = param.indexOf(':');
      const names = param.slice(0, colon).trim().split(/\s+/);
      return { swift: param.slice(colon + 1).replace(/=.*$/, '').trim(), name: names[names.length - 1] === '_' ? `p${i}` : names[names.length - 1] };
    });
    const parts = explicit.split(':').length - 1;
    if (parts !== params.length) throw new Error(`${where}: @objc(${explicit}) has ${parts} parts but ${params.length} parameters`);
    const isStatic = /\b(static|class)\b/.test(modifiers);
    const entry = { selector: explicit, name: jsNameOf(explicit), isStatic, params, swiftRet: (ret && ret[1]) || 'Void', ret: '' };
    current.members.push(entry);
    (isStatic ? current.statics : current.instance).set(entry.name, entry);
  }
}

function loadModel(kotlinHeader) {
  const model = new Map();
  const src = path.join(ROOT, 'App_Resources/iOS/src');
  if (kotlinHeader) parseHeader(fs.readFileSync(kotlinHeader, 'utf8'), model);
  for (const file of fs.readdirSync(src).sort()) {
    const full = path.join(src, file);
    if (file.endsWith('.h')) parseHeader(fs.readFileSync(full, 'utf8'), model);
    if (file.endsWith('.swift')) parseSwift(fs.readFileSync(full, 'utf8'), model, path.relative(ROOT, full));
  }
  // Conformances a class extension in a .m declares (`@interface FaceclawSqlite () <FaceclawKitSqlPort>`): the ObjC
  // runtime has them, so JS may pass the object where Kotlin takes the protocol.
  for (const file of fs.readdirSync(src).sort().filter(f => f.endsWith('.m'))) {
    for (const [, name, protocols] of stripComments(fs.readFileSync(path.join(src, file), 'utf8')).matchAll(/@interface\s+(\w+)\s*\(\s*\)\s*<([^>]*)>/g)) {
      if (model.has(name)) model.get(name).supers.push(...protocols.split(',').map(s => s.trim()));
    }
  }
  return model;
}

// ---------- TypeScript declarations ----------

const NUMBERS = new Set(['char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int', 'long', 'unsigned long',
  'long long', 'unsigned long long', 'float', 'double', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t',
  'uint64_t', 'NSInteger', 'NSUInteger', 'NSTimeInterval', 'CGFloat']);
// The type arguments @nativescript/types-ios gives these; a bare `NSArray *` is NSArray<any>.
const ARITY = { NSArray: 1, NSMutableArray: 1, NSSet: 1, NSMutableSet: 1, NSDictionary: 2, NSMutableDictionary: 2 };
// NSObjectProtocol declares these as properties; Kotlin's toString()/hashCode() re-export them as methods.
const NSOBJECT_PROPERTIES = new Set(['description', 'debugDescription', 'hash', 'superclass']);
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with']);
const NULLABILITY = /\b(_Nullable_result|_Nullable|_Nonnull|_Null_unspecified|nullable|nonnull|null_unspecified)\b/g;

/** Kotlin's boxed numbers subclass NSNumber, which NativeScript marshals to and from JS numbers (as
 * @nativescript/types-ios types NSNumber), and Kotlin/Native accepts any NSNumber for them. */
function boxedPrimitive(model, name) {
  for (let type = name, seen = 0; type && seen < 10; type = model.get(type)?.superclass, seen++) {
    if (type === 'FaceclawKitBoolean') return 'boolean';
    if (type === 'FaceclawKitNumber' || type === 'NSNumber') return 'number';
  }
  return null;
}

/** The TypeScript type of an ObjC type. ctx: { model, self (the class's TS type), instance, generics }. */
function tsType(raw, ctx) {
  let type = raw.trim();
  if (type.includes('(^')) {
    const open = type.indexOf('(^');
    return blockDeclarator(tsType(type.slice(0, open), ctx), type.slice(open), ctx);
  }
  const nullable = /\b(_Nullable|_Nullable_result|nullable)\b/.test(type);
  type = type.replace(NULLABILITY, ' ').replace(/\b(const|__kindof|__strong|__weak|__unsafe_unretained|__autoreleasing)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const base = baseType(type, ctx, raw);
  return nullable && base !== 'any' ? `${base} | null` : base;
}

function baseType(type, ctx, raw) {
  if (type === 'void') return 'void';
  if (type === 'BOOL' || type === 'bool' || type === '_Bool') return 'boolean';
  if (NUMBERS.has(type)) return 'number';
  if (type === 'instancetype') return ctx.instance ? 'this' : ctx.self;
  if (type === 'id') return 'any'; // ObjC's untyped object pointer, as @nativescript/types-ios types it
  if (type === 'SEL') return 'string';
  if (ctx.generics.includes(type)) return type;
  if (ctx.erased?.includes(type)) return 'any'; // a class type parameter in a class method (see genericStatics)
  if (/^struct \w+ \*$/.test(type)) return 'interop.Pointer | interop.Reference<any>';
  const proto = type.match(/^id\s*<([^>]+)>$/);
  if (proto) return proto[1].split(',').map(s => s.trim()).join(' & ');
  const ptr = type.match(/^(\w+)\s*(<.*>)?\s*\*$/);
  if (!ptr) throw new Error(`no TypeScript type for the ObjC type "${raw}" (add it to check-native-names.cjs)`);
  const [, name, angle] = ptr;
  if (name === 'NSString') return 'string';
  const boxed = boxedPrimitive(ctx.model, name);
  if (boxed) return boxed;
  const args = angle ? splitTop(angle.slice(1, -1)).map(arg => tsType(arg, ctx)) : [];
  const arity = ARITY[name] ?? ctx.model.get(name)?.generics.length ?? 0;
  while (args.length < arity) args.push('any'); // an unparameterized ObjC collection holds ids
  return args.length ? `${name}<${args.join(', ')}>` : name;
}

/** `(^ nullability name)(args)` or `(^(^)(args2))(args)` around a block returning [ret]. */
function blockDeclarator(ret, decl, ctx) {
  const [inner, end] = group(decl, 0);
  const rest = decl.slice(end).trim();
  if (!rest.startsWith('(')) throw new Error(`unparsed block type: ${decl}`);
  const [args, argsEnd] = group(rest, 0);
  if (rest.slice(argsEnd).trim()) throw new Error(`unparsed block type: ${decl}`);
  const fn = `(${blockParams(args, ctx)}) => ${ret}`;
  let core = inner.trim().replace(/^\^/, '').trim();
  const nullable = /\b(_Nullable|nullable)\b/.test(core);
  core = core.replace(NULLABILITY, '').trim();
  if (core.startsWith('(')) return blockDeclarator(`(${fn})`, core, ctx);
  return nullable ? `(${fn}) | null` : fn;
}

const C_WORDS = new Set(['char', 'short', 'int', 'long', 'float', 'double', 'unsigned', 'signed', 'const', 'void']);

function blockParams(args, ctx) {
  const list = splitTop(args);
  if (list.length === 1 && list[0] === 'void') return '';
  return list.map((arg, i) => {
    let name = null, type = arg;
    if (!arg.includes('(^')) {
      const named = arg.match(/^(.*?[\s*])(\w+)$/);
      if (named && !C_WORDS.has(named[2]) && !/^\s*(_Nullable|_Nonnull|nullable)\s*$/.test(named[2]) && named[1].trim()) {
        name = named[2];
        type = named[1];
      }
    } else {
      const inner = arg.match(/\(\s*\^\s*(?:_Nullable\s+)?(\w+)\s*\)/);
      if (inner) name = inner[1];
    }
    return `${paramName(name || `p${i}`)}: ${tsType(type, ctx)}`;
  }).join(', ');
}

const paramName = name => (RESERVED.has(name) ? `${name}_` : name);

function swiftType(raw, ctx) {
  let type = raw.replace(/@escaping/g, '').trim();
  if (type.startsWith('(')) {
    const [args, end] = group(type, 0);
    const ret = type.slice(end).match(/^\s*->\s*(.+)$/);
    if (!ret) throw new Error(`unparsed Swift type: ${raw}`);
    const params = splitTop(args).map((arg, i) => `p${i}: ${swiftType(arg, ctx)}`).join(', ');
    return `(${params}) => ${swiftType(ret[1], ctx)}`;
  }
  const optional = type.endsWith('?');
  if (optional) type = type.slice(0, -1);
  const SWIFT = { String: 'string', NSString: 'string', Bool: 'boolean', Int: 'number', Int32: 'number', Int64: 'number', UInt: 'number',
    Double: 'number', Float: 'number', CGFloat: 'number', NSData: 'NSData', Data: 'NSData', Void: 'void', '()': 'void' };
  const out = SWIFT[type];
  if (!out) throw new Error(`no TypeScript type for the Swift type "${raw}" (add it to check-native-names.cjs)`);
  return optional ? `${out} | null` : out;
}

/** Every member a protocol and its parent protocols in the model declare, by JS name. */
function protocolMembers(model, name, out = new Map(), seen = new Set()) {
  const proto = model.get(name);
  if (!proto || proto.kind !== 'protocol' || seen.has(name)) return out;
  seen.add(name);
  for (const entry of proto.members) if (!entry.isStatic && !out.has(entry.name)) out.set(entry.name, entry);
  for (const parent of proto.supers) protocolMembers(model, parent, out, seen);
  return out;
}

/** Instance member names a class and its superclasses in the model declare (unavailable ones too). */
function inheritedNames(model, name) {
  const names = new Set();
  for (let type = model.get(name); type; type = model.get(type.superclass)) {
    for (const entry of type.members) if (!entry.isStatic) names.add(entry.name);
  }
  return names;
}

/** The nearest declaration of a class method in a class or its superclasses in the model. */
function nearestStatic(model, name, member) {
  for (let type = model.get(name); type; type = model.get(type.superclass)) {
    const hit = type.members.find(entry => entry.isStatic && entry.name === member);
    if (hit) return hit;
  }
  return null;
}

/** What JS may pass for a value of [type]: NativeScript also converts a JS array to an NSArray. */
function input(type) {
  const array = type.match(/^NSArray<(.+)>( \| null)?$/);
  return array ? `NSArray<${array[1]}> | ${/^\w+$/.test(array[1]) ? array[1] : `(${array[1]})`}[]${array[2] || ''}` : type;
}

function memberLines(entries, ctx, indent) {
  const out = [];
  const seen = new Set();
  const properties = new Set(entries.filter(e => e.property).map(e => `${e.isStatic}:${e.name}`));
  for (const entry of entries) {
    const key = `${entry.isStatic}:${entry.name}`;
    if (!entry.property && properties.has(key)) continue; // a property and a same-named method: NativeScript exposes the property
    if (!entry.isStatic && !entry.property && ctx.kind === 'interface' && NSOBJECT_PROPERTIES.has(entry.name)) continue;
    if (entry.unavailable && !['alloc', 'new', 'init'].includes(entry.name)) continue; // never called from JS; alloc/new/init are
    const erased = entry.isStatic && !ctx.genericStatics;
    const local = { ...ctx, instance: !entry.isStatic, generics: erased ? [] : ctx.generics, erased: erased ? ctx.generics : [] };
    let line;
    if (entry.property) {
      const type = tsType(entry.ret, local) + (entry.nullable ? ' | null' : '');
      const prefix = `${entry.isStatic ? 'static ' : ''}`;
      if (!entry.readonly && !entry.optional && input(type) !== type) line = `${prefix}get ${entry.name}(): ${type}; ${prefix}set ${entry.name}(value: ${input(type)});`;
      else line = `${prefix}${entry.readonly ? 'readonly ' : ''}${entry.name}${entry.optional ? '?' : ''}: ${type};`;
    } else {
      const params = entry.params.map(p => `${paramName(p.name)}: ${entry.swiftRet ? swiftType(p.swift, local) : input(tsType(p.type, local))}`);
      if (entry.unavailable) params.unshift('this: never'); // unavailable in ObjC: calling it is a compile error
      const ret = entry.swiftRet ? swiftType(entry.swiftRet, local) : tsType(entry.ret || 'id', local);
      let generics = '';
      if (entry.isStatic && ctx.genericStatics) generics = `<${ctx.generics.join(', ')}>`;
      line = `${entry.isStatic ? 'static ' : ''}${entry.name}${entry.optional ? '?' : ''}${generics}(${params.join(', ')}): ${ret};`;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(indent + line);
  }
  return out;
}

const isFaceclaw = name => /^Faceclaw/.test(name);

/** native/faceclaw-native.ts for a model. Types sort by name; members keep header order. */
function generate(model) {
  const out = [
    '// Generated by scripts/check-native-names.cjs from native/kotlin/FaceclawKit.h.snapshot, App_Resources/iOS/src/*.h',
    '// and the @objc members of App_Resources/iOS/src/*.swift. Do not edit: run `node scripts/check-native-names.cjs --write`',
    '// (`npm run kotlin-header` does it after regenerating the snapshot). A .ts, not a .d.ts, so that tsc checks it.',
    '// Protocols outside these headers (NSCopying, WebKit delegates) are left off `implements`. FaceclawKitNumber and its',
    '// subclasses (Kotlin\'s boxed numbers) are not declared: NativeScript marshals NSNumber to JS numbers and booleans, so',
    '// they are typed number / boolean where they appear.',
    '/* eslint-disable */',
    '',
  ];
  const types = [...model.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const type of types) {
    if (boxedPrimitive(model, type.name)) continue;
    const generics = type.generics;
    const typeArgs = generics.length ? `<${generics.join(', ')}>` : '';
    // A class object has no element type (ObjC generics are erased), so its class methods return X<any>,
    // except under an SDK generic base (NSMutableSet<T>), whose own class methods are generic.
    const genericStatics = generics.length > 0 && !model.has(type.superclass) && type.superArgs.length > 0;
    const self = `${type.name}${generics.length && !genericStatics ? `<${generics.map(() => 'any').join(', ')}>` : typeArgs}`;
    const ctx = { model, self, generics, genericStatics, kind: type.kind };
    if (type.kind === 'protocol') {
      const parents = type.supers.filter(name => model.get(name)?.kind === 'protocol');
      out.push(`interface ${type.name}${parents.length ? ` extends ${parents.join(', ')}` : ''} {`);
      out.push(...memberLines(type.members.filter(e => !e.isStatic), ctx, '  '));
      out.push('}', `declare var ${type.name}: { prototype: ${type.name} };`, '');
      continue;
    }
    if (!type.superclass) {
      // A category on a class from the SDK (`@interface NSError (Kotlin)`): merge into its declaration.
      if (isFaceclaw(type.name)) throw new Error(`${type.name} has no superclass in any header`);
      out.push(`interface ${type.name} {`, ...memberLines(type.members, { ...ctx, kind: 'category' }, '  '), '}', '');
      continue;
    }
    const protocols = [...new Set(type.supers)].filter(name => model.get(name)?.kind === 'protocol');
    const superArgs = type.superArgs.map(arg => tsType(arg, ctx));
    out.push(`declare class ${type.name}${typeArgs} extends ${type.superclass}${superArgs.length ? `<${superArgs.join(', ')}>` : ''}` +
      `${protocols.length ? ` implements ${protocols.join(', ')}` : ''} {`);
    const members = [...type.members];
    const statics = genericStatics ? `<${generics.join(', ')}>` : '';
    if (!members.some(e => e.isStatic && e.name === 'alloc')) out.push(`  static alloc${statics}(): ${self};`);
    if (!members.some(e => e.isStatic && e.name === 'new') && !nearestStatic(model, type.superclass, 'new')?.unavailable) {
      out.push(`  static new${statics}(): ${self};`);
    }
    // Required protocol members the class does not redeclare, so that `implements` holds.
    const own = inheritedNames(model, type.name);
    for (const proto of protocols) {
      for (const entry of protocolMembers(model, proto).values()) {
        if (!entry.optional && !own.has(entry.name)) { members.push({ ...entry, optional: false }); own.add(entry.name); }
      }
    }
    out.push(...memberLines(members, ctx, '  '), '}', '');
  }
  return out.join('\n');
}

function generated(kotlinHeader = SNAPSHOT) {
  return generate(loadModel(kotlinHeader));
}

// ---------- What tsc cannot check ----------

function checkFile(file, report) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
  const rel = path.relative(ROOT, file);
  const where = node => `${rel}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const helper = rel === path.join('app', 'native', 'kotlin-listener.ios.ts');

  function visit(node) {
    // `declare const FaceclawX: any` shadows the generated declaration.
    if ((ts.isVariableStatement(node) || ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isModuleDeclaration(node)) &&
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      const names = ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => d.name) : [node.name];
      for (const name of names) {
        if (name && ts.isIdentifier(name) && isFaceclaw(name.text)) {
          report(where(node), `\`declare ${name.text}\` shadows its generated type in native/faceclaw-native.ts (and turns the native surface back to untyped): delete it`);
        }
      }
    }
    if (ts.isClassLike(node)) {
      const member = node.members.find(m => ts.isPropertyDeclaration(m) && m.name && ts.isIdentifier(m.name) && m.name.text === 'ObjCProtocols' &&
        m.modifiers?.some(mod => mod.kind === ts.SyntaxKind.StaticKeyword));
      if (member?.initializer && ts.isArrayLiteralExpression(member.initializer)) {
        const implemented = new Set((node.heritageClauses || []).filter(h => h.token === ts.SyntaxKind.ImplementsKeyword)
          .flatMap(h => h.types.map(t => t.expression.getText(source))));
        for (const element of member.initializer.elements) {
          const name = element.getText(source);
          if (!implemented.has(name)) {
            report(where(element), `class ${node.name ? node.name.text : '(anonymous)'} lists ${name} in ObjCProtocols without \`implements ${name}\`: ` +
              'tsc cannot check its methods, and NativeScript silently skips a misnamed one ("unrecognized selector" when native code calls it)');
          }
        }
      }
    }
    if (!helper && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'extend' &&
        node.arguments.some(arg => ts.isObjectLiteralExpression(arg) && arg.properties.some(p => p.name && p.name.getText(source) === 'protocols'))) {
      report(where(node), '`.extend(..., { protocols })` implements a protocol tsc cannot check: use kotlinListener(Protocol, {...})');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function tsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

/** The source rules over [files] (default app/**.ts), and whether native/faceclaw-native.ts matches the headers. */
function run({ kotlinHeader = SNAPSHOT, files } = {}) {
  const errors = [];
  const report = (at, message) => errors.push(`${at}: ${message}`);
  const targets = files || tsFiles(path.join(ROOT, 'app'));
  for (const file of targets) checkFile(file, report);
  let types = 0;
  if (!files) {
    const model = loadModel(kotlinHeader);
    types = model.size;
    const committed = fs.existsSync(TYPES) ? fs.readFileSync(TYPES, 'utf8') : '';
    if (committed !== generate(model)) {
      report(path.relative(ROOT, TYPES), `out of date with ${path.relative(ROOT, kotlinHeader)} and App_Resources/iOS/src: run \`node scripts/check-native-names.cjs --write\``);
    }
  }
  return { errors, files: targets.length, types };
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

function write() {
  fs.writeFileSync(TYPES, generated());
}

module.exports = { run, parseHeader, jsNameOf, parseMethod, kotlinSourcesHash, generate, generated, loadModel, write, TYPES };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--write')) {
    write();
    console.log(`check-native-names: wrote ${path.relative(ROOT, TYPES)}`);
    process.exit(0);
  }
  const at = args.indexOf('--kotlin-header');
  const kotlinHeader = at >= 0 ? args[at + 1] : SNAPSHOT;
  const result = run({ kotlinHeader });
  for (const error of result.errors) console.error(`error: ${error}`);
  console.log(`check-native-names: ${result.files} files, ${result.types} native types, ${result.errors.length} errors (${path.relative(ROOT, kotlinHeader)})`);
  process.exit(result.errors.length ? 1 : 0);
}
