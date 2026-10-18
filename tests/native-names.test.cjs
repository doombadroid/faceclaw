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
function compile(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-types-'));
  const files = { 'prelude.ts': PRELUDE, 'native.ts': generate(parseHeader(HEADER, new Map())), 'probe.ts': `${source}\nexport {};\n` };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  try {
    const program = ts.createProgram(Object.keys(files).map(name => path.join(dir, name)),
      { noEmit: true, target: ts.ScriptTarget.ES2020, lib: ['lib.es2020.d.ts'], types: [], experimentalDecorators: true });
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
    native.scheduleClockDone(() => Date.now(), names => names.count);
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
  assert.match(errors[5], /Type 'string' is not assignable to type 'number'/);
  assert.match(errors[6], /'take' does not exist/);
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
});

test('a local Faceclaw declaration (which would shadow the generated type) and a raw protocol extend are errors', () => {
  const errors = rules(`declare const FaceclawKitIosGlassesSession: any, Other: any;\ndeclare const FaceclawLog: { log(m: string): void } | undefined;\n` +
    `(NSObject as any).extend({ onReady() {} }, { protocols: [FaceclawKitIosTranscriptListener] });`);
  assert.equal(errors.length, 3, errors.join('\n'));
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
