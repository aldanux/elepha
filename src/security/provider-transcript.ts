import { O_NOFOLLOW, O_RDONLY } from 'node:constants';
import { realpathSync as fsRealpathSync, statSync as fsStatSync, type Stats } from 'node:fs';
import { type FileHandle, open as fsOpen, realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { isWithinProviderStore } from '../config/paths.js';
import type { ToolName } from '../types/index.js';

export type ProviderTranscriptOpenReason = 'transcript_outside_store' | 'transcript_missing' | 'transcript_unreadable';

export type OpenedProviderTranscript = {
    handle: FileHandle;
    resolvedPath: string;
    stat: Stats;
};

export type ProviderTranscriptOpenResult = OpenedProviderTranscript | { reason: ProviderTranscriptOpenReason };
export type ProviderTranscriptOpener = (tool: ToolName, sourcePath: string) => Promise<ProviderTranscriptOpenResult>;
export type ProviderTranscriptIdentityResult = { resolvedPath: string } | { reason: ProviderTranscriptOpenReason };
export type ProviderTranscriptIdentitySyncValidator = (
    tool: ToolName,
    sourcePath: string,
    opened: Pick<OpenedProviderTranscript, 'handle' | 'stat'>,
) => ProviderTranscriptIdentityResult;

interface ProviderTranscriptFs {
    open: (sourcePath: string, flags: number) => Promise<FileHandle>;
    realpath: (sourcePath: string) => Promise<string>;
    stat: (sourcePath: string) => Promise<Stats>;
}

function failureReason(error: unknown): ProviderTranscriptOpenReason {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'transcript_missing' : 'transcript_unreadable';
}

function validateResolvedIdentity(resolvedPath: string, resolvedStat: Stats, openedStat: Stats): ProviderTranscriptIdentityResult {
    if (resolvedStat.dev !== openedStat.dev || resolvedStat.ino !== openedStat.ino) {
        return { reason: 'transcript_unreadable' };
    }
    return { resolvedPath };
}

// Re-resolves the pathname so callers can place the recoverability decision
// immediately before their synchronous commit while retaining the opened file.
async function validateOpenedProviderTranscriptIdentity(
    tool: ToolName,
    sourcePath: string,
    opened: Pick<OpenedProviderTranscript, 'handle' | 'stat'>,
    dependencies: Pick<Partial<ProviderTranscriptFs>, 'realpath' | 'stat'> = {},
): Promise<ProviderTranscriptIdentityResult> {
    const realpath = dependencies.realpath ?? fsRealpath;
    const stat = dependencies.stat ?? fsStat;
    let resolvedPath: string;
    try {
        resolvedPath = await realpath(sourcePath);
    } catch (error) {
        return { reason: failureReason(error) };
    }
    if (!isWithinProviderStore(tool, resolvedPath)) {
        return { reason: 'transcript_outside_store' };
    }
    let resolvedStat: Stats;
    try {
        resolvedStat = await stat(resolvedPath);
    } catch (error) {
        return { reason: failureReason(error) };
    }
    return validateResolvedIdentity(resolvedPath, resolvedStat, opened.stat);
}

// The eviction boundary uses a synchronous final pass so no local async work
// can interleave between one candidate's identity check and the SQLite commit.
export function validateOpenedProviderTranscriptIdentitySync(
    tool: ToolName,
    sourcePath: string,
    opened: Pick<OpenedProviderTranscript, 'handle' | 'stat'>,
    dependencies: { realpath?: typeof fsRealpathSync; stat?: typeof fsStatSync } = {},
): ProviderTranscriptIdentityResult {
    const realpath = dependencies.realpath ?? fsRealpathSync;
    const stat = dependencies.stat ?? fsStatSync;
    let resolvedPath: string;
    try {
        resolvedPath = realpath(sourcePath);
    } catch (error) {
        return { reason: failureReason(error) };
    }
    if (!isWithinProviderStore(tool, resolvedPath)) {
        return { reason: 'transcript_outside_store' };
    }
    let resolvedStat: Stats;
    try {
        resolvedStat = stat(resolvedPath);
    } catch (error) {
        return { reason: failureReason(error) };
    }
    return validateResolvedIdentity(resolvedPath, resolvedStat, opened.stat);
}

// Opens a provider transcript and proves that the opened file is the same
// regular file reached by a fresh, contained physical path resolution.
export async function openProviderTranscript(
    tool: ToolName,
    sourcePath: string,
    dependencies: Partial<ProviderTranscriptFs> = {},
): Promise<ProviderTranscriptOpenResult> {
    const open = dependencies.open ?? fsOpen;
    const realpath = dependencies.realpath ?? fsRealpath;
    const stat = dependencies.stat ?? fsStat;

    let handle: FileHandle;
    try {
        handle = await open(sourcePath, O_RDONLY | O_NOFOLLOW);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOOP') {
            return { reason: failureReason(error) };
        }
        // Deliberately relaxes CA-10's leaf-symlink strictness to preserve established same-store symlink ingestion.
        const initialResolvedPath = await realpath(sourcePath).catch(() => undefined);
        if (initialResolvedPath === undefined) {
            return { reason: 'transcript_unreadable' };
        }
        if (!isWithinProviderStore(tool, initialResolvedPath)) {
            return { reason: 'transcript_outside_store' };
        }
        try {
            handle = await open(initialResolvedPath, O_RDONLY | O_NOFOLLOW);
        } catch (resolvedError) {
            return { reason: failureReason(resolvedError) };
        }
    }

    const fail = async (reason: ProviderTranscriptOpenReason): Promise<{ reason: ProviderTranscriptOpenReason }> => {
        await handle.close().catch(() => undefined);
        return { reason };
    };

    let openedStat: Stats;
    try {
        openedStat = await handle.stat();
    } catch (error) {
        return fail(failureReason(error));
    }
    if (!openedStat.isFile()) {
        return fail('transcript_unreadable');
    }

    const identity = await validateOpenedProviderTranscriptIdentity(tool, sourcePath, { handle, stat: openedStat }, { realpath, stat });
    if ('reason' in identity) {
        return fail(identity.reason);
    }

    return { handle, resolvedPath: identity.resolvedPath, stat: openedStat };
}
