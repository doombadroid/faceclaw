#import "FaceclawEvenHubWebView.h"
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <CommonCrypto/CommonDigest.h>

@interface FaceclawEvenHubWebView ()
@property(nonatomic) WKWebView *webView;
@property(nonatomic) UIView *host;
@property(nonatomic) UIButton *back;
@property(nonatomic) NSTimer *timer;
@property(nonatomic) NSString *directory;
@property(nonatomic) NSURL *remoteURL;
@property(nonatomic) BOOL ticking;
@property(nonatomic) BOOL destroyed;
// A window.open()/off-origin navigation from the app, shown over the app's own
// page so the page stays alive to receive the result (an OAuth redirect lands
// in here, not in the app's frame).
@property(nonatomic) WKWebView *popup;
@property(nonatomic) UIView *popupHost;
@property(nonatomic) UILabel *popupOrigin;
@end

@implementation FaceclawEvenHubWebView
- (void)emit:(NSDictionary *)event {
    if (!_eventHandler || _destroyed) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    if (data) _eventHandler([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
}
- (void)start:(NSString *)directory entrypoint:(NSString *)entrypoint script:(NSString *)script {
    _directory = directory.stringByStandardizingPath.stringByResolvingSymlinksInPath;
    NSURLComponents *url = [NSURLComponents new];
    url.scheme = @"faceclaw-ehpk"; url.host = @"app"; url.path = [@"/" stringByAppendingString:entrypoint];
    [self startRequest:url.URL script:script];
}
- (void)startURL:(NSString *)url script:(NSString *)script {
    NSURL *target = [NSURL URLWithString:url];
    if (!target.host.length || ![@[@"http", @"https"] containsObject:target.scheme.lowercaseString] || target.user || target.password) {
        [self emit:@{@"kind": @"error", @"message": @"Invalid app URL."}]; return;
    }
    _remoteURL = target;
    [self startRequest:target script:script];
}
- (void)startRequest:(NSURL *)url script:(NSString *)script {
    if (_destroyed) return;
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    // Isolate browser storage by package, retaining it across closing/reopening.
    // SDK storage also persists independently through the shared TS session.
    config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
    if (@available(iOS 17.0, *)) {
        if (_packageIdentifier.length) {
            NSData *key = [[@"com.faceclaw.ehpk:" stringByAppendingString:_packageIdentifier] dataUsingEncoding:NSUTF8StringEncoding];
            unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(key.bytes, (CC_LONG)key.length, digest);
            config.websiteDataStore = [WKWebsiteDataStore dataStoreForIdentifier:[[NSUUID alloc] initWithUUIDBytes:digest]];
        }
    }
    // Without this, WebKit drops a window.open() that is not inside a user
    // gesture — which is where an app's setup flow usually calls it.
    config.preferences.javaScriptCanOpenWindowsAutomatically = YES;
    [config setURLSchemeHandler:self forURLScheme:@"faceclaw-ehpk"];
    [config.userContentController addScriptMessageHandler:self name:@"faceclaw"];
    [config.userContentController addUserScript:[[WKUserScript alloc] initWithSource:script
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    _webView = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
    _webView.navigationDelegate = self;
    _webView.UIDelegate = self;
    _webView.accessibilityIdentifier = @"evenhub-webview";
    UIWindow *window = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *candidate in ((UIWindowScene *)scene).windows) if (candidate.isKeyWindow) window = candidate;
    }
    if (!window) window = UIApplication.sharedApplication.keyWindow;
    if (!window) { [self emit:@{@"kind": @"error", @"message": @"No phone window is available."}]; return; }
    _host = [[UIView alloc] initWithFrame:window.bounds];
    _host.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _host.backgroundColor = UIColor.systemBackgroundColor;
    _host.userInteractionEnabled = NO;
    _host.accessibilityElementsHidden = YES;
    [window insertSubview:_host atIndex:0];
    [_host addSubview:_webView];
    _webView.translatesAutoresizingMaskIntoConstraints = NO;
    _back = [UIButton buttonWithType:UIButtonTypeSystem];
    [_back setTitle:@"Back to Faceclaw" forState:UIControlStateNormal];
    _back.accessibilityIdentifier = @"evenhub-back";
    [_back addTarget:self action:@selector(hideOnPhone) forControlEvents:UIControlEventTouchUpInside];
    [_host addSubview:_back]; _back.translatesAutoresizingMaskIntoConstraints = NO;
    [NSLayoutConstraint activateConstraints:@[
        [_back.topAnchor constraintEqualToAnchor:_host.safeAreaLayoutGuide.topAnchor],
        [_back.leadingAnchor constraintEqualToAnchor:_host.leadingAnchor],
        [_back.trailingAnchor constraintEqualToAnchor:_host.trailingAnchor],
        [_back.heightAnchor constraintEqualToConstant:44],
        [_webView.topAnchor constraintEqualToAnchor:_back.bottomAnchor],
        [_webView.leadingAnchor constraintEqualToAnchor:_host.leadingAnchor],
        [_webView.trailingAnchor constraintEqualToAnchor:_host.trailingAnchor],
        [_webView.bottomAnchor constraintEqualToAnchor:_host.safeAreaLayoutGuide.bottomAnchor]
    ]];
    // Keep a nonzero attached view behind the dashboard; do not hide/detach it.
    // Tick whenever iOS gives us execution time, including in the background or
    // with the phone locked. Gating on UIApplicationStateActive stalls the
    // injected timers/rAF even while BLE input can still evaluate JavaScript.
    // Bound host ticks to one evaluation in flight, including across suspension.
    __weak typeof(self) weakSelf = self;
    _timer = [NSTimer timerWithTimeInterval:1.0 / 60 repeats:YES block:^(NSTimer *timer) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf || strongSelf.destroyed || strongSelf.ticking) return;
        strongSelf.ticking = YES;
        [strongSelf.webView evaluateJavaScript:@"window.__fcTimerTick && window.__fcTimerTick(); window.__fcRafTick && window.__fcRafTick();" completionHandler:^(id result, NSError *error) {
            weakSelf.ticking = NO;
        }];
    }];
    [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
    [_webView loadRequest:[NSURLRequest requestWithURL:url]];
}
- (void)evaluate:(NSString *)script {
    if (!_destroyed) [_webView evaluateJavaScript:script completionHandler:nil];
}
- (void)showOnPhone {
    if (_destroyed) return;
    [_host.superview bringSubviewToFront:_host]; _host.userInteractionEnabled = YES; _host.accessibilityElementsHidden = NO;
}
- (void)hideOnPhone {
    [_host endEditing:YES]; [_host.superview sendSubviewToBack:_host]; _host.userInteractionEnabled = NO; _host.accessibilityElementsHidden = YES;
    [self emit:@{@"kind": @"hidden"}];
}
- (void)destroy {
    if (_destroyed) return;
    _destroyed = YES; [_timer invalidate]; _timer = nil;
    [self dismissPopup];
    [_webView stopLoading]; _webView.navigationDelegate = nil; _webView.UIDelegate = nil;
    [_webView.configuration.userContentController removeScriptMessageHandlerForName:@"faceclaw"];
    [_webView.configuration.userContentController removeAllUserScripts];
    [_host removeFromSuperview]; _host = nil; _back = nil; _webView = nil; _eventHandler = nil;
}
/** "scheme://host[:port]" with the scheme's default port omitted, lowercased. */
- (NSString *)originOf:(NSURL *)url {
    NSString *scheme = url.scheme.lowercaseString;
    if (!scheme || !url.host.length) return nil;
    NSNumber *fallback = @([scheme isEqual:@"https"] ? 443 : 80);
    NSNumber *port = url.port ?: fallback;
    NSString *suffix = [port isEqual:fallback] ? @"" : [NSString stringWithFormat:@":%@", port];
    return [NSString stringWithFormat:@"%@://%@%@", scheme, url.host.lowercaseString, suffix];
}
- (BOOL)allowsURL:(NSURL *)url {
    /* A page at an origin the manifest declares is the app's own code too: an
     * auth flow that redirects the whole page back to the app's hosted copy
     * lands there and has to reach the bridge to finish. The stock host grants
     * every page in the app's web view that access, and Android's
     * addJavascriptInterface does the same; this is the narrower form. */
    if (_allowedOrigins.count) {
        NSString *origin = [self originOf:url];
        if (origin && [_allowedOrigins containsObject:origin]) return YES;
    }
    if (!_remoteURL) return [url.scheme isEqual:@"faceclaw-ehpk"] && [url.host isEqual:@"app"];
    NSNumber *port = url.port ?: @([url.scheme.lowercaseString isEqual:@"https"] ? 443 : 80);
    NSNumber *remotePort = _remoteURL.port ?: @([_remoteURL.scheme.lowercaseString isEqual:@"https"] ? 443 : 80);
    return [url.scheme.lowercaseString isEqual:_remoteURL.scheme.lowercaseString] &&
        [url.host.lowercaseString isEqual:_remoteURL.host.lowercaseString] && [port isEqual:remotePort];
}
- (BOOL)isWebURL:(NSURL *)url {
    NSString *scheme = url.scheme.lowercaseString;
    return [scheme isEqual:@"http"] || [scheme isEqual:@"https"];
}
/* A scheme WKWebView cannot load (an auth handoff to an installed app, mailto:,
 * tel:) belongs to the system. Faceclaw registers no URL scheme of its own, so
 * such a flow can leave for the other app but cannot redirect back here yet. */
- (void)openExternally:(NSURL *)url {
    if (!url || [self isWebURL:url] || [url.scheme.lowercaseString isEqual:@"faceclaw-ehpk"]) return;
    [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
}
/* The destination runs over the app's own page rather than replacing it: an
 * auth flow ends by handing a result back to the page that opened it, which a
 * same-frame navigation would have already torn down. `load` is NO when WebKit
 * opened the window itself and will load the request into the view we return. */
- (WKWebView *)presentPopupWithConfiguration:(WKWebViewConfiguration *)configuration
    request:(NSURLRequest *)request load:(BOOL)load {
    if (_destroyed || !_host) return nil;
    [self dismissPopup];
    _popupHost = [[UIView alloc] initWithFrame:_host.bounds];
    _popupHost.backgroundColor = UIColor.systemBackgroundColor;
    _popup = [[WKWebView alloc] initWithFrame:CGRectZero configuration:configuration ?: _webView.configuration];
    _popup.navigationDelegate = self;
    _popup.UIDelegate = self;
    _popup.accessibilityIdentifier = @"evenhub-popup";
    UIButton *done = [UIButton buttonWithType:UIButtonTypeSystem];
    [done setTitle:@"Done" forState:UIControlStateNormal];
    done.accessibilityIdentifier = @"evenhub-popup-done";
    [done addTarget:self action:@selector(dismissPopup) forControlEvents:UIControlEventTouchUpInside];
    // The page is not the app's own and may ask for a password: show its host.
    _popupOrigin = [UILabel new];
    _popupOrigin.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
    _popupOrigin.textColor = UIColor.secondaryLabelColor;
    _popupOrigin.textAlignment = NSTextAlignmentCenter;
    _popupOrigin.lineBreakMode = NSLineBreakByTruncatingMiddle;
    _popupOrigin.text = request.URL.host ?: @"";
    [_host addSubview:_popupHost];
    for (UIView *view in @[_popupHost, _popup, done, _popupOrigin]) view.translatesAutoresizingMaskIntoConstraints = NO;
    [_popupHost addSubview:_popup]; [_popupHost addSubview:done]; [_popupHost addSubview:_popupOrigin];
    [NSLayoutConstraint activateConstraints:@[
        [_popupHost.topAnchor constraintEqualToAnchor:_host.topAnchor],
        [_popupHost.leadingAnchor constraintEqualToAnchor:_host.leadingAnchor],
        [_popupHost.trailingAnchor constraintEqualToAnchor:_host.trailingAnchor],
        [_popupHost.bottomAnchor constraintEqualToAnchor:_host.bottomAnchor],
        [done.topAnchor constraintEqualToAnchor:_popupHost.safeAreaLayoutGuide.topAnchor],
        [done.leadingAnchor constraintEqualToAnchor:_popupHost.leadingAnchor constant:12],
        [done.heightAnchor constraintEqualToConstant:44],
        [_popupOrigin.centerYAnchor constraintEqualToAnchor:done.centerYAnchor],
        [_popupOrigin.leadingAnchor constraintEqualToAnchor:done.trailingAnchor constant:12],
        [_popupOrigin.trailingAnchor constraintEqualToAnchor:_popupHost.trailingAnchor constant:-12],
        [_popup.topAnchor constraintEqualToAnchor:done.bottomAnchor],
        [_popup.leadingAnchor constraintEqualToAnchor:_popupHost.leadingAnchor],
        [_popup.trailingAnchor constraintEqualToAnchor:_popupHost.trailingAnchor],
        [_popup.bottomAnchor constraintEqualToAnchor:_popupHost.safeAreaLayoutGuide.bottomAnchor]
    ]];
    if (load && request) [_popup loadRequest:request];
    return _popup;
}
- (void)dismissPopup {
    if (!_popupHost) return;
    [_popup stopLoading];
    _popup.navigationDelegate = nil; _popup.UIDelegate = nil;
    [_popup removeFromSuperview]; _popup = nil;
    [_popupHost removeFromSuperview]; _popupHost = nil; _popupOrigin = nil;
}
/* Without a UI delegate WebKit discards window.open() silently, which is what
 * made app setup flows that need a browser appear to do nothing at all. */
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
    forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)windowFeatures {
    if (_destroyed || webView != _webView) return nil;  // a popup opens no popups
    NSURL *url = action.request.URL;
    if (url && ![self isWebURL:url] && ![url.scheme.lowercaseString isEqual:@"faceclaw-ehpk"]) {
        [self openExternally:url];
        return nil;
    }
    return [self presentPopupWithConfiguration:configuration request:action.request load:NO];
}
- (void)webViewDidClose:(WKWebView *)webView {
    if (webView == _popup) [self dismissPopup];
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    // Subframes and navigated third-party documents never receive host access.
    NSURL *url = message.frameInfo.request.URL;
    if (!message.frameInfo.isMainFrame || ![self allowsURL:url]) return;
    if ([message.body isKindOfClass:NSDictionary.class]) [self emit:message.body];
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    if (webView == _popup) {
        /* The popup is a browser view, so any web page may load in it. Host
         * access does not follow: didReceiveScriptMessage re-checks every
         * message against the app origin, whichever frame sends it. */
        if ([self isWebURL:url] || [self allowsURL:url] || [url.scheme.lowercaseString isEqual:@"about"]) {
            decisionHandler(WKNavigationActionPolicyAllow);
            return;
        }
        [self openExternally:url];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    /* The app's own top-level page may navigate anywhere on the web, as it can
     * on Android (FaceclawEvenHubWebViewClient overrides no navigation policy)
     * and in the stock host. Apps rely on it: an OAuth flow sets location.href
     * and is redirected back to its own hosted page, so cancelling that, or
     * diverting it to a window the app did not ask for, breaks the round trip.
     * Host access does not follow the navigation — didReceiveScriptMessage
     * checks each message's own frame URL. */
    if (action.targetFrame.isMainFrame) {
        if ([self allowsURL:url] || [self isWebURL:url]) {
            decisionHandler(WKNavigationActionPolicyAllow);
            return;
        }
        if (url) [self openExternally:url];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    /* A nil targetFrame is a new window WebKit did not route through
     * createWebViewWithConfiguration; subframe loads stay blocked as before. */
    if (!action.targetFrame) {
        if ([self isWebURL:url]) {
            [self presentPopupWithConfiguration:webView.configuration request:action.request load:YES];
            decisionHandler(WKNavigationActionPolicyCancel);
            return;
        }
        if (url) [self openExternally:url];
        else [self emit:@{@"kind": @"error", @"message": @"Blocked a navigation with no address."}];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    decisionHandler(WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
    if (webView == _popup) _popupOrigin.text = webView.URL.host ?: @"";
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    if (webView == _webView) [self emit:@{@"kind": @"loaded"}];
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (webView == _webView) [self emit:@{@"kind": @"error", @"message": error.localizedDescription}];
}
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (webView == _webView) [self emit:@{@"kind": @"error", @"message": error.localizedDescription}];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    if (webView != _webView) { [self dismissPopup]; return; }
    [self emit:@{@"kind": @"error", @"message": @"The app's web process ended. Close and reopen the app."}];
}
- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSURL *url = task.request.URL;
    NSString *relative = [url.path stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"/"]];
    NSString *file = [[_directory stringByAppendingPathComponent:relative] stringByStandardizingPath].stringByResolvingSymlinksInPath;
    BOOL allowed = !_destroyed && _directory.length && !_remoteURL && [url.host isEqual:@"app"] &&
        [file hasPrefix:[_directory stringByAppendingString:@"/"]];
    NSData *data = allowed ? [NSData dataWithContentsOfFile:file options:NSDataReadingMappedIfSafe error:nil] : nil;
    NSString *ext = file.pathExtension.lowercaseString;
    NSString *mime = [@{@"js": @"text/javascript", @"mjs": @"text/javascript", @"html": @"text/html",
        @"css": @"text/css", @"json": @"application/json", @"wasm": @"application/wasm", @"svg": @"image/svg+xml"} objectForKey:ext];
    if (!mime) mime = [UTType typeWithFilenameExtension:ext].preferredMIMEType ?: @"application/octet-stream";
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:url statusCode:data ? 200 : 404
        HTTPVersion:@"HTTP/1.1" headerFields:@{@"Content-Type": mime, @"Access-Control-Allow-Origin": @"*", @"Cache-Control": @"no-store"}];
    // Synchronous completion on WebKit's main-queue callback means there is no
    // outstanding task to finish after stopURLSchemeTask cancels it.
    [task didReceiveResponse:response]; [task didReceiveData:data ?: NSData.data]; [task didFinish];
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {}
@end
