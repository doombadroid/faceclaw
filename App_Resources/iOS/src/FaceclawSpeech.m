#import "FaceclawSpeech.h"
#import "FaceclawLc3Decoder.h"
#import "FaceclawSpeechTranscript.h"
#import "FaceclawLog.h"
#import <FaceclawKit/FaceclawKit.h>
#import <Speech/Speech.h>
#import <AVFoundation/AVFoundation.h>
#import <math.h>

@interface FaceclawSpeech ()
@property(nonatomic, strong) SFSpeechRecognizer *recognizer;
// Atomic: replaced on the main queue at a continuous roll, read on audioQueue.
@property(atomic, strong) SFSpeechAudioBufferRecognitionRequest *request;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic, strong) FaceclawLc3Decoder *decoder;
@property(nonatomic, strong) dispatch_queue_t audioQueue;
@property(atomic) NSUInteger generation;
@property(nonatomic) NSUInteger pendingPackets;
@property(atomic) BOOL accepting;
@property(nonatomic) BOOL pcmOutput;
@property(nonatomic, strong) AVAudioEngine *phoneEngine;
@property(nonatomic) BOOL phoneTapInstalled;
@property(nonatomic) BOOL phoneSessionActive;
@property(nonatomic, strong) id interruptionObserver;
@property(nonatomic, copy) NSString *bestText;
@property(nonatomic, strong) FaceclawSpeechTranscript *transcript;
@property(atomic, strong) FaceclawKitVoiceEndpointDetector *endpointDetector;
@property(nonatomic) BOOL endpointing;
@property(nonatomic, strong) NSDate *taskStarted;
@property(nonatomic) NSUInteger fastErrors;
// Set on the main queue at start and end, appended on audioQueue.
@property(atomic, strong) NSMutableData *recording;
@end
/** Resamples one tap buffer to 16 kHz mono PCM16LE. Called on the serial
 * audio queue; the converter keeps its filter state between buffers. */
static NSData *resampleToPcm(AVAudioConverter *converter, AVAudioPCMBuffer *input) {
    AVAudioFormat *format = converter.outputFormat;
    AVAudioFrameCount capacity = (AVAudioFrameCount)ceil(input.frameLength * format.sampleRate / input.format.sampleRate) + 32;
    AVAudioPCMBuffer *output = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:capacity];
    __block BOOL supplied = NO;
    NSError *error = nil;
    AVAudioConverterOutputStatus status = [converter convertToBuffer:output error:&error
        withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount count, AVAudioConverterInputStatus *inputStatus) {
            // NoDataNow (not EndOfStream) leaves the stream open for the next buffer.
            if (supplied) { *inputStatus = AVAudioConverterInputStatus_NoDataNow; return nil; }
            supplied = YES; *inputStatus = AVAudioConverterInputStatus_HaveData; return input;
        }];
    if (status == AVAudioConverterOutputStatus_Error || !output.frameLength) return nil;
    return [NSData dataWithBytes:output.int16ChannelData[0] length:output.frameLength * sizeof(int16_t)];
}
/** Writes 16 kHz mono PCM16LE as Documents/voice-recordings/voice-<time>.wav.
 * ponytail: the capture is held in memory (~32 KB/s, as on Android); stream to
 * the file if hour-long continuous recordings matter. */
