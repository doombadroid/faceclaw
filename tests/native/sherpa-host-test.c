// FaceclawSherpaCore.c on a Linux host, against sherpa-onnx's own release: run by
// tests/sherpa-host.cjs with the downloaded models. Prints one line per check.
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "FaceclawSherpaCore.h"

static float *read_wav(const char *path, int32_t *n) {
    FILE *file = fopen(path, "rb");
    if (!file) return NULL;
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    fseek(file, 44, SEEK_SET);  // the fixture is a canonical 16 kHz mono PCM16 WAV
    *n = (int32_t)((size - 44) / 2);
    short *pcm = malloc((size_t)*n * 2);
    float *out = malloc((size_t)*n * 4);
    if (!pcm || !out || fread(pcm, 2, (size_t)*n, file) != (size_t)*n) exit(2);
    fclose(file);
    for (int32_t i = 0; i < *n; i++) out[i] = pcm[i] / 32768.0f;
    free(pcm);
    return out;
}

static double cosine(const float *a, const float *b, int32_t dim) {
    double dot = 0, na = 0, nb = 0;
    for (int32_t i = 0; i < dim; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / sqrt(na * nb);
}

static int progress_calls = 0;
static int32_t on_progress(int32_t done, int32_t total, void *arg) {
    (void)done; (void)total; (void)arg;
    progress_calls++;
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 8) return 2;
    const char *moonshine = argv[1], *whisper = argv[2];
    int32_t n = 0;
    float *samples = read_wav(argv[3], &n);
    if (!samples) return 2;
    for (int kind = 0; kind < 2; kind++) {
        const SherpaOnnxOfflineRecognizer *recognizer = faceclaw_sherpa_recognizer(kind ? whisper : moonshine, kind);
        if (!recognizer) { printf("%s: no recognizer\n", kind ? "whisper" : "moonshine"); return 1; }
        char *text = faceclaw_sherpa_recognize(recognizer, samples, n);
        printf("%s: %s\n", kind ? "whisper" : "moonshine", text);
        free(text);
        char *empty = faceclaw_sherpa_recognize(recognizer, samples, 0);
        printf("%s empty: [%s]\n", kind ? "whisper" : "moonshine", empty);
        free(empty);
        SherpaOnnxDestroyOfflineRecognizer(recognizer);
    }
    printf("missing: %s\n", faceclaw_sherpa_recognizer("/nonexistent", 0) ? "loaded" : "null");

    // Voice-prints: two halves of one speaker's recording, and someone else.
    int32_t one_n = 0, four_n = 0;
    float *one = read_wav(argv[4], &one_n), *four = read_wav(argv[5], &four_n);
    const SherpaOnnxSpeakerEmbeddingExtractor *extractor = faceclaw_sherpa_embedder(argv[6]);
    if (!extractor || !one || !four) { printf("embedder: none\n"); return 1; }
    float a[1024], b[1024], c[1024];
    int32_t dim = faceclaw_sherpa_embed(extractor, one, one_n / 2, a, 1024);
    faceclaw_sherpa_embed(extractor, one + one_n / 2, one_n - one_n / 2, b, 1024);
    faceclaw_sherpa_embed(extractor, four, 16000 * 4, c, 1024);
    printf("embed dim: %d\n", dim);
    printf("same speaker: %.2f\n", cosine(a, b, dim));
    printf("other speaker: %.2f\n", cosine(a, c, dim));
    printf("too small: %d\n", faceclaw_sherpa_embed(extractor, samples, n, a, 8));
    SherpaOnnxDestroySpeakerEmbeddingExtractor(extractor);

    // Diarization of sherpa-onnx's own four-speaker sample.
    const SherpaOnnxOfflineSpeakerDiarization *diarizer = faceclaw_sherpa_diarizer(argv[7], argv[6], 4, 0.5f);
    if (!diarizer) { printf("diarizer: none\n"); return 1; }
    char *turns = faceclaw_sherpa_diarize(diarizer, four, four_n, on_progress, NULL);
    printf("turns: %s\n", turns ? turns : "(null)");
    printf("progress calls: %d\n", progress_calls);
    free(turns);
    SherpaOnnxDestroyOfflineSpeakerDiarization(diarizer);
    printf("diarizer missing: %s\n", faceclaw_sherpa_diarizer("/none", argv[6], 0, 0) ? "loaded" : "null");
    free(four);
    free(one);
    free(samples);
    return 0;
}
