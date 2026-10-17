const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

/**
 * Prebuilt native libraries the iOS app links, fetched at prepare time (the
 * Android build fetches the same sherpa-onnx release in app.gradle). Pinned by
 * sha256; the archive is cached under cacheDir, so CI can cache that folder.
 *
 * sherpa-onnx v1.13.0 (Android's version) ships static xcframeworks:
 * sherpa-onnx (its C API) and onnxruntime 1.17.1 (a CoreML-EP build, so the
 * app links CoreML). Only sherpa's c-api.h is kept, outside the frameworks:
 * NativeScript's metadata generator must not see the C++ headers.
 */
const SHERPA = {
  version: '1.13.0',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.0/sherpa-onnx-v1.13.0-ios-no-tts.tar.bz2',
  sha256: '316cc0712d2cd7c6ff9bc49d6e7b75c9f65c5ddf78edb075344c0642cfb48d13',
  bytes: 74430807,
  frameworks: {
    'sherpa-onnx.xcframework': 'build-ios-no-tts/sherpa-onnx.xcframework',
    'onnxruntime.xcframework': 'build-ios-no-tts/ios-onnxruntime/1.17.1/onnxruntime.xcframework',
  },
  header: 'build-ios-no-tts/sherpa-onnx.xcframework/Headers/sherpa-onnx/c-api/c-api.h',
};

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const part = `${file}.part`;
  fs.writeFileSync(part, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(part, file);
}

/** The cached archive, downloaded when missing; refuses any file whose sha256 differs. */
async function archive(dep, cacheDir) {
  const file = path.join(cacheDir, path.basename(dep.url));
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(file)) {
    console.log(`[ios-deps] Downloading ${dep.url}`);
    await download(dep.url, file);
  }
  const actual = sha256File(file);
  if (actual !== dep.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`${path.basename(file)}: sha256 ${actual}, expected ${dep.sha256}`);
  }
  return file;
}

/**
 * NativeScript decides "static, do not embed" by running `file` on each
 * slice's BinaryPath; onnxruntime's Info.plist has none (sherpa's does).
 */
function addBinaryPaths(plistFile) {
  const plist = fs.readFileSync(plistFile, 'utf8');
  if (plist.includes('<key>BinaryPath</key>')) return;
  fs.writeFileSync(plistFile, plist.replace(/(\s*)<key>LibraryPath<\/key>(\s*)<string>([^<]+)<\/string>/g,
    '$1<key>BinaryPath</key>$2<string>$3</string>$1<key>LibraryPath</key>$2<string>$3</string>'));
}

/** Unpacks the frameworks (headers stripped) and c-api.h into destination. */
function stage(dep, archiveFile, destination) {
  const scratch = fs.mkdtempSync(path.join(path.dirname(archiveFile), 'unpack-'));
  try {
    const members = [...Object.values(dep.frameworks)].map(member => `./${member}`);
    const tar = spawnSync('tar', ['-xjf', archiveFile, '-C', scratch, ...members], { stdio: 'inherit' });
    if (tar.status !== 0) throw new Error(`tar failed (${tar.status})`);
    const include = path.join(destination, 'include/sherpa-onnx/c-api');
    fs.mkdirSync(include, { recursive: true });
    fs.copyFileSync(path.join(scratch, dep.header), path.join(include, 'c-api.h'));
    for (const [name, member] of Object.entries(dep.frameworks)) {
      const target = path.join(destination, name);
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(path.join(scratch, member, 'Headers'), { recursive: true, force: true });
      addBinaryPaths(path.join(scratch, member, 'Info.plist'));
      fs.renameSync(path.join(scratch, member), target);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Idempotent: a stamp naming the archive's hash skips the unpack on later prepares. */
async function ensureIosNativeDeps(options = {}) {
  const destination = options.destination || path.join(root, 'native/kotlin/plugin/platforms/ios');
  const cacheDir = options.cacheDir || process.env.FACECLAW_IOS_DEPS_CACHE || path.join(root, 'native/kotlin/build/ios-deps');
  const dep = options.dep || SHERPA;
  const stamp = path.join(destination, '.sherpa-onnx.sha256');
  const staged = Object.keys(dep.frameworks).every(name => fs.existsSync(path.join(destination, name)));
  if (staged && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === dep.sha256) return;
  const file = await archive(dep, cacheDir);
  console.log(`[ios-deps] Staging sherpa-onnx ${dep.version} into ${destination}`);
  fs.mkdirSync(destination, { recursive: true });
  stage(dep, file, destination);
  fs.writeFileSync(stamp, `${dep.sha256}\n`);
}

module.exports = { SHERPA, ensureIosNativeDeps, addBinaryPaths, sha256File };
if (require.main === module) {
  ensureIosNativeDeps().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
