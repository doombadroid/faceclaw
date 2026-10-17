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

/** The speaker-embedding extractor (Android's FaceclawSpeakerId settings); NULL when it will not load. */
const SherpaOnnxSpeakerEmbeddingExtractor *faceclaw_sherpa_embedder(const char *model_path);

/** Writes the raw embedding of n 16 kHz samples into out (up to capacity floats); returns
 * its dimension, or 0 when the input is too short to embed. */
int32_t faceclaw_sherpa_embed(const SherpaOnnxSpeakerEmbeddingExtractor *extractor, const float *samples, int32_t n,
                              float *out, int32_t capacity);

/** Offline diarization (pyannote segmentation + the embedding model + fast clustering) with
 * Android's FaceclawDiarizer settings; clusters <= 0 lets the threshold decide. NULL when the
 * models will not load. */
const SherpaOnnxOfflineSpeakerDiarization *faceclaw_sherpa_diarizer(const char *segmentation_model, const char *embedding_model,
                                                                    int32_t clusters, float threshold);

/** Speaker turns of n 16 kHz samples as JSON [{"startMs":..,"endMs":..,"cluster":..}] sorted by
 * start, malloc'd (the caller frees); NULL when it failed. sherpa-onnx v1.13.0 ignores the progress
 * callback's return value, so a cancel only takes effect once the run ends. */
char *faceclaw_sherpa_diarize(const SherpaOnnxOfflineSpeakerDiarization *diarizer, const float *samples, int32_t n,
                              SherpaOnnxOfflineSpeakerDiarizationProgressCallback progress, void *arg);
