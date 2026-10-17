// Builds the iOS shim's C core (App_Resources/iOS/src/FaceclawSherpaCore.c) on a Linux x64
// host against sherpa-onnx's own v1.13.0 shared library and runs it on the app's real models,
// so the config field mapping is checked without a Mac. Manual (about 350 MB of downloads,
// cached): node tests/sherpa-host.cjs. Needs gcc; run `node scripts/ios-native-deps.cjs`
// first for c-api.h.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const { sha256File } = require('../scripts/ios-native-deps.cjs');

const root = path.resolve(__dirname, '..');
const cache = process.env.FACECLAW_SHERPA_HOST_CACHE || path.join(root, 'native/kotlin/build/sherpa-host');
const LIB = { url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.0/sherpa-onnx-v1.13.0-linux-x64-shared-no-tts-lib.tar.bz2',
  sha256: '784c191893c77987e8ea2c2dec152649033e6b3128affb1a7c1b6974182fafb0' };
const WAV = { url: 'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base.en/resolve/main/test_wavs/0.wav',
  sha256: '6bc58a4efdf20daac252b6b1502632601a71efe0308f6757dc1eda34891a7e4f' };

async function fetchPinned(url, sha256, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  assert.equal(sha256File(file), sha256, file);
  return file;
}

async function main() {
  const include = path.join(root, 'native/kotlin/plugin/platforms/ios/include');
  assert.ok(fs.existsSync(path.join(include, 'sherpa-onnx/c-api/c-api.h')), 'run node scripts/ios-native-deps.cjs first');
  const { ASR_MODELS } = loader({}, { './model-downloader': {} })('app/native/asr-model.ts');
  const dirs = {};
  for (const [id, model] of Object.entries(ASR_MODELS)) {
    dirs[id] = path.join(cache, model.dirName);
    for (const file of model.files) await fetchPinned(`${model.baseUrl}${file.name}`, file.sha256, path.join(dirs[id], file.name));
  }
  const wav = await fetchPinned(WAV.url, WAV.sha256, path.join(cache, '0.wav'));
  const archive = await fetchPinned(LIB.url, LIB.sha256, path.join(cache, path.basename(LIB.url)));
  execFileSync('tar', ['-xjf', archive, '-C', cache]);
  const lib = path.join(cache, 'sherpa-onnx-v1.13.0-linux-x64-shared-no-tts-lib/lib');
  const exe = path.join(cache, 'sherpa-host-test');
  const src = path.join(root, 'App_Resources/iOS/src');
  execFileSync('gcc', ['-std=c11', '-D_DEFAULT_SOURCE', '-Wall', '-Werror', '-I', src, '-I', include,
    path.join(root, 'tests/native/sherpa-host-test.c'), path.join(src, 'FaceclawSherpaCore.c'),
    '-L', lib, '-lsherpa-onnx-c-api', `-Wl,-rpath,${lib}`, '-o', exe], { stdio: 'inherit' });
  const output = execFileSync(exe, [dirs.moonshine, dirs['whisper-base-en'], wav], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(output);
  for (const kind of ['moonshine', 'whisper']) {
    assert.match(output, new RegExp(`^${kind}: After early nightfall,? the yellow lamps would light up here and there the squalid quarter of the brothels\\.$`, 'm'));
    assert.match(output, new RegExp(`^${kind} empty: \\[\\]$`, 'm'));
  }
  assert.match(output, /^missing: null$/m);
  console.log('sherpa host check passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
