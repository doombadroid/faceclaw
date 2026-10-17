#import "FaceclawSherpa.h"
#import "FaceclawLog.h"
#import <AVFoundation/AVFoundation.h>
#import <FaceclawKit/FaceclawKit.h>
#include "FaceclawSherpaCore.h"
// FaceclawParakeet.swift. The header is named after the product, which NativeScript names after the
// checkout folder: CI checks out to faceclaw (faceclaw-ios-build's build.yml).
// The generated header also declares @nativescript/core's NativeScriptViewFactory, which conforms
// to this protocol; without it first the header does not compile (CI build 35).
#import "NativeScriptEmbedder.h"
#import "faceclaw-Swift.h"

/** One offline recognizer; the C object is freed on close or dealloc. */
@interface FaceclawSherpaRecognizer : NSObject <FaceclawKitIosPcmRecognizer>
- (instancetype)initWithRecognizer:(const SherpaOnnxOfflineRecognizer *)recognizer;
@end

@implementation FaceclawSherpaRecognizer {
    const SherpaOnnxOfflineRecognizer *_recognizer;
}

- (instancetype)initWithRecognizer:(const SherpaOnnxOfflineRecognizer *)recognizer {
    if (!(self = [super init])) return nil;
    _recognizer = recognizer;
    return self;
}

- (NSString *)recognizeSamples:(NSData *)samples {
    @synchronized (self) {
        if (!_recognizer) return @"";
        char *text = faceclaw_sherpa_recognize(_recognizer, samples.bytes, (int32_t)(samples.length / sizeof(float)));
        NSString *result = text ? (@(text) ?: @"") : @"";
        free(text);
        return result;
    }
}

- (void)close {
    @synchronized (self) {
        if (_recognizer) SherpaOnnxDestroyOfflineRecognizer(_recognizer);
        _recognizer = NULL;
    }
}

- (void)dealloc {
    [self close];
}

@end

/** FluidAudio's Parakeet (FaceclawParakeet.swift) as a recognizer. The model stays loaded for the
 * app, so close does nothing: IosOnDeviceTranscriber closes its recognizer after every capture. */
@interface FaceclawParakeetRecognizer : NSObject <FaceclawKitIosPcmRecognizer>
- (instancetype)initWithModelDir:(NSString *)modelDir;
@end

@implementation FaceclawParakeetRecognizer {
    NSString *_modelDir;
}

- (instancetype)initWithModelDir:(NSString *)modelDir {
    if (!(self = [super init])) return nil;
    _modelDir = [modelDir copy];
    return self;
}

- (NSString *)recognizeSamples:(NSData *)samples {
    return [FaceclawParakeet recognizeSamples:samples dir:_modelDir];
}

- (void)close {
}

@end

/** One speaker-embedding extractor; the C object is freed on close or dealloc. */
@interface FaceclawSherpaVoicePrinter : NSObject <FaceclawKitIosVoicePrinter>
- (instancetype)initWithExtractor:(const SherpaOnnxSpeakerEmbeddingExtractor *)extractor;
@end

@implementation FaceclawSherpaVoicePrinter {
    const SherpaOnnxSpeakerEmbeddingExtractor *_extractor;
}

- (instancetype)initWithExtractor:(const SherpaOnnxSpeakerEmbeddingExtractor *)extractor {
    if (!(self = [super init])) return nil;
    _extractor = extractor;
    return self;
}

- (NSData *)embedSamples:(NSData *)samples {
    @synchronized (self) {
        if (!_extractor) return nil;
        float embedding[1024];
        int32_t dim = faceclaw_sherpa_embed(_extractor, samples.bytes, (int32_t)(samples.length / sizeof(float)), embedding, 1024);
        return dim > 0 ? [NSData dataWithBytes:embedding length:(NSUInteger)dim * sizeof(float)] : nil;
    }
}

- (void)close {
    @synchronized (self) {
        if (_extractor) SherpaOnnxDestroySpeakerEmbeddingExtractor(_extractor);
        _extractor = NULL;
    }
}

- (void)dealloc {
    [self close];
}

@end

@interface FaceclawSherpa () <FaceclawKitIosSherpaLoader>
@end

@implementation FaceclawSherpa