static void writeWav(NSData *pcm) {
    NSFileManager *files = NSFileManager.defaultManager;
    NSURL *folder = [[files URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"voice-recordings" isDirectory:YES];
    NSError *error = nil;
    if (![files createDirectoryAtURL:folder withIntermediateDirectories:YES attributes:nil error:&error]) {
        [FaceclawLog log:[NSString stringWithFormat:@"Voice recording: %@", error.localizedDescription]];
        return;
    }
    NSDateFormatter *formatter = [NSDateFormatter new];
    formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    formatter.dateFormat = @"yyyyMMdd-HHmmss-SSS";
    NSURL *file = [folder URLByAppendingPathComponent:[NSString stringWithFormat:@"voice-%@.wav", [formatter stringFromDate:[NSDate date]]]];
    // The canonical 44-byte header; iOS devices are little-endian, as WAV is.
    uint32_t dataSize = (uint32_t)pcm.length, riffSize = 36 + dataSize, fmtSize = 16, rate = 16000, byteRate = 32000;
    uint16_t encoding = 1, channels = 1, blockAlign = 2, bits = 16;
    NSMutableData *wav = [NSMutableData dataWithCapacity:44 + pcm.length];
    [wav appendBytes:"RIFF" length:4]; [wav appendBytes:&riffSize length:4]; [wav appendBytes:"WAVEfmt " length:8];
    [wav appendBytes:&fmtSize length:4]; [wav appendBytes:&encoding length:2]; [wav appendBytes:&channels length:2];
    [wav appendBytes:&rate length:4]; [wav appendBytes:&byteRate length:4]; [wav appendBytes:&blockAlign length:2];
    [wav appendBytes:&bits length:2]; [wav appendBytes:"data" length:4]; [wav appendBytes:&dataSize length:4];
    [wav appendData:pcm];
    if (![wav writeToURL:file options:NSDataWritingAtomic error:&error])
        [FaceclawLog log:[NSString stringWithFormat:@"Voice recording: %@", error.localizedDescription]];
    else [FaceclawLog log:[NSString stringWithFormat:@"Voice recording saved: %@ (%.1f s)", file.lastPathComponent, dataSize / 32000.0]];
}
@implementation FaceclawSpeech
- (instancetype)init {
    if ((self = [super init])) _audioQueue = dispatch_queue_create("com.faceclaw.glasses-speech", DISPATCH_QUEUE_SERIAL);
    return self;
}
+ (NSInteger)microphoneAuthorizationStatus { return [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]; }
+ (void)requestMicrophoneAuthorization:(void (^)(NSInteger))completion {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(granted ? 3 : 2); });
    }];
}
+ (NSInteger)authorizationStatus { return SFSpeechRecognizer.authorizationStatus; }
+ (void)requestAuthorization:(void (^)(NSInteger))completion {
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(status); });
    }];
}
- (void)emit:(NSDictionary *)event {
    if (!self.eventHandler) return;
    NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    if (json) self.eventHandler([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
}
- (NSString *)startWithEndpointing:(BOOL)endpointing {
    return [self startWithEndpointing:endpointing phone:NO pcm:NO];
}
- (NSString *)startPhoneWithEndpointing:(BOOL)endpointing {
    return [self startWithEndpointing:endpointing phone:YES pcm:NO];
}
- (NSString *)startPcmCaptureWithEndpointing:(BOOL)endpointing phone:(BOOL)phone {
    return [self startWithEndpointing:endpointing phone:phone pcm:YES];
}
- (NSString *)startWithEndpointing:(BOOL)endpointing phone:(BOOL)phone pcm:(BOOL)pcm {
    [self cancel];
    if (phone && [FaceclawSpeech microphoneAuthorizationStatus] != AVAuthorizationStatusAuthorized)
        return @"Allow Microphone access for OcuSmart in iPhone Settings.";
    NSString *language = NSLocale.preferredLanguages.firstObject ?: @"en-US";
    if (!pcm) {
        if (SFSpeechRecognizer.authorizationStatus != SFSpeechRecognizerAuthorizationStatusAuthorized)
            return @"Allow Speech Recognition for OcuSmart in iPhone Settings.";
        self.recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:language]];
        if (!self.recognizer.supportsOnDeviceRecognition)
            return [NSString stringWithFormat:@"On-device speech is unavailable for %@. Enable Dictation for that language in iPhone Settings → General → Keyboard, then retry.", language];
        if (!self.recognizer.available) return @"Speech recognition is temporarily unavailable. Try again shortly.";
    }
    if (!phone) {
        self.decoder = [FaceclawLc3Decoder new];
        if (!self.decoder) return @"Could not initialize the glasses audio decoder.";
    }
    self.pcmOutput = pcm;
    self.recording = self.saveRecording ? [NSMutableData data] : nil;
    self.bestText = @""; self.accepting = YES;
    // Always measured: hands-free capture finishes on it, continuous capture rolls on it.
    self.endpointing = endpointing;
    self.endpointDetector = [FaceclawKitVoiceEndpointDetector new];
    NSUInteger generation = self.generation;
    __weak FaceclawSpeech *weakSelf = self;
    if (pcm) {
        if (phone) {
            NSString *error = [self startPhoneAudio];
            if (error.length) { [self cancel]; return error; }
        }
        // The PCM consumer reports its own status and has no session limit.
        return @"";
    }
    self.recognizer.queue = NSOperationQueue.mainQueue;
    [self startRecognitionTask];
    if (phone) {
        NSString *error = [self startPhoneAudio];
        if (error.length) { [self cancel]; return error; }
    }
    [self emit:@{@"kind":@"status", @"message":[NSString stringWithFormat:@"Listening on %@ (%@, on-device)…", phone ? @"phone" : @"glasses", language]}];
    // Bound a dictation to the recognizer's supported short-session workflow.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 55 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        FaceclawSpeech *owner = weakSelf;
        if (owner && owner.generation == generation && owner.accepting && !owner.continuous) [owner finish];
    });
    return @"";
}
/** Starts recognition on a fresh request (main queue); a continuous roll calls it again. */
- (void)startRecognitionTask {
    NSUInteger generation = self.generation;
    __weak FaceclawSpeech *weakSelf = self;
    SFSpeechAudioBufferRecognitionRequest *request = [SFSpeechAudioBufferRecognitionRequest new];
    request.requiresOnDeviceRecognition = YES;
    request.shouldReportPartialResults = YES;
    request.taskHint = SFSpeechRecognitionTaskHintDictation;
    if (@available(iOS 16.0, *)) request.addsPunctuation = YES;
    self.request = request;
    self.transcript = [FaceclawSpeechTranscript new];
    self.taskStarted = [NSDate date];
    self.task = [self.recognizer recognitionTaskWithRequest:request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            FaceclawSpeech *owner = weakSelf;
            // A rolled-over request's late results belong to an utterance already emitted.
            if (!owner || owner.generation != generation || owner.request != request) return;
            if (result) {
                SFSpeechRecognitionMetadata *metadata = result.speechRecognitionMetadata;
                SFTranscriptionSegment *first = result.bestTranscription.segments.firstObject;
                SFTranscriptionSegment *last = result.bestTranscription.segments.lastObject;
                NSTimeInterval start = metadata ? metadata.speechStartTimestamp : first.timestamp;
                NSTimeInterval duration = metadata ? metadata.speechDuration : last.timestamp + last.duration - start;
                owner.bestText = [owner.transcript updateText:result.bestTranscription.formattedString ?: @""
                                                       start:start duration:duration settled:metadata != nil || result.final final:result.final];
                if (!result.final) [owner emit:@{@"kind":@"transcript", @"text":owner.bestText, @"final":@NO}];
            }
            if (result.final || error) {
                if (owner.continuous && owner.accepting) {
                    // Silence ("No speech detected") and Apple's own session limit end a
                    // task; continuous capture rolls on, unless the recognizer keeps
                    // failing as soon as it starts.
                    owner.fastErrors = error && owner.taskStarted.timeIntervalSinceNow > -2 ? owner.fastErrors + 1 : 0;
                    if (owner.fastErrors < 3) { [owner rollPausing:NO]; return; }
                }
                NSString *message = error ? [NSString stringWithFormat:@"Speech recognition: %@", error.localizedDescription] : @"Ready to send";
                [owner complete:message];
            }
        });
    }];
}
/** Continuous capture (main queue): the utterance so far becomes final and recognition
 * restarts on a fresh request. ponytail: the old task is cancelled, not drained, so Apple's
 * last refinement of it is lost; endAudio with per-task finals if that matters. */
