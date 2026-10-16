#import "FaceclawLog.h"
#import <os/log.h>

@implementation FaceclawLog
+ (void)log:(NSString *)message {
    static os_log_t log;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ log = os_log_create("com.faceclaw.app", "app"); });
    // %{public}: the app never logs tokens or passwords, and private would hide every line.
    os_log(log, "%{public}s", message.UTF8String ?: "");
}
@end
