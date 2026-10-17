const { buildKotlin, checkAndroidRuntime } = require('../../scripts/kotlin-build.cjs');
const { ensureIosNativeDeps } = require('../../scripts/ios-native-deps.cjs');

module.exports = function (hookArgs) {
  // NativeScript parses hooks with an older JavaScript parser; avoid optional chaining.
  const { platform, release } = hookArgs.prepareData;
  if (platform === 'android') checkAndroidRuntime();
  const kotlin = buildKotlin(platform, release ? 'release' : 'debug');
  // sherpa-onnx + onnxruntime xcframeworks, staged beside FaceclawKit in the plugin.
  return platform === 'ios' ? kotlin.then(() => ensureIosNativeDeps()) : kotlin;
};
