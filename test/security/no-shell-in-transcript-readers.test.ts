// Security Rule 1: a transcript path never reaches a shell.
// Transcript files are only ever touched in the bounded adapter/daemon/serving
// readers and the shared opened-object containment helper.
// This test asserts none can invoke a
// subprocess at all: if they can't spawn anything, a transcript path
// structurally cannot reach a shell through this code, independent of
// whatever argument-scrubbing logic might or might not exist elsewhere.
// Companion to test/security/subprocess-allowlist.test.ts, which covers the
// rest of src/.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '../../src');

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

describe('no shell reachable from transcript-reading code', () => {
    it('adapters never import node:child_process', () => {
        const adaptersDir = path.join(SRC_ROOT, 'adapters');
        const offenders = listTsFiles(adaptersDir)
            .filter((f) => /['"]node:child_process['"]/.test(readFileSync(f, 'utf8')))
            .map((f) => path.relative(SRC_ROOT, f));
        expect(offenders).toEqual([]);
    });

    it('the daemon transcript readers never import node:child_process', () => {
        const daemonReaders = [path.join(SRC_ROOT, 'daemon', 'index.ts'), path.join(SRC_ROOT, 'daemon', 'readability-guard.ts')];
        for (const reader of daemonReaders) {
            expect(readFileSync(reader, 'utf8')).not.toMatch(/['"]node:child_process['"]/);
        }
    });

    it('the MCP raw-turn server never imports node:child_process', () => {
        const mcpDir = path.join(SRC_ROOT, 'mcp');
        const offenders = listTsFiles(mcpDir)
            .filter((f) => /['"]node:child_process['"]/.test(readFileSync(f, 'utf8')))
            .map((f) => path.relative(SRC_ROOT, f));
        expect(offenders).toEqual([]);
    });

    it('the shared serving reader never imports node:child_process', () => {
        const servingDir = path.join(SRC_ROOT, 'serving');
        const offenders = listTsFiles(servingDir)
            .filter((f) => /['"]node:child_process['"]/.test(readFileSync(f, 'utf8')))
            .map((f) => path.relative(SRC_ROOT, f));
        expect(offenders).toEqual([]);
    });

    it('the lexical recall transcript reader is inside the serving no-shell boundary', () => {
        const recall = readFileSync(path.join(SRC_ROOT, 'serving', 'lexical-recall.ts'), 'utf8');
        expect(recall).not.toMatch(/['"]node:child_process['"]/);
        expect(recall).not.toMatch(/\b(?:execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/);
    });

    it('the hook parses transcript_path only as inert data and never imports node:child_process', () => {
        const hook = readFileSync(path.join(SRC_ROOT, 'hooks', 'session-start.ts'), 'utf8');
        expect(hook).not.toMatch(/['"]node:child_process['"]/);
        expect(hook).not.toMatch(/parseTurns\(payload\.transcript_path/);
        expect(hook).not.toMatch(/git(?:Rev|Remote)[^(]*\(payload\./);
    });

    it('never derives a git subprocess argv or cwd from any transcript field', () => {
        const hook = readFileSync(path.join(SRC_ROOT, 'hooks', 'session-start.ts'), 'utf8');
        // `cwd` and `transcript_path` are both untrusted stdin/transcript data.
        // The only git call-site must bind cwd from the consented ProjectSet.
        expect(hook).toMatch(/const cwd = project\.gitRoot \?\? project\.paths\[0]/);
        expect(hook).not.toMatch(/git(?:Rev|Remote)[^(]*\(\s*(?:payload\.|payload\[[^\]]+]|session\.source_path)/);
    });

    it('transcripts are read exclusively via fs APIs, not exec/spawn, in adapters and the daemon', () => {
        const files = [
            ...listTsFiles(path.join(SRC_ROOT, 'adapters')),
            ...listTsFiles(path.join(SRC_ROOT, 'mcp')),
            ...listTsFiles(path.join(SRC_ROOT, 'serving')),
            path.join(SRC_ROOT, 'security', 'provider-transcript.ts'),
            path.join(SRC_ROOT, 'daemon', 'index.ts'),
            path.join(SRC_ROOT, 'daemon', 'readability-guard.ts'),
        ];
        // Bare "exec" is deliberately excluded: RegExp.prototype.exec() is a
        // common, unrelated builtin such as RegExp.exec(),
        // and matching the method name alone produces false positives -
        // execSync/execFile/execFileSync/spawn/spawnSync/fork have no such
        // legitimate collision in this codebase.
        const shellCallPattern = /\b(?:execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/;
        const offenders = files.filter((f) => shellCallPattern.test(readFileSync(f, 'utf8'))).map((f) => path.relative(SRC_ROOT, f));
        expect(offenders).toEqual([]);
    });
});
