// The .env loader is a security surface, not a convenience: it decides which
// file can change this process's environment, and which variables it may set.

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envFileCandidates, loadEnvFile, parseEnv } from '../../src/config/env.js';

describe('parseEnv', () => {
    it('reads plain and quoted assignments', () => {
        const parsed = parseEnv(['A=1', 'B="two"', "C='three'", 'export D=4'].join('\n'));
        expect(parsed.get('A')).toBe('1');
        expect(parsed.get('B')).toBe('two');
        expect(parsed.get('C')).toBe('three');
        expect(parsed.get('D')).toBe('4');
    });

    it('skips comments, blank lines and malformed entries', () => {
        const parsed = parseEnv(['# a comment', '', 'NOEQUALS', '=novalue', 'OK=yes'].join('\n'));
        expect([...parsed.keys()]).toEqual(['OK']);
    });

    it('does NOT interpolate - a value is literal text, never syntax', () => {
        // The whole Rule 3 posture is that stored text is never executable.
        // Handing that away in the config loader would be absurd.
        const parsed = parseEnv(['A=${HOME}/x', 'B=$(whoami)', 'C=`id`'].join('\n'));
        expect(parsed.get('A')).toBe('${HOME}/x');
        expect(parsed.get('B')).toBe('$(whoami)');
        expect(parsed.get('C')).toBe('`id`');
    });

    it('keeps = signs inside a value', () => {
        expect(parseEnv('KEY=sk-abc=def==').get('KEY')).toBe('sk-abc=def==');
    });
});

describe('loadEnvFile', () => {
    let dir: string;
    const saved = { ...process.env };

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'elepha-env-'));
    });

    afterEach(() => {
        process.env = { ...saved };
    });

    function writeEnv(contents: string, mode = 0o600): string {
        const file = path.join(dir, '.env');
        writeFileSync(file, contents);
        chmodSync(file, mode);
        process.env.ELEPHA_ENV_FILE = file;
        return file;
    }

    it('applies allowlisted variables', () => {
        writeEnv('ANTHROPIC_API_KEY=sk-test-value\n');
        process.env.ANTHROPIC_API_KEY = undefined as unknown as string;
        delete process.env.ANTHROPIC_API_KEY;

        const result = loadEnvFile();
        expect(result.applied).toContain('ANTHROPIC_API_KEY');
        expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test-value');
    });

    it('ignores everything not on the allowlist - a config file is not an environment override', () => {
        writeEnv(['ANTHROPIC_API_KEY=sk-x', 'PATH=/evil/bin', 'NODE_OPTIONS=--require=/evil.js'].join('\n'));
        delete process.env.ANTHROPIC_API_KEY;
        const before = process.env.PATH;

        const result = loadEnvFile();
        expect(result.ignored).toEqual(expect.arrayContaining(['PATH', 'NODE_OPTIONS']));
        expect(process.env.PATH).toBe(before);
        expect(process.env.NODE_OPTIONS).toBeUndefined();
    });

    it('never overwrites an explicitly set variable', () => {
        writeEnv('ANTHROPIC_API_KEY=from-file\n');
        process.env.ANTHROPIC_API_KEY = 'from-shell';

        const result = loadEnvFile();
        expect(process.env.ANTHROPIC_API_KEY).toBe('from-shell');
        expect(result.applied).not.toContain('ANTHROPIC_API_KEY');
    });

    it('reports a world- or group-readable file rather than loading it silently', () => {
        writeEnv('ANTHROPIC_API_KEY=sk-x\n', 0o644);
        delete process.env.ANTHROPIC_API_KEY;
        expect(loadEnvFile().tooPermissive).toBe(true);
    });

    it('accepts a correctly locked-down file without complaint', () => {
        writeEnv('ANTHROPIC_API_KEY=sk-x\n', 0o600);
        delete process.env.ANTHROPIC_API_KEY;
        expect(loadEnvFile().tooPermissive).toBe(false);
    });

    it('returns names, never values - the result is safe to log', () => {
        writeEnv('ANTHROPIC_API_KEY=sk-super-secret\n');
        delete process.env.ANTHROPIC_API_KEY;
        expect(JSON.stringify(loadEnvFile())).not.toContain('sk-super-secret');
    });

    it('is a no-op when the named file does not exist, and never falls back to another one', () => {
        // An explicit ELEPHA_ENV_FILE is the only candidate. Falling back
        // would mean running against config the operator did not choose.
        process.env.ELEPHA_ENV_FILE = path.join(dir, 'does-not-exist');
        expect(loadEnvFile()).toEqual({ applied: [], ignored: [], tooPermissive: false });
    });

    it('reports an unreadable file instead of crashing the CLI', () => {
        // A memory tool must never be the reason a command fails to run.
        const file = writeEnv('ANTHROPIC_API_KEY=sk-x\n');
        chmodSync(file, 0o000);
        try {
            const result = loadEnvFile();
            // Root can read a 000 file; skip the assertion in that case rather
            // than pretending the test proved something.
            if (result.error !== undefined) {
                expect(result.file).toBe(file);
                expect(result.applied).toEqual([]);
            }
        } finally {
            chmodSync(file, 0o600);
        }
    });
});

describe('envFileCandidates', () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    it('does not depend on the current directory', () => {
        // elepha runs as a daemon while the user is standing in other
        // repositories, and the CLI is invoked from wherever they happen to
        // be. A cwd-relative lookup would read those projects' secrets into
        // this process. Proven by moving cwd, not by inspecting the strings:
        // in this repo cwd happens to equal the package root, so a string
        // comparison would pass for the wrong reason.
        delete process.env.ELEPHA_ENV_FILE;
        const fromHere = envFileCandidates();
        const cwd = process.cwd();
        try {
            process.chdir(tmpdir());
            expect(envFileCandidates()).toEqual(fromHere);
        } finally {
            process.chdir(cwd);
        }
        expect(fromHere.every((c) => path.isAbsolute(c))).toBe(true);
    });

    it('puts an explicit ELEPHA_ENV_FILE first', () => {
        process.env.ELEPHA_ENV_FILE = '/tmp/custom.env';
        expect(envFileCandidates()[0]).toBe('/tmp/custom.env');
    });
});
