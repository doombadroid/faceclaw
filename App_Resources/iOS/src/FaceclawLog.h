#import <Foundation/Foundation.h>

/**
 * App log lines into the unified system log, readable over USB with
 * idevicesyslog. NSLog from a third-party app and NativeScript's console in a
 * release build do not reach it on recent iOS, so the app's own log goes here.
 */
@interface FaceclawLog : NSObject
/** From Objective-C: the system log, and the sink (the remote log) on the main thread. */
+ (void)log:(NSString *)message;
/** From JS: the system log only, as JS forwards its own lines to the remote log. */
+ (void)logFromJs:(NSString *)message;
/** Where -log: lines also go (native/remote-log.ios.ts); nil stops it. */
+ (void)setSink:(void (^)(NSString *line))sink;
@end
