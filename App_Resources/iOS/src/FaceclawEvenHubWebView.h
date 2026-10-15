#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

/** One local or URL EvenHub runtime, retained by its TS session until its window closes. */
@interface FaceclawEvenHubWebView : NSObject <WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, WKURLSchemeHandler>
@property(nonatomic, copy) void (^eventHandler)(NSString *json);
@property(nonatomic, copy) NSString *packageIdentifier;
/** Origins ("https://host[:port]") the manifest declares, lowercased. The app's
 *  own pages at these origins reach the host bridge; see allowsURL:. */
@property(nonatomic, copy) NSArray<NSString *> *allowedOrigins;
- (void)start:(NSString *)directory entrypoint:(NSString *)entrypoint script:(NSString *)script;
- (void)startURL:(NSString *)url script:(NSString *)script;
- (void)evaluate:(NSString *)script;
- (void)showOnPhone;
- (void)hideOnPhone;
- (void)destroy;
@end