- (id<FaceclawKitIosPcmRecognizer>)recognizerModelDir:(NSString *)modelDir whisper:(BOOL)whisper {
    // Called on FaceclawKit's worker thread, so the (blocking) model load is fine here.
    if ([FaceclawParakeet isParakeetDir:modelDir]) {
        if ([FaceclawParakeet loadDir:modelDir]) return [[FaceclawParakeetRecognizer alloc] initWithModelDir:modelDir];
        [FaceclawLog log:[NSString stringWithFormat:@"FaceclawSherpa: the Parakeet model in %@ did not load", modelDir]];
        return nil;
    }
    const SherpaOnnxOfflineRecognizer *recognizer = faceclaw_sherpa_recognizer(modelDir.fileSystemRepresentation, whisper ? 1 : 0);
    if (!recognizer) {
        [FaceclawLog log:[NSString stringWithFormat:@"FaceclawSherpa: no %@ model in %@", whisper ? @"Whisper" : @"Moonshine", modelDir]];
        return nil;
    }
    return [[FaceclawSherpaRecognizer alloc] initWithRecognizer:recognizer];
}

- (id<FaceclawKitIosVoicePrinter>)voicePrinterModelPath:(NSString *)modelPath {
    const SherpaOnnxSpeakerEmbeddingExtractor *extractor = faceclaw_sherpa_embedder(modelPath.fileSystemRepresentation);
    if (!extractor) {
        [FaceclawLog log:[NSString stringWithFormat:@"FaceclawSherpa: no voice-print model at %@", modelPath]];
        return nil;
    }
    return [[FaceclawSherpaVoicePrinter alloc] initWithExtractor:extractor];
}

@end

@implementation FaceclawSherpaDiarizer {
    NSString *_segmentationModel, *_embeddingModel, *_wavPath;
    NSInteger _numClusters;
    float _threshold;
    void (^_progress)(double);
    volatile BOOL _cancelled;
}

- (instancetype)initWithSegmentationModel:(NSString *)segmentationModel embeddingModel:(NSString *)embeddingModel
                                  wavPath:(NSString *)wavPath numClusters:(NSInteger)numClusters threshold:(float)threshold {
    if (!(self = [super init])) return nil;
    _segmentationModel = [segmentationModel copy];
    _embeddingModel = [embeddingModel copy];
    _wavPath = [wavPath copy];
    _numClusters = numClusters;
    _threshold = threshold;
    return self;
}

static int32_t FaceclawDiarizeProgress(int32_t done, int32_t total, void *arg) {
    FaceclawSherpaDiarizer *owner = (__bridge FaceclawSherpaDiarizer *)arg;
    void (^progress)(double) = owner->_progress;
    double fraction = total > 0 ? MIN(1.0, MAX(0.0, (double)done / total)) : 0;
    if (progress) dispatch_async(dispatch_get_main_queue(), ^{ progress(fraction); });
    return owner->_cancelled ? 1 : 0;
}

/** The recording as 16 kHz mono floats (AVAudioFile reads the WAV header), or nil with *error set. */
- (NSData *)readSamples:(NSString **)error {
    NSError *failure = nil;
    AVAudioFile *file = [[AVAudioFile alloc] initForReading:[NSURL fileURLWithPath:_wavPath] error:&failure];
    if (!file) { *error = failure.localizedDescription ?: @"Could not open the recording."; return nil; }
    AVAudioFormat *format = file.processingFormat;
    if (format.sampleRate != 16000 || format.channelCount != 1) { *error = @"Only 16 kHz mono recordings can be re-analyzed."; return nil; }
    AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:(AVAudioFrameCount)file.length];
    if (!buffer || ![file readIntoBuffer:buffer error:&failure]) { *error = failure.localizedDescription ?: @"Could not read the recording."; return nil; }
    return [NSData dataWithBytes:buffer.floatChannelData[0] length:buffer.frameLength * sizeof(float)];
}

- (void)startWithProgress:(void (^)(double))progress completion:(void (^)(NSString *, NSString *))completion {
    _progress = [progress copy];
    void (^done)(NSString *, NSString *) = [completion copy];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSString *error = nil, *turns = nil;
        NSData *samples = [self readSamples:&error];
        if (samples) {
            const SherpaOnnxOfflineSpeakerDiarization *diarizer = faceclaw_sherpa_diarizer(
                self->_segmentationModel.fileSystemRepresentation, self->_embeddingModel.fileSystemRepresentation,
                (int32_t)self->_numClusters, self->_threshold);
            if (!diarizer) error = @"The re-diarization models could not be loaded. Download them again.";
            else {
                char *json = faceclaw_sherpa_diarize(diarizer, samples.bytes, (int32_t)(samples.length / sizeof(float)),
                                                     FaceclawDiarizeProgress, (__bridge void *)self);
                SherpaOnnxDestroyOfflineSpeakerDiarization(diarizer);
                if (self->_cancelled) error = @"Re-diarization cancelled.";
                else if (json) turns = @(json);
                else error = @"Re-diarization failed.";
                free(json);
            }
        }
        dispatch_async(dispatch_get_main_queue(), ^{ done(turns, error); });
    });
}

- (void)cancel {
    _cancelled = YES;
}

@end
