#include "FaceclawSherpaCore.h"

#include <ctype.h>
#include <math.h>
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

const SherpaOnnxSpeakerEmbeddingExtractor *faceclaw_sherpa_embedder(const char *model_path) {
    if (access(model_path, R_OK) != 0) return NULL;
    SherpaOnnxSpeakerEmbeddingExtractorConfig config;
    memset(&config, 0, sizeof config);
    config.model = model_path;
    config.num_threads = 1;
    config.provider = "cpu";
    return SherpaOnnxCreateSpeakerEmbeddingExtractor(&config);
}

int32_t faceclaw_sherpa_embed(const SherpaOnnxSpeakerEmbeddingExtractor *extractor, const float *samples, int32_t n,
                              float *out, int32_t capacity) {
    if (!extractor || n <= 0) return 0;
    const SherpaOnnxOnlineStream *stream = SherpaOnnxSpeakerEmbeddingExtractorCreateStream(extractor);
    if (!stream) return 0;
    SherpaOnnxOnlineStreamAcceptWaveform(stream, SAMPLE_RATE, samples, n);
    SherpaOnnxOnlineStreamInputFinished(stream);
    int32_t dim = 0;
    if (SherpaOnnxSpeakerEmbeddingExtractorIsReady(extractor, stream)) {
        const float *embedding = SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(extractor, stream);
        dim = SherpaOnnxSpeakerEmbeddingExtractorDim(extractor);
        if (embedding && dim > 0 && dim <= capacity) memcpy(out, embedding, (size_t)dim * sizeof(float));
        else dim = 0;
        if (embedding) SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(embedding);
    }
    SherpaOnnxDestroyOnlineStream(stream);
    return dim;
}

const SherpaOnnxOfflineSpeakerDiarization *faceclaw_sherpa_diarizer(const char *segmentation_model, const char *embedding_model,
                                                                    int32_t clusters, float threshold) {
    if (access(segmentation_model, R_OK) != 0 || access(embedding_model, R_OK) != 0) return NULL;
    SherpaOnnxOfflineSpeakerDiarizationConfig config;
    memset(&config, 0, sizeof config);
    config.segmentation.pyannote.model = segmentation_model;
    config.segmentation.num_threads = 1;
    config.segmentation.provider = "cpu";
    config.embedding.model = embedding_model;
    config.embedding.num_threads = 1;
    config.embedding.provider = "cpu";
    config.clustering.num_clusters = clusters > 0 ? clusters : -1;
    config.clustering.threshold = threshold > 0 ? threshold : 0.5f;
    config.min_duration_on = 0.3f;
    config.min_duration_off = 0.5f;
    return SherpaOnnxCreateOfflineSpeakerDiarization(&config);
}

char *faceclaw_sherpa_diarize(const SherpaOnnxOfflineSpeakerDiarization *diarizer, const float *samples, int32_t n,
                              SherpaOnnxOfflineSpeakerDiarizationProgressCallback progress, void *arg) {
    if (!diarizer) return NULL;
    const SherpaOnnxOfflineSpeakerDiarizationResult *result =
        SherpaOnnxOfflineSpeakerDiarizationProcessWithCallback(diarizer, samples, n, progress, arg);
    if (!result) return NULL;
    int32_t count = SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(result);
    const SherpaOnnxOfflineSpeakerDiarizationSegment *segments =
        count > 0 ? SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime(result) : NULL;
    size_t size = 3 + (size_t)(count > 0 ? count : 0) * 96;  // one turn is at most ~64 characters
    char *json = malloc(size);
    if (json) {
        size_t used = (size_t)snprintf(json, size, "[");
        for (int32_t i = 0; segments && i < count; i++) {
            used += (size_t)snprintf(json + used, size - used, "%s{\"startMs\":%ld,\"endMs\":%ld,\"cluster\":%d}", i ? "," : "",
                                     lroundf(segments[i].start * 1000), lroundf(segments[i].end * 1000), (int)segments[i].speaker);
        }
        snprintf(json + used, size - used, "]");
    }
    if (segments) SherpaOnnxOfflineSpeakerDiarizationDestroySegment(segments);
    SherpaOnnxOfflineSpeakerDiarizationDestroyResult(result);
    return json;
}
