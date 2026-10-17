#include "FaceclawSherpaCore.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define SAMPLE_RATE 16000

static void join(char *out, size_t size, const char *dir, const char *name) {
    snprintf(out, size, "%s/%s", dir, name);
}

const SherpaOnnxOfflineRecognizer *faceclaw_sherpa_recognizer(const char *model_dir, int whisper) {
    char encoder[1024], decoder[1024], tokens[1024];
    join(tokens, sizeof tokens, model_dir, whisper ? "base.en-tokens.txt" : "tokens.txt");
    if (access(tokens, R_OK) != 0) return NULL;
    SherpaOnnxOfflineRecognizerConfig config;
    memset(&config, 0, sizeof config);
    config.feat_config.sample_rate = SAMPLE_RATE;
    config.feat_config.feature_dim = 80;
    config.model_config.tokens = tokens;
    config.model_config.num_threads = 1;
    config.model_config.provider = "cpu";
    config.decoding_method = "greedy_search";
    if (whisper) {
        join(encoder, sizeof encoder, model_dir, "base.en-encoder.int8.onnx");
        join(decoder, sizeof decoder, model_dir, "base.en-decoder.int8.onnx");
        config.model_config.whisper.encoder = encoder;
        config.model_config.whisper.decoder = decoder;
        config.model_config.whisper.language = "en";
        config.model_config.whisper.task = "transcribe";
        config.model_config.whisper.tail_paddings = 1000;  // the Java builder's default
    } else {
        join(encoder, sizeof encoder, model_dir, "encoder_model.ort");
        join(decoder, sizeof decoder, model_dir, "decoder_model_merged.ort");
        config.model_config.moonshine.encoder = encoder;
        config.model_config.moonshine.merged_decoder = decoder;
    }
    return SherpaOnnxCreateOfflineRecognizer(&config);
}

static char *trimmed_copy(const char *text) {
    if (!text) text = "";
    while (*text && isspace((unsigned char)*text)) text++;
    size_t length = strlen(text);
    while (length > 0 && isspace((unsigned char)text[length - 1])) length--;
    char *out = malloc(length + 1);
    if (!out) return NULL;
    memcpy(out, text, length);
    out[length] = 0;
    return out;
}

char *faceclaw_sherpa_recognize(const SherpaOnnxOfflineRecognizer *recognizer, const float *samples, int32_t n) {
    if (!recognizer || n <= 0) return trimmed_copy("");
    const SherpaOnnxOfflineStream *stream = SherpaOnnxCreateOfflineStream(recognizer);
    if (!stream) return trimmed_copy("");
    SherpaOnnxAcceptWaveformOffline(stream, SAMPLE_RATE, samples, n);
    SherpaOnnxDecodeOfflineStream(recognizer, stream);
    const SherpaOnnxOfflineRecognizerResult *result = SherpaOnnxGetOfflineStreamResult(stream);
    char *text = trimmed_copy(result ? result->text : "");
    if (result) SherpaOnnxDestroyOfflineRecognizerResult(result);
    SherpaOnnxDestroyOfflineStream(stream);
    return text;
}
