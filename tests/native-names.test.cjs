const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { run, jsNameOf, kotlinSourcesHash, parseHeader, generate } = require('../scripts/check-native-names.cjs');

// The shape Kotlin/Native emits, including build 37's mangled audio-listener selector.
const HEADER = `
NS_ASSUME_NONNULL_BEGIN
@class FaceclawKitIosGlassesSession;
@protocol FaceclawKitIosAudioPacketListener;
__attribute__((swift_name("KotlinBase")))
@interface FaceclawKitBase : NSObject
- (instancetype)init __attribute__((unavailable));
+ (instancetype)new __attribute__((unavailable));
@end
@interface FaceclawKitBase (FaceclawKitBaseCopying) <NSCopying>
@end
__attribute__((swift_name("KotlinNumber")))
@interface FaceclawKitNumber : NSNumber
@end
__attribute__((swift_name("KotlinLong")))
@interface FaceclawKitLong : FaceclawKitNumber
@end
__attribute__((swift_name("BlockingQueue")))
@interface FaceclawKitBlockingQueue<T> : FaceclawKitBase
- (instancetype)init __attribute__((swift_name("init()"))) __attribute__((objc_designated_initializer));
- (void)putItem:(T _Nullable)item __attribute__((swift_name("put(item:)")));
@end
__attribute__((swift_name("IosAudioPacketListener")))
@protocol FaceclawKitIosAudioPacketListener
@required
- (void)onAudioPacketData:(NSData *)data arm:(NSString *)arm arrivalMs_:(int64_t)arrivalMs __attribute__((swift_name("onAudioPacket(data:arm:arrivalMs_:)")));
@end
__attribute__((swift_name("IosTranscriptListener")))
@protocol FaceclawKitIosTranscriptListener
@required
- (void)onReady __attribute__((swift_name("onReady()")));
- (void)onTranscriptText:(NSString *)text isFinal_:(BOOL)isFinal __attribute__((swift_name("onTranscript(text:isFinal_:)")));
@optional
- (void)onDebugLine:(NSString *)line __attribute__((swift_name("onDebug(line:)")));
@end
__attribute__((objc_subclassing_restricted))
__attribute__((swift_name("IosGlassesSession")))
@interface FaceclawKitIosGlassesSession : FaceclawKitBase
- (instancetype)initWithRightAddress:(NSString *)rightAddress leftAddress:(NSString * _Nullable)leftAddress __attribute__((swift_name("init(rightAddress:leftAddress:)"))) __attribute__((objc_designated_initializer));
- (BOOL)startG2AudioForwardingNsDataListener:(id<FaceclawKitIosAudioPacketListener>)listener __attribute__((swift_name("startG2AudioForwardingNsData(listener:)")));
- (FaceclawKitIosGlassesSession *)copySession __attribute__((swift_name("copySession()")));
- (void)scheduleClock:(FaceclawKitLong *(^)(void))clock done:(void (^ _Nullable)(NSArray<NSString *> *names))done __attribute__((swift_name("schedule(clock:done:)")));
- (FaceclawKitLong * _Nullable)soonestPending __attribute__((swift_name("soonestPending()")));
@property (readonly) int32_t mtu __attribute__((swift_name("mtu")));
@property NSArray<NSString *> *origins __attribute__((swift_name("origins")));
@end
__attribute__((objc_subclassing_restricted))
__attribute__((swift_name("IosGifRecorder")))
@interface FaceclawKitIosGifRecorder : FaceclawKitBase
- (instancetype)init __attribute__((swift_name("init()"))) __attribute__((objc_designated_initializer));
+ (instancetype)new __attribute__((availability(swift, unavailable, message="use object initializers instead")));
@end
NS_ASSUME_NONNULL_END
`;

// Just enough of @nativescript/types-ios for the generated declarations.
const PRELUDE = `
declare namespace interop { interface Pointer {} interface Reference<T> { value: T } }
interface NSObjectProtocol { readonly description: string }
declare class NSObject implements NSObjectProtocol { static alloc(): NSObject; static new(): NSObject; init(): this; readonly description: string }
interface NSCopying {}
declare class NSData extends NSObject { readonly length: number }
declare class NSArray<T> extends NSObject { readonly count: number; objectAtIndex(index: number): T }
declare class NSNumber extends NSObject {}
declare function kotlinListener<P extends object>(protocol: { prototype: P }, methods: NoInfer<Omit<P, keyof NSObjectProtocol>>): P;
declare function NativeClass(): ClassDecorator;
`;

