#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
/** sherpa-onnx's model loader for FaceclawKit (conforms to FaceclawKitIosSherpaLoader, declared in
 * the .m): on-device Moonshine / Whisper recognizers and the speaker-embedding (voice-print)
 * extractor over the C API. One instance serves the app. */
@interface FaceclawSherpa : NSObject
@end

/** Offline re-diarization of a saved 16 kHz mono WAV (Android's FaceclawDiarizer): pyannote
 * segmentation + the voice-print model + clustering, on a background queue. */
@interface FaceclawSherpaDiarizer : NSObject
- (instancetype)initWithSegmentationModel:(NSString *)segmentationModel embeddingModel:(NSString *)embeddingModel
                                  wavPath:(NSString *)wavPath numClusters:(NSInteger)numClusters threshold:(float)threshold;
/** progress (0-1) and completion arrive on the main queue; completion gets the turns as JSON
 * [{startMs, endMs, cluster}] sorted by start, or an error message. */
- (void)startWithProgress:(void (^)(double progress))progress
               completion:(void (^)(NSString *_Nullable turnsJson, NSString *_Nullable error))completion;
/** ponytail: sherpa-onnx ignores the progress callback's return, so the run finishes and then reports
 * "cancelled"; abort mid-run needs a sherpa that honours it. */
- (void)cancel;
@end
NS_ASSUME_NONNULL_END
