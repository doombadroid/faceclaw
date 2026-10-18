#import "FaceclawLog.h"
#import <os/log.h>

static void (^sink)(NSString *);

@implementation FaceclawLog
+ (void)log:(NSString *)message {
    [self logFromJs:message];
    void (^target)(NSString *);
    @synchronized (self) { target = sink; }
    // Callers run on any thread (model loads on FaceclawKit's worker); the JS sink runs on main.
    if (target) {
        NSString *line = [message copy] ?: @"";
        dispatch_async(dispatch_get_main_queue(), ^{ target(line); });
    }
}

+ (void)logFromJs:(NSString *)message {
    // OS_LOG_DEFAULT, as FC-DIAG uses: its %{public} lines reach idevicesyslog
    // readable, while lines logged to a custom os_log_create subsystem arrived
    // as <private> on iOS 27. The prefix makes them easy to filter (-m OcuSmart).
    // %{public}: the app never logs tokens or passwords.
    os_log(OS_LOG_DEFAULT, "OcuSmart %{public}s", message.UTF8String ?: "");
}

+ (void)setSink:(void (^)(NSString *))block {
    @synchronized (self) { sink = [block copy]; }
}
@end
