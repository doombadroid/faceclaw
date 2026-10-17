#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
/** One SQLite connection for the shared conversation store; conforms to FaceclawKitSqlPort (declared in the .m). */
@interface FaceclawSqlite : NSObject
- (nullable instancetype)initWithPath:(NSString *)path;
/** Text-bound args (NSNull binds NULL); rows of column text, NSNull for SQL NULL; nil on error. */
- (nullable NSArray<NSArray *> *)querySql:(NSString *)sql args:(NSArray *)args;
@end
NS_ASSUME_NONNULL_END
