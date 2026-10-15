#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Serves one unpacked EvenHub app over loopback HTTP, so its page runs on an
 * ordinary web origin ("http://127.0.0.1:<port>") rather than a custom scheme.
 * The stock host serves Hub apps the same way, and Android gives them a
 * synthetic https origin; a custom-scheme origin is treated differently by
 * servers and by WebKit (CORS allow-lists, cookies, storage partitioning).
 *
 * Loopback only, GET/HEAD only, and files are served from `directory` with no
 * path escaping it.
 */
@interface FaceclawEvenHubLocalServer : NSObject
- (instancetype)initWithDirectory:(NSString *)directory;
/** The bound port, or 0 before a successful start. */
@property(nonatomic, readonly) uint16_t port;
/** Binds an ephemeral loopback port. NO if the listener could not start. */
- (BOOL)start;
- (void)stop;
@end

NS_ASSUME_NONNULL_END