- (void)rollPausing:(BOOL)pause {
    NSString *text = self.bestText ?: @"";
    self.bestText = @"";
    SFSpeechRecognitionTask *old = self.task;
    self.endpointDetector = [FaceclawKitVoiceEndpointDetector new];
    [self startRecognitionTask];
    [old cancel];
    if (text.length) [self emit:@{@"kind":@"transcript", @"text":text, @"final":@YES}];
    if (pause) [self emit:@{@"kind":@"pause"}];
}
/** The endpoint detector fired (main queue): hands-free capture finishes, continuous capture rolls. */
- (void)endpointReached {
    if (!self.accepting) return;
    if (!self.continuous) { if (self.endpointing) [self finish]; return; }
    // A cloud provider segments its own stream.
    if (self.pcmOutput) return;
    if (self.bestText.length) [self rollPausing:YES];
    else self.endpointDetector = [FaceclawKitVoiceEndpointDetector new];
}
- (NSString *)startPhoneAudio {
    AVAudioSession *session = AVAudioSession.sharedInstance;
    NSError *error = nil;
    // Leave preferredInput unset so iOS selects its current default route,
    // including a headset microphone when one is attached.
    if (![session setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeMeasurement
                     options:AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetoothHFP error:&error])
        return [NSString stringWithFormat:@"Could not configure phone microphone: %@", error.localizedDescription];
    if (![session setActive:YES error:&error])
        return [NSString stringWithFormat:@"Could not activate phone microphone: %@", error.localizedDescription];
    self.phoneSessionActive = YES;
    self.phoneEngine = [AVAudioEngine new];
    AVAudioInputNode *input = self.phoneEngine.inputNode;
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (format.sampleRate <= 0 || !format.channelCount) return @"No phone microphone is available. Check your audio input and try again.";
    AVAudioConverter *converter = nil;
    BOOL pcmOutput = self.pcmOutput;
    // 16 kHz PCM for a cloud provider or a saved recording.
    if (pcmOutput || self.recording) {
        AVAudioFormat *pcmFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16 sampleRate:16000 channels:1 interleaved:YES];
        converter = [[AVAudioConverter alloc] initFromFormat:format toFormat:pcmFormat];
        if (!converter) return @"Could not convert phone microphone audio.";
        converter.downmix = YES;
    }
    NSUInteger generation = self.generation;
    __weak FaceclawSpeech *weakSelf = self;
    [input installTapOnBus:0 bufferSize:1024 format:format block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        FaceclawSpeech *owner = weakSelf;
        if (!owner || owner.generation != generation || !owner.accepting || !buffer.frameLength) return;
        // The tap owns buffer only for this callback. Copy before handing it
        // to the serial recognition queue, which finish drains before endAudio.
        AVAudioPCMBuffer *copy = [[AVAudioPCMBuffer alloc] initWithPCMFormat:buffer.format frameCapacity:buffer.frameLength];
        copy.frameLength = buffer.frameLength;
        const AudioBufferList *source = buffer.audioBufferList;
        AudioBufferList *destination = copy.mutableAudioBufferList;
        for (UInt32 i = 0; i < source->mNumberBuffers; i++)
            memcpy(destination->mBuffers[i].mData, source->mBuffers[i].mData, source->mBuffers[i].mDataByteSize);
        dispatch_async(owner.audioQueue, ^{ @autoreleasepool {
            if (owner.generation != generation) return;
            NSData *pcm = converter ? resampleToPcm(converter, copy) : nil;
            if (!pcmOutput) [owner.request appendAudioPCMBuffer:copy];
            else if (pcm.length) [owner deliverPcm:pcm generation:generation];
            if (pcm.length) [owner.recording appendData:pcm];
            double sum = 0;
            if (copy.floatChannelData) {
                const float *samples = copy.floatChannelData[0];
                NSUInteger stride = copy.format.interleaved ? copy.format.channelCount : 1;
                for (NSUInteger i = 0; i < copy.frameLength; i++) sum += samples[i * stride] * samples[i * stride];
            }
            double rms = sqrt(sum / copy.frameLength);
            // The endpoint detector uses a 16 kHz sample clock; device input
            // commonly arrives at 48 kHz. Recognition accepts its native rate.
            int32_t samples = (int32_t)llround(copy.frameLength * 16000.0 / copy.format.sampleRate);
            BOOL ended = [owner.endpointDetector acceptLevelRms:rms * 32768.0 sampleCount:samples];
            if (ended) dispatch_async(dispatch_get_main_queue(), ^{
                if (owner.generation == generation) [owner endpointReached];
            });
        }});
    }];
    self.phoneTapInstalled = YES;
    [self.phoneEngine prepare];
    if (![self.phoneEngine startAndReturnError:&error])
        return [NSString stringWithFormat:@"Could not start phone microphone: %@", error.localizedDescription];
    self.interruptionObserver = [NSNotificationCenter.defaultCenter addObserverForName:AVAudioSessionInterruptionNotification
        object:session queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
            FaceclawSpeech *owner = weakSelf;
            if (owner.generation == generation && [notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan)
                [owner complete:@"Phone microphone interrupted. Start voice input again to continue."];
        }];
    return @"";
}
- (void)stopPhoneAudio {
    if (self.interruptionObserver) [NSNotificationCenter.defaultCenter removeObserver:self.interruptionObserver];
    self.interruptionObserver = nil;
    [self.phoneEngine stop];
    if (self.phoneTapInstalled) [self.phoneEngine.inputNode removeTapOnBus:0];
    self.phoneTapInstalled = NO;
    self.phoneEngine = nil;
    if (self.phoneSessionActive) [AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
    self.phoneSessionActive = NO;
}
- (void)acceptPacket:(NSData *)packet {
    if (!self.accepting) return;
    if (self.pendingPackets >= 40) {
        if (!self.continuous) { [self complete:@"Audio processing fell behind. Please try again."]; return; }
        // Continuous capture drops audio while it catches up, keeping what it heard.
        if (self.bestText.length && !self.pcmOutput) [self rollPausing:NO];
        return;
    }
    self.pendingPackets++;
    NSUInteger generation = self.generation;
    FaceclawLc3Decoder *decoder = self.decoder;
    BOOL pcmOutput = self.pcmOutput;
    NSData *copy = [packet copy];
    dispatch_async(self.audioQueue, ^{ @autoreleasepool {
        if (self.generation != generation) return;
        NSData *pcm = [decoder decodePacket:copy];
        double rms = 0;
        BOOL speechEnded = NO;
        if (pcm.length) {
            AVAudioFrameCount frames = (AVAudioFrameCount)(pcm.length / 2);
            AVAudioPCMBuffer *buffer = nil;
            if (!pcmOutput) {
                AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:16000 channels:1 interleaved:NO];
                buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:frames];
                buffer.frameLength = frames;
            }
            const int16_t *samples = pcm.bytes;
            for (NSUInteger i = 0; i < frames; i++) {
                float value = samples[i] / 32768.0f;
                if (buffer) buffer.floatChannelData[0][i] = value;
                rms += value * value;
            }
            rms = sqrt(rms / frames);
            if (self.generation == generation) {
                // The decoder's output is already the PCM consumer's format.
                if (pcmOutput) [self deliverPcm:pcm generation:generation];
                else [self.request appendAudioPCMBuffer:buffer];
                [self.recording appendData:pcm];
            }
            speechEnded = [self.endpointDetector acceptLevelRms:rms * 32768.0 sampleCount:(int32_t)frames];
        }
        NSUInteger packets = decoder.packets, errors = decoder.errors, missing = decoder.missing;
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.generation != generation) return;
            self.pendingPackets--;
            if (speechEnded) [self endpointReached];
            if (pcm.length && packets % 20 == 0) [self emit:@{@"kind":@"audio", @"packets":@(packets), @"seconds":@(packets * 0.05), @"rms":@(rms), @"missing":@(missing), @"errors":@(errors)}];
            if (errors > 10 && !packets) [self complete:@"Could not decode glasses audio. Reconnect the glasses and retry."];
        });
    }});
}
- (void)finish {
    if (!self.accepting) return;
    self.accepting = NO;
    [self stopPhoneAudio];
    NSUInteger generation = self.generation;
    SFSpeechAudioBufferRecognitionRequest *request = self.request;
    BOOL pcmOutput = self.pcmOutput;
    [self emit:@{@"kind":@"finishing"}];
    // Drain already received audio before marking the utterance complete.
    dispatch_async(self.audioQueue, ^{
        if (self.generation != generation) return;
        if (!pcmOutput) { [request endAudio]; return; }
        // Drained chunks are already queued for pcmHandler; "ended" follows them.
        dispatch_async(dispatch_get_main_queue(), ^{ if (self.generation == generation) [self complete:@"Ready to send"]; });
    });
    __weak FaceclawSpeech *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 8 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        FaceclawSpeech *owner = weakSelf;
        if (owner && owner.generation == generation) [owner complete:@"Ready to send"];
    });
}
- (void)complete:(NSString *)status {
    NSString *text = self.bestText ?: @"";
    [self cancel];
    NSUInteger generation = self.generation;
    if (text.length) [self emit:@{@"kind":@"transcript", @"text":text, @"final":@YES}];
    if (self.generation == generation) [self emit:@{@"kind":@"ended", @"message":status}];
}
- (void)deliverPcm:(NSData *)pcm generation:(NSUInteger)generation {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.generation == generation && self.pcmHandler) self.pcmHandler(pcm);
    });
}
/** Ends the capture's recording (main queue); it is written on audioQueue, after any
 * chunk still being appended there. */
- (void)saveRecordingFile {
    NSMutableData *recording = self.recording;
    self.recording = nil;
    if (recording) dispatch_async(self.audioQueue, ^{ if (recording.length) writeWav(recording); });
}
- (void)cancel {
    [self saveRecordingFile];
    self.generation++;
    self.accepting = NO; self.pendingPackets = 0; self.pcmOutput = NO;
    [self stopPhoneAudio];
    [self.task cancel]; self.task = nil; self.request = nil; self.decoder = nil; self.recognizer = nil;
    self.bestText = @""; self.transcript = nil; self.endpointDetector = nil;
}
@end
