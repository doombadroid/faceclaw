const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, jsNameOf } = require('../scripts/check-native-names.cjs');

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
@end
__attribute__((objc_subclassing_restricted))
__attribute__((swift_name("IosGlassesSession")))
@interface FaceclawKitIosGlassesSession : FaceclawKitBase
- (instancetype)initWithRightAddress:(NSString *)rightAddress leftAddress:(NSString * _Nullable)leftAddress __attribute__((swift_name("init(rightAddress:leftAddress:)"))) __attribute__((objc_designated_initializer));
- (BOOL)startG2AudioForwardingNsDataListener:(id<FaceclawKitIosAudioPacketListener>)listener __attribute__((swift_name("startG2AudioForwardingNsData(listener:)")));
- (FaceclawKitIosGlassesSession *)copySession __attribute__((swift_name("copySession()")));
@property (readonly) int32_t mtu __attribute__((swift_name("mtu")));
@end
NS_ASSUME_NONNULL_END
`;

function check(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-names-'));
  const header = path.join(dir, 'FaceclawKit.h');
  const file = path.join(dir, 'probe.ios.ts');
  fs.writeFileSync(header, HEADER);
  fs.writeFileSync(file, `declare const FaceclawKitIosGlassesSession: any, FaceclawKitIosAudioPacketListener: any, FaceclawKitIosTranscriptListener: any;\n${source}`);
  try { return run({ kotlinHeader: header, files: [file] }).errors; } finally { fs.rmSync(dir, { recursive: true }); }
}

test('selectors map to NativeScript JS names', () => {
  assert.equal(jsNameOf('onAudioPacketData:arm:arrivalMs_:'), 'onAudioPacketDataArmArrivalMs_');
  assert.equal(jsNameOf('initWithRightAddress:leftAddress:'), 'initWithRightAddressLeftAddress');
  assert.equal(jsNameOf('onReady'), 'onReady');
});

test("build 37's audio listener (missing the mangled selector) is an error", () => {
  const errors = check(`
    class AudioPacketListener extends NSObject {
      static ObjCProtocols = [FaceclawKitIosAudioPacketListener];
      onAudioPacketDataArmArrivalMs(data, arm, ms) {}
    }`);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /without `onAudioPacketDataArmArrivalMs_` \(selector onAudioPacketData:arm:arrivalMs_:\)/);
  assert.deepEqual(check(`
    class AudioPacketListener extends NSObject {
      static ObjCProtocols = [FaceclawKitIosAudioPacketListener];
      onAudioPacketDataArmArrivalMs_(data, arm, ms) {}
    }`), []);
});

test('kotlinListener objects pass on either twin name, and fail on a missing or stray method', () => {
  assert.deepEqual(check(`kotlinListener(FaceclawKitIosTranscriptListener, { onReady: () => {}, onTranscriptTextIsFinal: () => {} });`), []);
  const missing = check(`kotlinListener(FaceclawKitIosTranscriptListener, { onTranscriptTextIsFinal: () => {} });`);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /without `onReady`/);
  const stray = check(`kotlinListener(FaceclawKitIosTranscriptListener, { onReady: () => {}, onTranscriptTextIsFinal: () => {}, onTranscript: () => {} });`);
  assert.equal(stray.length, 1);
  assert.match(stray[0], /`onTranscript` matches no method/);
});

test('calls into native classes are checked through variables, fields and return types', () => {
  assert.deepEqual(check(`
    const native = FaceclawKitIosGlassesSession.alloc().initWithRightAddressLeftAddress('r', null);
    native.startG2AudioForwardingNsDataListener(null);
    native.copySession().mtu;
    class Bridge { native = FaceclawKitIosGlassesSession.alloc().initWithRightAddressLeftAddress('r', null);
      go() { return this.native.mtu; } }`), []);
  const errors = check(`
    const native = FaceclawKitIosGlassesSession.alloc().initWithRightAddress('r');
    const other = FaceclawKitIosGlassesSession.alloc().initWithRightAddressLeftAddress('r', null);
    other.startG2AudioForwarding(null);
    other.copySession().mtuSize;
    FaceclawKitIosGlassesSession.new();
    class Bridge { constructor() { this.native = FaceclawKitIosGlassesSession.alloc().initWithRightAddressLeftAddress('r', null); }
      go() { return this.native.startAudio(); } }`);
  assert.deepEqual(errors.map(e => e.replace(/^.*?: /, '')), [
    'an instance of FaceclawKitIosGlassesSession has no member `initWithRightAddress`',
    'an instance of FaceclawKitIosGlassesSession has no member `startG2AudioForwarding`',
    'an instance of FaceclawKitIosGlassesSession has no member `mtuSize`',
    'FaceclawKitIosGlassesSession has no class member `new`',
    'an instance of FaceclawKitIosGlassesSession has no member `startAudio`',
  ]);
});

test('a declared native name missing from the headers is an error', () => {
  const errors = check(`declare const FaceclawKitIosGoneAway: any;`);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /FaceclawKitIosGoneAway is not declared/);
});

test('the iOS sources match the ObjC and Swift shims (and FaceclawKit.h when its snapshot exists)', () => {
  const snapshot = path.join(__dirname, '..', 'native/kotlin/FaceclawKit.h.snapshot');
  const result = run({ kotlinHeader: fs.existsSync(snapshot) ? snapshot : null });
  assert.deepEqual(result.errors, []);
  assert.ok(result.checked > 50, `only ${result.checked} names checked`);
});
