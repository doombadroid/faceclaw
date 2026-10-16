#import <Foundation/Foundation.h>

/**
 * App log lines into the unified system log, readable over USB with
 * idevicesyslog. NSLog from a third-party app and NativeScript's console in a
 * release build do not reach it on recent iOS, so the app's own log goes here.
 */
@interface FaceclawLog : NSObject
+ (void)log:(NSString *)message;
@end
