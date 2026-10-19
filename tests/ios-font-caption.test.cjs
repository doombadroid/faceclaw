// Caption rendering (Translate): TS wiring everywhere, the Core Text renderer itself on macOS only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');

const packet = (w, h, fill = 0) => Uint8Array.from([w & 255, w >> 8, h & 255, h >> 8, ...new Array(w * h).fill(fill)]);

test('renderFontFileCaption passes the language through and decodes the packet', () => {
  const calls = [];
  const fontRenderer = { renderCaption: (...args) => { calls.push(args); return packet(3, 2, 7); } };
  const { renderFontFileCaption } = loader({ global: { isIOS: true } }, { './font-renderer': { fontRenderer } })('app/native/font-files.ts');
  const image = renderFontFileCaption({ path: '/f.ttf', text: '日本語', sizePx: 18, maxWidth: 200.4, maxLines: 2.6, language: 'ja' });
  assert.deepEqual(calls, [['/f.ttf', '日本語', 18, 200, 1, 3, 'ja']]);
  assert.equal(image.width, 3); assert.equal(image.height, 2); assert.equal(image.pixels[5], 7);
  renderFontFileCaption({ path: '/f.ttf', text: 'x', sizePx: 15, maxWidth: 10, maxLines: 1, language: 'ar', gamma: 0.8 });
  assert.equal(calls[1][4], 0.8);
});

test('renderFontFileCaption returns null off-device, on a failed render and on an empty packet', () => {
  const ok = { renderCaption: () => packet(1, 1) };
  assert.equal(loader({ global: {} }, { './font-renderer': { fontRenderer: ok } })('app/native/font-files.ts')
    .renderFontFileCaption({ path: 'p', text: 't', sizePx: 18, maxWidth: 10, maxLines: 1, language: '' }), null);
  const warn = console.warn; console.warn = () => {};
  try {
    for (const renderCaption of [() => { throw new Error('boom'); }, () => new Uint8Array()]) {
      const { renderFontFileCaption } = loader({ global: { isIOS: true } }, { './font-renderer': { fontRenderer: { renderCaption } } })('app/native/font-files.ts');
      assert.equal(renderFontFileCaption({ path: 'p', text: 't', sizePx: 18, maxWidth: 10, maxLines: 1, language: 'es' }), null);
    }
  } finally { console.warn = warn; }
});

test('iOS calls the renderCaption selector; Android falls back to renderWrapped', () => {
  const ios = [];
  const FaceclawFontRenderer = { renderCaptionTextSizeWidthGammaMaxLinesLanguage: (...args) => { ios.push(args); return 'data'; } };
  const interop = { bufferFromData: () => packet(2, 1, 9).buffer };
  const iosRenderer = loader({ FaceclawFontRenderer, interop })('app/native/font-renderer.ios.ts').fontRenderer;
  assert.deepEqual([...iosRenderer.renderCaption('p', 'مرحبا', 18, 120, 1, 3, 'ar')], [2, 0, 1, 0, 9, 9]);
  assert.deepEqual(ios, [['p', 'مرحبا', 18, 120, 1, 3, 'ar']]);
  const android = [];
  const com = { faceclaw: { app: { FontFileRenderer: { renderWrapped: (...args) => { android.push(args); return [2, 0, 1, 0, 5, 5]; } } } } };
  const androidRenderer = loader({ com })('app/native/font-renderer.ts').fontRenderer;
  assert.deepEqual([...androidRenderer.renderCaption('p', 'hola', 15, 80, 1, 2, 'es')], [2, 0, 1, 0, 5, 5]);
  assert.deepEqual(android, [['p', 'hola', 15, 80, 1, 2]]);
});