/** tsc's errors for [source] against the types generated from HEADER, as "line: message". */
function compile(source, header = HEADER) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-types-'));
  const files = { 'prelude.ts': PRELUDE, 'native.ts': generate(parseHeader(header, new Map())), 'probe.ts': `${source}\nexport {};\n` };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  try {
    const program = ts.createProgram(Object.keys(files).map(name => path.join(dir, name)),
      { noEmit: true, target: ts.ScriptTarget.ES2020, lib: ['lib.es2020.d.ts'], types: [], experimentalDecorators: true, strictNullChecks: true });
    return ts.getPreEmitDiagnostics(program).map(d => {
      const where = d.file ? `${path.basename(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : '';
      return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
  } finally { fs.rmSync(dir, { recursive: true }); }
}

test('selectors map to NativeScript JS names', () => {
  assert.equal(jsNameOf('onAudioPacketData:arm:arrivalMs_:'), 'onAudioPacketDataArmArrivalMs_');
  assert.equal(jsNameOf('initWithRightAddress:leftAddress:'), 'initWithRightAddressLeftAddress');
  assert.equal(jsNameOf('onReady'), 'onReady');
});

test('the generated declarations compile, and correct native calls pass', () => {
  assert.deepEqual(compile(`
    const native = FaceclawKitIosGlassesSession.alloc().initWithRightAddressLeftAddress('r', null);
    native.copySession().mtu.toFixed();
    native.scheduleClockDone(null as unknown as () => FaceclawKitLong, names => names.count);
    const soonest: number | null = native.soonestPending(); // a boxed number native code hands out is a JS number
    native.origins = ['a']; // NativeScript converts a JS array to an NSArray
    native.origins.objectAtIndex(0).toUpperCase();
    FaceclawKitIosGifRecorder.new();
    FaceclawKitBlockingQueue.alloc().init().putItem(1);
    native.startG2AudioForwardingNsDataListener(kotlinListener(FaceclawKitIosAudioPacketListener, { onAudioPacketDataArmArrivalMs_: (data, arm) => data.length + arm.length }));
    kotlinListener(FaceclawKitIosTranscriptListener, { onReady: () => {}, onTranscriptTextIsFinal_: (text, isFinal) => isFinal && text });`), []);
});

test("build 37's audio listener (missing the mangled selector) does not compile", () => {
  const errors = compile(`
    @NativeClass()
    class AudioPacketListener extends NSObject implements FaceclawKitIosAudioPacketListener {
      static ObjCProtocols = [FaceclawKitIosAudioPacketListener];
      onAudioPacketDataArmArrivalMs(data: NSData, arm: string, ms: number) {}
    }`);
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /incorrectly implements interface 'FaceclawKitIosAudioPacketListener'.*'onAudioPacketDataArmArrivalMs_' is missing/);
});

test('kotlinListener objects need every required method under its exact name, and no stray ones', () => {
  const missing = compile(`kotlinListener(FaceclawKitIosTranscriptListener, { onTranscriptTextIsFinal_: () => {} });`);
  assert.equal(missing.length, 1, missing.join('\n'));
  assert.match(missing[0], /'onReady' is missing/);
  // The unmangled twin only runs through withSelectorTwins' fallback: the header's name is required.
  const unmangled = compile(`kotlinListener(FaceclawKitIosTranscriptListener, { onReady: () => {}, onTranscriptTextIsFinal: () => {} });`);
  assert.equal(unmangled.length, 1, unmangled.join('\n'));
  assert.match(unmangled[0], /'onTranscriptTextIsFinal' does not exist.*Did you mean to write 'onTranscriptTextIsFinal_'/);
  const stray = compile(`kotlinListener(FaceclawKitIosTranscriptListener, { onReady: () => {}, onTranscriptTextIsFinal_: () => {}, onTranscript: () => {} });`);
  assert.equal(stray.length, 1, stray.join('\n'));
  assert.match(stray[0], /'onTranscript' does not exist/);
  const typed = compile(`kotlinListener(FaceclawKitIosTranscriptListener, { onReady: () => {}, onTranscriptTextIsFinal_: (text) => text.toFixed() });`);
  assert.equal(typed.length, 1, typed.join('\n'));
  assert.match(typed[0], /'toFixed' does not exist on type 'string'/);
});

test('calls into native classes are checked for names, arity, types and availability', () => {
  const errors = compile(`
    const native = FaceclawKitIosGlassesSession.alloc().initWithRightAddressLeftAddress('r');
    const other = FaceclawKitIosGlassesSession.alloc().initWithRightAddressLeftAddress('r', null);
    other.startG2AudioForwarding(null);
    other.copySession().mtuSize;
    FaceclawKitIosGlassesSession.new();
    FaceclawKitIosGlassesSession.alloc().init();
    other.scheduleClockDone(() => "now", null);
    FaceclawKitBlockingQueue.alloc().init().take();`);
  assert.deepEqual(errors.map(e => e.replace(/^probe\.ts:\d+: /, '').replace(/\.?\s.*$/, '')), [
    'Expected', 'Property', 'Property', "The", "The", 'Type', 'Property',
  ], errors.join('\n'));
  assert.match(errors[0], /Expected 2 arguments, but got 1/);
  assert.match(errors[1], /'startG2AudioForwarding' does not exist/);
  assert.match(errors[2], /'mtuSize' does not exist/);
  assert.match(errors[3], /'this' context of type 'typeof FaceclawKitIosGlassesSession' is not assignable to method's 'this' of type 'never'/);
  assert.match(errors[4], /'this' context of type 'FaceclawKitIosGlassesSession'/);
  assert.match(errors[5], /Type 'string' is not assignable to type 'FaceclawKitLong'/);
  assert.match(errors[6], /'take' does not exist/);
});

test('JS cannot pass a JS number where Kotlin takes a boxed one (it would arrive as a Double)', () => {
  const errors = compile(`FaceclawKitIosGlassesSession.alloc().initWithRightAddressLeftAddress('r', null).scheduleClockDone(() => Date.now(), null);`);
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /Type 'number' is not assignable to type 'FaceclawKitLong'/);
});

test('a plain object literal is no protocol object (NativeScript would pass it as an NSDictionary)', () => {
  const errors = compile(`FaceclawKitIosGlassesSession.alloc().initWithRightAddressLeftAddress('r', null)
    .startG2AudioForwardingNsDataListener({ onAudioPacketDataArmArrivalMs_: () => {} });`);
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /'description' is missing/);
});

test('outside NS_ASSUME_NONNULL an unannotated pointer may be nil, and strictNullChecks holds JS to that', () => {
  const header = `@interface FaceclawShim : NSObject
@property (nonatomic, copy) void (^handler)(NSString *json);
+ (NSString *)lookup:(NSString *)key;
+ (NSArray<NSString *> *)names;
- (instancetype)init;
@end
NS_ASSUME_NONNULL_BEGIN
@interface FaceclawSure : NSObject
+ (NSString *)name;
@end
NS_ASSUME_NONNULL_END`;
  assert.deepEqual(compile(`FaceclawShim.new().handler = null; FaceclawShim.lookup(null); FaceclawShim.names()?.objectAtIndex(0).length;
    FaceclawShim.new().handler = json => json?.length; FaceclawSure.name().length; FaceclawShim.alloc().init().handler;`, header), []);
  const errors = compile(`FaceclawShim.lookup('k').length; FaceclawSure.name() === null ? 0 : FaceclawSure.name().length;`, header);
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /^probe\.ts:1: Object is possibly 'null'/);
});

test('only the module map\'s headers become JS globals', () => {
  const { loadModel } = require('../scripts/check-native-names.cjs');
  const model = loadModel(null);
  assert.ok(model.has('FaceclawGraphics'));
  // Imported only by .m files: NativeScript generates no metadata for them.
  assert.ok(!model.has('FaceclawEvenHubLocalServer') && !model.has('FaceclawSpeechTranscript'));
});

test('a Swift @objc member belongs to the type body it is in', () => {
  const { parseSwift } = require('../scripts/check-native-names.cjs');
  const model = new Map();
  parseSwift(`@objc(FaceclawA) public final class FaceclawA: NSObject {
    private final class Box { var value: Int? }
    @objc(go:) public static func go(_ x: String) -> Bool { return true }
  }`, model, 'a.swift');
  assert.deepEqual(model.get('FaceclawA').members.map(e => e.name), ['go']);
  assert.throws(() => parseSwift(`@objc(FaceclawA) public final class FaceclawA: NSObject {}
  final class Plain { @objc(stray) func stray() {} }`, new Map(), 'b.swift'), /@objc func stray is not in an @objc class body/);
});

/** check-native-names' own rules on a probe file. */
function rules(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-names-'));
  const file = path.join(dir, 'probe.ios.ts');
  fs.writeFileSync(file, source);
  try { return run({ files: [file] }).errors.map(e => e.replace(/^.*?probe\.ios\.ts:/, '')); } finally { fs.rmSync(dir, { recursive: true }); }
}

test('a class with ObjCProtocols must implement each protocol, so tsc checks it', () => {
  const errors = rules(`
    class Listener extends NSObject {
      static ObjCProtocols = [FaceclawKitIosAudioPacketListener];
      onAudioPacketDataArmArrivalMs_() {}
    }`);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^3: class Listener lists FaceclawKitIosAudioPacketListener in ObjCProtocols without `implements FaceclawKitIosAudioPacketListener`/);
  assert.deepEqual(rules(`
    class Listener extends NSObject implements FaceclawKitIosAudioPacketListener {
      static ObjCProtocols = [FaceclawKitIosAudioPacketListener];
      onAudioPacketDataArmArrivalMs_() {}
    }`), []);
  // An SDK delegate's methods are optional: `implements` would not catch a misspelled one.
  const sdk = rules(`
    class Delegate extends NSObject implements UNUserNotificationCenterDelegate {
      static ObjCProtocols = [UNUserNotificationCenterDelegate];
    }`);
  assert.equal(sdk.length, 1, sdk.join('\n'));
  assert.match(sdk[0], /^3: class Delegate lists UNUserNotificationCenterDelegate in ObjCProtocols: a misspelled optional method compiles/);
});

test('a local Faceclaw or SDK declaration (which would shadow the type), global.Faceclaw* and a raw protocol extend are errors', () => {
  const errors = rules(`declare const FaceclawKitIosGlassesSession: any, Other: any;\ndeclare const FaceclawLog: { log(m: string): void } | undefined;\n` +
    `(NSObject as any).extend({ onReady() {} }, { protocols: [FaceclawKitIosTranscriptListener] });\ndeclare const NSBundle: any, interop: any;\n` +
    `global.FaceclawGraphics.decodeImageFileMaxWidth(); global.isIOS;`);
  assert.equal(errors.length, 6, errors.join('\n'));
  assert.match(errors[3], /^4: `declare NSBundle` shadows its @nativescript\/types-ios type/);
  assert.match(errors[4], /^4: `declare interop` shadows/);
  assert.match(errors[5], /^5: `global\.FaceclawGraphics` bypasses the declared type of FaceclawGraphics/);
  assert.match(errors[0], /^1: `declare FaceclawKitIosGlassesSession` shadows its generated type/);
  assert.match(errors[1], /^2: `declare FaceclawLog` shadows/);
  assert.match(errors[2], /^3: `\.extend\(\.\.\., \{ protocols \}\)` implements a protocol tsc cannot check/);
});

test('kotlinListener is typed as these tests assume', () => {
  const helper = fs.readFileSync(path.join(__dirname, '..', 'app/native/kotlin-listener.ios.ts'), 'utf8');
  assert.match(helper, /export function kotlinListener<P extends object>\(protocol: \{ prototype: P \}, methods: NoInfer<Omit<P, keyof NSObjectProtocol>>\): P/);
});

test('the iOS sources follow the rules, and native/faceclaw-native.ts matches the headers', () => {
  // Without the header every Kotlin name (build 37's crash) goes untyped, so it is required.
  const snapshot = path.join(__dirname, '..', 'native/kotlin/FaceclawKit.h.snapshot');
  assert.ok(fs.existsSync(snapshot), 'native/kotlin/FaceclawKit.h.snapshot is missing');
  const result = run({ kotlinHeader: snapshot });
  assert.deepEqual(result.errors, []);
  assert.ok(result.types > 300, `only ${result.types} native types loaded`);
});

test('the FaceclawKit.h snapshot was generated from the current Kotlin sources', () => {
  const recorded = fs.readFileSync(path.join(__dirname, '..', 'native/kotlin/FaceclawKit.h.sources'), 'utf8').trim();
  assert.equal(recorded, kotlinSourcesHash(), 'the Kotlin changed since the header snapshot: run `npm run kotlin-header`');
});
