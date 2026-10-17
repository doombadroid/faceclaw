#import <Foundation/Foundation.h>
/** On-device speech recognition fed by G2 BLE audio or the default phone microphone. */
@interface FaceclawSpeech : NSObject
@property(nonatomic, copy) void (^eventHandler)(NSString *json);
/** 16 kHz mono PCM16LE chunks from a PCM capture, on the main queue in capture order. */
@property(nonatomic, copy) void (^pcmHandler)(NSData *pcm);
/** Keep recognizing until cancelled: each utterance (an endpoint, the 30 s
 * cap, or a recognizer final or error) is emitted as a final transcript and
 * recognition restarts on a fresh request, with a "pause" event after an
 * endpoint. Read on the main queue, so it may change during a capture. */
@property(nonatomic) BOOL continuous;
/** Keep the capture's audio as one 16 kHz mono WAV in Documents/voice-recordings,
 * written when the capture ends (across continuous rolls). Read at start. */
@property(nonatomic) BOOL saveRecording;
+ (NSInteger)authorizationStatus;
+ (NSInteger)microphoneAuthorizationStatus;
+ (void)requestMicrophoneAuthorization:(void (^)(NSInteger status))completion;
+ (void)requestAuthorization:(void (^)(NSInteger status))completion;
/** Returns an actionable error, or an empty string when capture starts. */
- (NSString *)startWithEndpointing:(BOOL)endpointing;
- (NSString *)startPhoneWithEndpointing:(BOOL)endpointing;
/** Capture without the recognizer (for a cloud provider): audio goes to
 * pcmHandler, and "ended" follows the last chunk. No transcript events. */
- (NSString *)startPcmCaptureWithEndpointing:(BOOL)endpointing phone:(BOOL)phone;
- (void)acceptPacket:(NSData *)packet;
- (void)finish;
- (void)cancel;
@end
