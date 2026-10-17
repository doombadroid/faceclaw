// The sherpa-onnx C API calls behind FaceclawSherpa.m, in plain C so they also build
// and run on a Linux host against sherpa-onnx's own release (tests/sherpa-host.cjs).
// Not in module.modulemap: NativeScript's metadata never sees sherpa's types.
#pragma once
#include <stdint.h>
#include "sherpa-onnx/c-api/c-api.h"

/** Moonshine (encoder_model.ort, decoder_model_merged.ort, tokens.txt) or Whisper base.en
 * (int8) from model_dir, with Android's settings (AndroidSpeechEngines.kt); NULL when the
 * files are missing or will not load. */
const SherpaOnnxOfflineRecognizer *faceclaw_sherpa_recognizer(const char *model_dir, int whisper);

/** The trimmed text for n 16 kHz float samples; malloc'd (the caller frees), never NULL. */
char *faceclaw_sherpa_recognize(const SherpaOnnxOfflineRecognizer *recognizer, const float *samples, int32_t n);