// Production Core Text on macOS (no UIKit): direction, per-line height, wrapping, truncation, packet shape.
const NATIVE_TEST = String.raw`
#import <Foundation/Foundation.h>
#import <string.h>
#import "FaceclawFontRenderer.h"
static int U16(const uint8_t *p) { return p[0] | p[1] << 8; }
static void Check(BOOL ok, NSString *message) { if (!ok) { fprintf(stderr, "FAIL: %s\n", message.UTF8String); exit(1); } }
// Ink columns [min,max) of rows [y0,y1) of a packet (all rows when y1 <= 0); a blank region fails the test.
static NSRange InkRows(NSData *packet, int y0, int y1) {
    const uint8_t *p = packet.bytes; int w = U16(p); NSInteger lo = -1, hi = -1;
    if (y1 <= 0) y1 = U16(p + 2);
    for (int y = y0; y < y1; y++) for (int x = 0; x < w; x++) if (p[4 + y * w + x] > 64) { if (lo < 0 || x < lo) lo = x; if (x > hi) hi = x; }
    if (lo < 0) { fprintf(stderr, "FAIL: blank packet\n"); exit(1); }
    return NSMakeRange(lo, hi + 1 - lo);
}
static NSRange Ink(NSData *packet) { return InkRows(packet, 0, 0); }
int main(int argc, char **argv) { @autoreleasepool {
    NSString *font = [@(argv[1]) stringByAppendingPathComponent:@"Roboto-Light.ttf"];
    NSInteger step = 0; { NSArray *m = [[FaceclawFontRenderer getFontMetrics:font size:18] componentsSeparatedByString:@" "]; for (NSString *v in m) step += v.integerValue; }
    NSData *en = [FaceclawFontRenderer renderCaption:font text:@"Hello" size:18 width:300 gamma:1 maxLines:3 language:@"en"];
    NSData *ar = [FaceclawFontRenderer renderCaption:font text:@"مرحبا" size:18 width:300 gamma:1 maxLines:3 language:@"ar"];
    Check(U16(en.bytes) == 300 && U16(ar.bytes) == 300, @"packet width is the requested width");
    Check(en.length == (NSUInteger)(4 + 300 * U16((const uint8_t *)en.bytes + 2)), @"packet length");
    Check(Ink(en).location < 20, @"LTR starts at the left");
    Check(Ink(ar).location > 150 && NSMaxRange(Ink(ar)) >= 280, @"RTL is flushed right");
    Check(U16((const uint8_t *)ar.bytes + 2) >= step, @"Arabic fallback line not shorter than the face's");
    NSData *ja = [FaceclawFontRenderer renderCaption:font text:@"今日はとても良い天気ですね。散歩に行きましょう。" size:18 width:120 gamma:1 maxLines:3 language:@"ja"];
    NSInteger jaHeight = U16((const uint8_t *)ja.bytes + 2);
    Check(jaHeight >= 3 * step, @"CJK without spaces wraps to every allowed line, each at least a face line tall");
    Check(jaHeight < 4 * step + 12, @"maxLines bounds CJK");
    NSData *zh = [FaceclawFontRenderer renderCaption:font text:@"直" size:18 width:120 gamma:1 maxLines:1 language:@"zh-Hans"];
    NSData *jp = [FaceclawFontRenderer renderCaption:font text:@"直" size:18 width:120 gamma:1 maxLines:1 language:@"ja"];
    Check(zh.length > 4 && jp.length > 4, @"Han renders in both languages");
    NSData *one = [FaceclawFontRenderer renderCaption:font text:@"one two three four five six seven eight nine ten" size:18 width:100 gamma:1 maxLines:1 language:@""];
    Check(U16((const uint8_t *)one.bytes + 2) < 2 * step, @"truncated to one line");
    NSData *arTrunc = [FaceclawFontRenderer renderCaption:font text:@"مرحبا بكم في هذا المكان الجميل جدا اليوم" size:18 width:100 gamma:1 maxLines:1 language:@"ar"];
    Check(NSMaxRange(Ink(arTrunc)) >= 85, @"truncated RTL line stays right-aligned");
    // Wrapped RTL: one word per line, so every row must match the word drawn alone (break space must not shift it).
    NSData *word = [FaceclawFontRenderer renderCaption:font text:@"مرحبا" size:18 width:300 gamma:1 maxLines:1 language:@"ar"];
    int narrow = (int)Ink(word).length + 10, rowH = U16((const uint8_t *)word.bytes + 2);
    word = [FaceclawFontRenderer renderCaption:font text:@"مرحبا" size:18 width:narrow gamma:1 maxLines:1 language:@"ar"];
    NSData *wrapped = [FaceclawFontRenderer renderCaption:font text:@"مرحبا مرحبا مرحبا" size:18 width:narrow gamma:1 maxLines:3 language:@"ar"];
    Check(U16((const uint8_t *)wrapped.bytes + 2) == 3 * rowH, @"RTL wraps one word per line");
    for (int i = 0; i < 3; i++) {
        Check(NSMaxRange(InkRows(wrapped, i * rowH, (i + 1) * rowH)) >= (NSUInteger)narrow - 4, @"wrapped RTL row is flushed right");
        Check(memcmp((const uint8_t *)wrapped.bytes + 4 + i * rowH * narrow, (const uint8_t *)word.bytes + 4, rowH * narrow) == 0, @"wrapped RTL row matches the lone word");
    }
    Check([FaceclawFontRenderer renderCaption:font text:@"" size:18 width:100 gamma:1 maxLines:2 language:@"en"].length == (NSUInteger)(4 + 100 * step), @"empty text is one blank line");
    Check([FaceclawFontRenderer renderCaption:font text:@"x" size:18 width:0 gamma:1 maxLines:2 language:@"en"].length == 0, @"zero width rejected");
    Check([FaceclawFontRenderer renderCaption:@"/missing.ttf" text:@"x" size:18 width:10 gamma:1 maxLines:2 language:@"en"].length == 0, @"missing font rejected");
    printf("PASS: caption direction, line height, wrapping, truncation\n");
} return 0; }
`;

test('Core Text caption renderer (macOS only)', { skip: process.platform !== 'darwin' && 'needs xcrun clang and Core Text' }, () => {
  const root = resolve(__dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'faceclaw-caption-'));
  writeFileSync(join(dir, 'caption-test.m'), NATIVE_TEST);
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-framework', 'Foundation', '-framework', 'CoreText', '-framework', 'CoreGraphics',
    '-I', join(root, 'App_Resources/iOS/src'), join(dir, 'caption-test.m'), join(root, 'App_Resources/iOS/src/FaceclawFontRenderer.m'), '-o', join(dir, 'caption-test')], { stdio: 'inherit' });
  execFileSync(join(dir, 'caption-test'), [join(root, 'app/fonts/ttf')], { stdio: 'inherit' });
});
