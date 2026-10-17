#import "FaceclawSqlite.h"
#import <FaceclawKit/FaceclawKit.h>
#import <sqlite3.h>

@interface FaceclawSqlite () <FaceclawKitSqlPort>
@end

@implementation FaceclawSqlite {
    sqlite3 *_db;
}

- (instancetype)initWithPath:(NSString *)path {
    if (!(self = [super init])) return nil;
    if (sqlite3_open_v2(path.fileSystemRepresentation, &_db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, NULL) != SQLITE_OK) {
        NSLog(@"FaceclawSqlite: open %@ failed: %s", path, sqlite3_errmsg(_db));
        sqlite3_close(_db);
        return nil;
    }
    sqlite3_busy_timeout(_db, 2000);
    return self;
}

- (void)dealloc {
    sqlite3_close(_db);
}

- (NSArray<NSArray *> *)querySql:(NSString *)sql args:(NSArray *)args {
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(_db, sql.UTF8String, -1, &stmt, NULL) != SQLITE_OK) {
        NSLog(@"FaceclawSqlite: %s", sqlite3_errmsg(_db));
        return nil;
    }
    for (int i = 0; i < (int)args.count; i++) {
        id arg = args[i];
        if ([arg isKindOfClass:NSString.class]) sqlite3_bind_text(stmt, i + 1, [arg UTF8String], -1, SQLITE_TRANSIENT);
        else sqlite3_bind_null(stmt, i + 1);
    }
    NSMutableArray *rows = [NSMutableArray array];
    int columns = sqlite3_column_count(stmt), step;
    while ((step = sqlite3_step(stmt)) == SQLITE_ROW) {
        NSMutableArray *row = [NSMutableArray arrayWithCapacity:columns];
        for (int c = 0; c < columns; c++) {
            const unsigned char *text = sqlite3_column_text(stmt, c);
            [row addObject:text ? @((const char *)text) : NSNull.null];
        }
        [rows addObject:row];
    }
    if (step != SQLITE_DONE) {
        NSLog(@"FaceclawSqlite: %s", sqlite3_errmsg(_db));
        rows = nil;
    }
    sqlite3_finalize(stmt);
    return rows;
}

@end
