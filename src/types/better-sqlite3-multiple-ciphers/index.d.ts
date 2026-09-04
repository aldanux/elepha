declare module 'better-sqlite3-multiple-ciphers' {
    import BetterSqlite3 = require('better-sqlite3');

    interface CipherDatabase extends BetterSqlite3.Database {
        key(key: Buffer): number;
        rekey(key: Buffer): number;
    }

    interface CipherDatabaseConstructor {
        new (filename?: string | Buffer, options?: BetterSqlite3.Options): CipherDatabase;
        (filename?: string, options?: BetterSqlite3.Options): CipherDatabase;
        prototype: CipherDatabase;
        SqliteError: BetterSqlite3.SqliteError;
    }

    const Database: CipherDatabaseConstructor;

    namespace Database {
        type Database = CipherDatabase;
        type Statement<BindParameters extends unknown[] | object = unknown[], Result = unknown> = BetterSqlite3.Statement<
            BindParameters,
            Result
        >;
    }

    export = Database;
}
