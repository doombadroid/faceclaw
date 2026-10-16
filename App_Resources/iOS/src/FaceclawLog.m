#import "FaceclawLog.h"
#import <os/log.h>

@implementation FaceclawLog
+ (void)log:(NSString *)message {
    // OS_LOG_DEFAULT, as FC-DIAG uses: its %{public} lines reach idevicesyslog
    // readable, while lines logged to a custom os_log_create subsystem arrived
    // as <private> on iOS 27. The prefix makes them easy to filter (-m OcuSmart).
    // %{public}: the app never logs tokens or passwords.
    os_log(OS_LOG_DEFAULT, "OcuSmart %{public}s", message.UTF8String ?: "");
}
@end
