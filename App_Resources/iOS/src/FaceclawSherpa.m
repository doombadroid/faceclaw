#import "FaceclawSherpa.h"
#import "FaceclawLog.h"
#import <FaceclawKit/FaceclawKit.h>
#include "FaceclawSherpaCore.h"

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

@interface FaceclawSherpa () <FaceclawKitIosSherpaLoader>
@end

@implementation FaceclawSherpa

- (id<FaceclawKitIosPcmRecognizer>)recognizerModelDir:(NSString *)modelDir whisper:(BOOL)whisper {
    const SherpaOnnxOfflineRecognizer *recognizer = faceclaw_sherpa_recognizer(modelDir.fileSystemRepresentation, whisper ? 1 : 0);
    if (!recognizer) {
        [FaceclawLog log:[NSString stringWithFormat:@"FaceclawSherpa: no %@ model in %@", whisper ? @"Whisper" : @"Moonshine", modelDir]];
        return nil;
    }
    return [[FaceclawSherpaRecognizer alloc] initWithRecognizer:recognizer];
}

@end
