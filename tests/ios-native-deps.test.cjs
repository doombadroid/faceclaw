const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SHERPA, ensureIosNativeDeps, sha256File } = require('../scripts/ios-native-deps.cjs');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// The release's layout in miniature: onnxruntime's Info.plist has no BinaryPath, sherpa's does.
function fakeRelease(dir) {
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
  const sherpa = SHERPA.frameworks['sherpa-onnx.xcframework'], ort = SHERPA.frameworks['onnxruntime.xcframework'];
  write(`${sherpa}/Info.plist`, '<dict><key>BinaryPath</key><string>sherpa-onnx.a</string><key>LibraryPath</key><string>sherpa-onnx.a</string></dict>');
  write(`${sherpa}/ios-arm64/sherpa-onnx.a`, 'sherpa');
  write(SHERPA.header, '/* c api */');
  write(`${sherpa}/Headers/sherpa-onnx/c-api/cxx-api.h`, 'class X {};');
  write(`${ort}/Info.plist`, '<dict>\n\t<key>LibraryIdentifier</key>\n\t<string>ios-arm64</string>\n\t<key>LibraryPath</key>\n\t<string>onnxruntime.a</string>\n</dict>');
  write(`${ort}/ios-arm64/onnxruntime.a`, 'ort');
  write(`${ort}/Headers/onnxruntime_cxx_api.h`, 'namespace Ort {}');
  write('build-ios-no-tts/unrelated.txt', 'not extracted');
}

test('the sherpa-onnx xcframeworks are verified, unpacked without C++ headers, and staged once', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-ios-deps-'));
  try {
    const tree = path.join(work, 'tree'), cacheDir = path.join(work, 'cache'), destination = path.join(work, 'ios');
    fakeRelease(tree);
    fs.mkdirSync(cacheDir);
    const archive = path.join(cacheDir, path.basename(SHERPA.url));
    assert.equal(spawnSync('tar', ['-cjf', archive, '-C', tree, '.']).status, 0);
    const dep = { ...SHERPA, sha256: sha256File(archive) };
    await ensureIosNativeDeps({ dep, cacheDir, destination });
    assert.deepEqual(fs.readdirSync(destination).sort(), ['.sherpa-onnx.sha256', 'include', 'onnxruntime.xcframework', 'sherpa-onnx.xcframework']);
    assert.equal(fs.readFileSync(path.join(destination, 'include/sherpa-onnx/c-api/c-api.h'), 'utf8'), '/* c api */');
    for (const name of Object.keys(SHERPA.frameworks)) assert.equal(fs.existsSync(path.join(destination, name, 'Headers')), false, name);
    assert.ok(fs.existsSync(path.join(destination, 'onnxruntime.xcframework/ios-arm64/onnxruntime.a')));
    // NativeScript runs `file` on BinaryPath to decide the frameworks are static (not embedded).
    assert.match(fs.readFileSync(path.join(destination, 'onnxruntime.xcframework/Info.plist'), 'utf8'),
      /<key>BinaryPath<\/key>\s*<string>onnxruntime.a<\/string>\s*<key>LibraryPath<\/key>\s*<string>onnxruntime.a<\/string>/);
    assert.equal((fs.readFileSync(path.join(destination, 'sherpa-onnx.xcframework/Info.plist'), 'utf8').match(/BinaryPath/g) || []).length, 1);
    // A second prepare is a no-op, even with the cached archive gone.
    fs.rmSync(archive);
    await ensureIosNativeDeps({ dep, cacheDir, destination });
    // A tampered cache is refused and deleted.
    fs.rmSync(path.join(destination, '.sherpa-onnx.sha256'));
    fs.writeFileSync(archive, 'tampered');
    await assert.rejects(ensureIosNativeDeps({ dep, cacheDir, destination }), /sha256/);
    assert.equal(fs.existsSync(archive), false);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('the pinned release is Android\'s sherpa-onnx version, and the hook stages it for iOS only', () => {
  assert.match(read('App_Resources/Android/app.gradle'), new RegExp(`faceclawSherpaOnnxVersion = "${SHERPA.version.replace(/\./g, '\\.')}"`));
  assert.ok(SHERPA.url.includes(`/v${SHERPA.version}/`));
  assert.match(SHERPA.sha256, /^[0-9a-f]{64}$/);
  const hook = read('scripts/hooks/faceclaw-kotlin.before-prepare.js');
  assert.equal(read('hooks/before-prepare/faceclaw-kotlin.js'), hook);
  assert.match(hook, /platform === 'ios' \? kotlin\.then\(\(\) => ensureIosNativeDeps\(\)\)/);
  assert.doesNotMatch(hook, /\?\.|\?\?/, 'NativeScript parses hooks with an older parser');
});

test('the app links CoreML for onnxruntime and finds c-api.h outside the frameworks', () => {
  const xcconfig = read('App_Resources/iOS/build.xcconfig');
  assert.match(xcconfig.match(/^OTHER_LDFLAGS = (.*)$/m)[1], /-framework CoreML(\s|$)/);
  assert.match(xcconfig.match(/^OTHER_CFLAGS = (.*)$/m)[1], /-I"\$\(SRCROOT\)\/\.\.\/\.\.\/native\/kotlin\/plugin\/platforms\/ios\/include"/);
});
