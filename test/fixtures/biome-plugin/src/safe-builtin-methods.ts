// Fixture for test/security/biome-plugin-fixtures.test.ts - NOT real source,
// never imported by anything. Neither call below is a subprocess: both are
// unrelated builtins that happen to share a method name with one
// (RegExp.prototype.exec, better-sqlite3's Database.exec). Regression fixture
// for the false positive fixed while building .biome-plugins/no-raw-subprocess.grit -
// if either line here starts producing a "plugin" diagnostic, the receiver-name
// restriction in the grit rule's member-expression branch was silently loosened.

const PATTERN = /^\d+$/;

//noinspection JSUnusedGlobalSymbols
export function regexExec(input: string) {
    return PATTERN.exec(input);
}

interface DbLike {
    exec(sql: string): void;
}

//noinspection JSUnusedGlobalSymbols
export function databaseExec(db: DbLike, sql: string) {
    db.exec(sql);
}
