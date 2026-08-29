import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { type FileHandle, open as fsOpen, realpath as fsRealpath } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexSessionsRoot } from '../../src/config/paths.js';
import { openProviderTranscript } from '../../src/security/provider-transcript.js';
import { withTempDir } from '../helpers/tmp.js';

describe('opened provider transcript containment', () => {
    afterEach(() => vi.unstubAllEnvs());

    function fixture(): {
        alias: string;
        sourcePath: string;
        retarget: (target: string) => void;
        insideReplacement: string;
        outside: string;
    } {
        const directory = withTempDir('elepha-provider-open-');
        vi.stubEnv('CODEX_HOME', path.join(directory, '.codex'));
        const store = codexSessionsRoot();
        const inside = path.join(store, 'inside');
        const insideReplacement = path.join(store, 'replacement');
        const outside = path.join(directory, 'outside');
        const alias = path.join(store, 'alias');
        for (const candidate of [inside, insideReplacement, outside]) {
            mkdirSync(candidate, { recursive: true });
            writeFileSync(path.join(candidate, 'episode.jsonl'), `${candidate}\n`);
        }
        symlinkSync(inside, alias, 'dir');
        return {
            alias,
            sourcePath: path.join(alias, 'episode.jsonl'),
            retarget: (target) => {
                unlinkSync(alias);
                symlinkSync(target, alias, 'dir');
            },
            insideReplacement,
            outside,
        };
    }

    it('refuses an opened file when a parent symlink is retargeted outside before the fresh realpath', async () => {
        const { sourcePath, retarget, outside } = fixture();
        let openedHandle: FileHandle | undefined;

        const result = await openProviderTranscript('codex', sourcePath, {
            open: async (candidate, flags) => {
                openedHandle = await fsOpen(candidate, flags);
                return openedHandle;
            },
            realpath: async (candidate) => {
                expect(candidate).toBe(sourcePath);
                retarget(outside);
                return fsRealpath(candidate);
            },
        });

        expect(result).toEqual({ reason: 'transcript_outside_store' });
        await expect(openedHandle!.stat()).rejects.toMatchObject({ code: 'EBADF' });
    });

    it('refuses an in-store retarget when the fresh pathname names a different inode', async () => {
        const { sourcePath, retarget, insideReplacement } = fixture();

        const result = await openProviderTranscript('codex', sourcePath, {
            realpath: async (candidate) => {
                retarget(insideReplacement);
                return fsRealpath(candidate);
            },
        });

        expect(result).toEqual({ reason: 'transcript_unreadable' });
    });

    it('returns one caller-owned handle for an unchanged regular file inside the provider store', async () => {
        const { sourcePath } = fixture();

        const result = await openProviderTranscript('codex', sourcePath);

        expect(result).not.toHaveProperty('reason');
        if ('reason' in result) throw new Error(result.reason);
        await expect(result.handle.stat()).resolves.toMatchObject({ dev: result.stat.dev, ino: result.stat.ino });
        expect(await fsRealpath(sourcePath)).toBe(result.resolvedPath);
        await result.handle.close();
    });

    it('follows an in-store symlinked leaf and refuses one whose target is outside the provider store', async () => {
        const directory = withTempDir('elepha-provider-open-leaf-symlink-');
        vi.stubEnv('CODEX_HOME', path.join(directory, '.codex'));
        const store = codexSessionsRoot();
        const insideTarget = path.join(store, 'inside.jsonl');
        const outsideTarget = path.join(directory, 'outside.jsonl');
        const insideLink = path.join(store, 'inside-link.jsonl');
        const outsideLink = path.join(store, 'outside-link.jsonl');
        mkdirSync(store, { recursive: true });
        writeFileSync(insideTarget, 'inside\n');
        writeFileSync(outsideTarget, 'outside\n');
        symlinkSync(insideTarget, insideLink);
        symlinkSync(outsideTarget, outsideLink);

        const insideResult = await openProviderTranscript('codex', insideLink);
        expect(insideResult).not.toHaveProperty('reason');
        if ('reason' in insideResult) throw new Error(insideResult.reason);
        await expect(insideResult.handle.readFile('utf8')).resolves.toBe('inside\n');
        await insideResult.handle.close();
        await expect(openProviderTranscript('codex', outsideLink)).resolves.toEqual({ reason: 'transcript_outside_store' });
    });

    it('keeps missing and non-regular failures on the existing reason vocabulary', async () => {
        const directory = withTempDir('elepha-provider-open-reasons-');
        vi.stubEnv('CODEX_HOME', path.join(directory, '.codex'));
        const store = codexSessionsRoot();
        mkdirSync(store, { recursive: true });

        await expect(openProviderTranscript('codex', path.join(store, 'missing.jsonl'))).resolves.toEqual({
            reason: 'transcript_missing',
        });
        await expect(openProviderTranscript('codex', store)).resolves.toEqual({ reason: 'transcript_unreadable' });
    });
});
