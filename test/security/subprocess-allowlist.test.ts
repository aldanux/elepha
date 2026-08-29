// Security Rule 2: only the fixed git and elepha npm calls below are
// permitted. This test is the allowlist half of "both required" - the
// Biome GritQL plugin (.biome-plugins/no-raw-subprocess.grit) is the other
// half, structurally banning child_process calls anywhere else in src/. This
// test exists independently of that plugin so a misconfigured or disabled
// plugin doesn't silently remove the guarantee.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '../../src');
const ALLOWLIST_MODULE = path.resolve(SRC_ROOT, 'security/subprocess-allowlist.ts');

function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const p = path.join(dir, entry);
        if (statSync(p).isDirectory()) {
            out.push(...listTsFiles(p));
        } else if (entry.endsWith('.ts')) {
            out.push(p);
        }
    }
    return out;
}

describe('subprocess allowlist', () => {
    it('is the only file under src/ that imports node:child_process', () => {
        const offenders = listTsFiles(SRC_ROOT)
            .filter((f) => f !== ALLOWLIST_MODULE)
            .filter((f) => /['"]node:child_process['"]/.test(readFileSync(f, 'utf8')))
            .map((f) => path.relative(SRC_ROOT, f));
        // If this fails, a new subprocess call site was added somewhere else
        // in src/ without updating the allowlist module (or this test).
        expect(offenders).toEqual([]);
    });

    it('never uses shell: true, and invokes only the documented sync and async git subcommands with argv arrays', () => {
        const source = readFileSync(ALLOWLIST_MODULE, 'utf8');
        expect(source).not.toMatch(/shell\s*:\s*true/);
        expect(source).not.toMatch(/\.\.\.\s*process\.env/);
        expect(source).toMatch(/execFileSync\(/);

        const gitCalls = [...source.matchAll(/runGit\(\[([^\]]+)]/g)].map((m) =>
            m[1]!
                .split(',')
                .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
                .join(' '),
        );
        // The fixed git allowlist:
        //   git rev-parse --show-toplevel
        //   git remote get-url origin
        //   git rev-parse --abbrev-ref HEAD
        //   git rev-list --count HEAD
        //   git rev-list --max-parents=0 HEAD
        expect(gitCalls.sort()).toEqual([
            'remote get-url origin',
            'rev-list --count HEAD',
            'rev-list --max-parents=0 HEAD',
            'rev-parse --abbrev-ref HEAD',
            'rev-parse --show-toplevel',
        ]);
        const asyncGitCalls = [...source.matchAll(/runGitAsync\(\[([^\]]+)]/g)].map((m) =>
            m[1]!
                .split(',')
                .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
                .join(' '),
        );
        expect(asyncGitCalls.sort()).toEqual(['rev-list --count HEAD', 'rev-parse --abbrev-ref HEAD']);
    });
});
