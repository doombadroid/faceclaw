// FaceclawSherpaCore.c on a Linux host, against sherpa-onnx's own release: run by
// tests/sherpa-host.cjs with the downloaded models. Prints one line per check.
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

int main(int argc, char **argv) {
    if (argc != 4) return 2;
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
    free(samples);
    return 0;
}
