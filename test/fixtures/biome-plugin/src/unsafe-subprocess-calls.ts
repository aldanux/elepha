// Fixture for test/security/biome-plugin-fixtures.test.ts - NOT real source,
// never imported by anything. Every line here must trip one of
// .biome-plugins/no-raw-subprocess.grit or .biome-plugins/no-shell-true.grit.
// If a line here stops producing a diagnostic, the plugin regressed.

import { execSync, spawn } from 'node:child_process';
import cp from 'node:child_process';

//noinspection JSUnusedGlobalSymbols
export function bareCall(x: string) {
    return execSync(x); // banned: bare call to a subprocess function
}

//noinspection JSUnusedGlobalSymbols
export function memberCall(x: string) {
    return cp.exec(x); // banned: member-expression call, receiver looks like child_process
}

//noinspection JSUnusedGlobalSymbols
export function shellTrue(x: string) {
    return spawn('sh', ['-c', x], { shell: true }); // banned: shell:true, anywhere
}
