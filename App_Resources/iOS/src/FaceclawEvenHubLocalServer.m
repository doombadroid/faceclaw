#import "FaceclawEvenHubLocalServer.h"
#import <Network/Network.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

@implementation FaceclawEvenHubLocalServer {
    NSString *_directory;
    nw_listener_t _listener;
    dispatch_queue_t _queue;
}

- (instancetype)initWithDirectory:(NSString *)directory {
    if ((self = [super init])) {
        _directory = directory.stringByStandardizingPath.stringByResolvingSymlinksInPath;
        _queue = dispatch_queue_create("com.faceclaw.evenhub.localserver", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (BOOL)start {
    if (_listener) return _port != 0;
    if (!_directory.length) return NO;
    nw_parameters_t parameters = nw_parameters_create_secure_tcp(
        NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_parameters_set_local_only(parameters);
    nw_endpoint_t local = nw_endpoint_create_host("127.0.0.1", "0");
    nw_parameters_set_local_endpoint(parameters, local);
    _listener = nw_listener_create(parameters);
    if (!_listener) return NO;
    nw_listener_set_queue(_listener, _queue);
    dispatch_semaphore_t ready = dispatch_semaphore_create(0);
    __weak typeof(self) weakSelf = self;
    nw_listener_t listener = _listener;
    nw_listener_set_state_changed_handler(_listener, ^(nw_listener_state_t state, nw_error_t error) {
        if (state == nw_listener_state_ready) {
            typeof(self) strongSelf = weakSelf;
            if (strongSelf) strongSelf->_port = nw_listener_get_port(listener);
            dispatch_semaphore_signal(ready);
        } else if (state == nw_listener_state_failed || state == nw_listener_state_cancelled) {
            dispatch_semaphore_signal(ready);
        }
    });
    nw_listener_set_new_connection_handler(_listener, ^(nw_connection_t connection) {
        [weakSelf accept:connection];
    });
    nw_listener_start(_listener);
    // The caller needs the port to build the app's URL, so wait for the bind.
    dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)));
    if (_port == 0) { [self stop]; return NO; }
    return YES;
}

- (void)stop {
    if (_listener) { nw_listener_cancel(_listener); _listener = nil; }
    _port = 0;
}

- (void)accept:(nw_connection_t)connection {
    nw_connection_set_queue(connection, _queue);
    nw_connection_start(connection);
    [self receive:connection buffer:[NSMutableData data]];
}

- (void)receive:(nw_connection_t)connection buffer:(NSMutableData *)buffer {
    __weak typeof(self) weakSelf = self;
    nw_connection_receive(connection, 1, 16 * 1024,
        ^(dispatch_data_t content, nw_content_context_t context, bool complete, nw_error_t error) {
        if (content) {
            dispatch_data_apply(content, ^bool(dispatch_data_t region, size_t offset, const void *bytes, size_t size) {
                [buffer appendBytes:bytes length:size];
                return true;
            });
        }
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) { nw_connection_cancel(connection); return; }
        NSString *request = [[NSString alloc] initWithData:buffer encoding:NSUTF8StringEncoding];
        if ([request containsString:@"\r\n\r\n"]) { [strongSelf respond:connection request:request]; return; }
        // Headers only: a request this long, or a closed connection, is not ours.
        if (error || complete || buffer.length > 64 * 1024) { nw_connection_cancel(connection); return; }
        [strongSelf receive:connection buffer:buffer];
    });
}

- (void)respond:(nw_connection_t)connection request:(NSString *)request {
    NSArray<NSString *> *lines = [request componentsSeparatedByString:@"\r\n"];
    NSArray<NSString *> *parts = [lines.firstObject componentsSeparatedByString:@" "];
    NSString *method = parts.count ? parts[0] : @"";
    BOOL head = [method isEqual:@"HEAD"];
    if (!head && ![method isEqual:@"GET"]) {
        [self send:connection status:@"405 Method Not Allowed" type:@"text/plain" body:nil headOnly:YES];
        return;
    }
    NSString *target = parts.count > 1 ? parts[1] : @"/";
    NSString *path = [[target componentsSeparatedByString:@"?"].firstObject componentsSeparatedByString:@"#"].firstObject;
    path = path.stringByRemovingPercentEncoding ?: path;
    if (!path.length || [path isEqual:@"/"]) path = @"/index.html";
    NSString *file = [[_directory stringByAppendingPathComponent:path] stringByStandardizingPath];
    NSData *data = nil;
    // stringByStandardizingPath has already resolved any "..", so a file that
    // still sits under the app's directory cannot have escaped it.
    if ([file hasPrefix:[_directory stringByAppendingString:@"/"]]) {
        data = [NSData dataWithContentsOfFile:file options:NSDataReadingMappedIfSafe error:nil];
    }
    if (!data) {
        [self send:connection status:@"404 Not Found" type:@"text/plain" body:nil headOnly:YES];
        return;
    }
    NSString *ext = file.pathExtension.lowercaseString;
    NSString *mime = [@{@"js": @"text/javascript", @"mjs": @"text/javascript", @"html": @"text/html",
        @"css": @"text/css", @"json": @"application/json", @"wasm": @"application/wasm",
        @"svg": @"image/svg+xml"} objectForKey:ext];
    if (!mime) mime = [UTType typeWithFilenameExtension:ext].preferredMIMEType ?: @"application/octet-stream";
    [self send:connection status:@"200 OK" type:mime body:data headOnly:head];
}

- (void)send:(nw_connection_t)connection status:(NSString *)status type:(NSString *)type
        body:(nullable NSData *)body headOnly:(BOOL)headOnly {
    NSString *headers = [NSString stringWithFormat:
        @"HTTP/1.1 %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status, type, (unsigned long)body.length];
    NSMutableData *out = [[headers dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    if (body && !headOnly) [out appendData:body];
    dispatch_data_t payload = dispatch_data_create(out.bytes, out.length, _queue, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
    nw_connection_send(connection, payload, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, true, ^(nw_error_t error) {
        nw_connection_cancel(connection);
    });
}

@end
