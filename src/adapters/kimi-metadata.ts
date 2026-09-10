import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { MAX_METADATA_SCAN_BYTES } from '../config/constants.js';
import {
    canonicalizeExisting,
    isRefusedProjectRoot,
    kimiSessionDir,
    kimiSessionIndexPath,
    kimiSessionStatePath,
    samePath,
} from '../config/paths.js';
import { openProviderTranscript, validateOpenedProviderTranscriptIdentitySync } from '../security/provider-transcript.js';
import { readBoundedLines } from './base.js';

export interface KimiMetadata {
    cwd: string;
    timestamp: string;
    title?: string;
    customTitle?: string;
    forked: boolean;
    validate: () => boolean;
}

export function kimiTimestamp(value: unknown): string | undefined {
    if (typeof value !== 'number' && typeof value !== 'string') {
        return undefined;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

// Metadata paths are constructed from the opened session location, never from wire content.
export async function readKimiMetadata(wirePath: string): Promise<KimiMetadata | undefined> {
    const sessionId = path.basename(kimiSessionDir(wirePath));
    const statePath = kimiSessionStatePath(wirePath);
    let fallbackForked = false;
    let validateState = () => !existsSync(statePath);
    const opened = await openProviderTranscript('kimi', statePath);
    if (!('reason' in opened)) {
        try {
            if (opened.stat.size > MAX_METADATA_SCAN_BYTES) {
                throw new Error(`Kimi state exceeds metadata byte limit: ${statePath}`);
            }
            const bytes = Buffer.alloc(opened.stat.size);
            const { bytesRead } = await opened.handle.read(bytes, 0, bytes.length, 0);
            const state = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
            if (state.id !== sessionId || state.version !== 2) {
                throw new Error(`Unrecognized Kimi state identity/version: ${statePath}`);
            }
            const validate = () => {
                if ('reason' in validateOpenedProviderTranscriptIdentitySync('kimi', statePath, opened)) {
                    return false;
                }
                const current = statSync(statePath);
                return current.size === opened.stat.size && current.mtimeMs === opened.stat.mtimeMs;
            };
            if (!validate()) {
                throw new Error(`Kimi state changed while reading: ${statePath}`);
            }
            fallbackForked = state.forkedFrom != null;
            validateState = validate;
            if (typeof state.cwd === 'string' && path.isAbsolute(state.cwd)) {
                if (isRefusedProjectRoot(state.cwd)) {
                    throw new Error(`Refused Kimi project root: ${statePath}`);
                }
                const cwd = canonicalizeExisting(state.cwd);
                return {
                    cwd,
                    timestamp: kimiTimestamp(state.updatedAt) ?? kimiTimestamp(state.createdAt) ?? '',
                    title: typeof state.title === 'string' ? state.title : undefined,
                    customTitle: state.isCustomTitle && typeof state.title === 'string' ? state.title : undefined,
                    forked: state.forkedFrom != null,
                    validate: () => validate() && samePath(canonicalizeExisting(state.cwd), cwd),
                };
            }
        } finally {
            await opened.handle.close();
        }
    } else if (opened.reason !== 'transcript_missing') {
        throw new Error(`Cannot read Kimi state: ${statePath} (${opened.reason})`);
    }

    const indexPath = kimiSessionIndexPath();
    const index = await openProviderTranscript('kimi', indexPath);
    if ('reason' in index) {
        throw new Error(`Cannot read Kimi metadata fallback: ${indexPath} (${index.reason})`);
    }
    try {
        let cwd: string | undefined;
        let literalCwd: string | undefined;
        for await (const line of readBoundedLines(indexPath, { handle: index.handle })) {
            if (!line.terminated) {
                break;
            }
            const record = JSON.parse(line.text);
            if (record.sessionId !== sessionId) {
                continue;
            }
            if (record.deleted === true) {
                cwd = undefined;
                literalCwd = undefined;
            } else if (typeof record.workDir === 'string' && path.isAbsolute(record.workDir)) {
                if (
                    isRefusedProjectRoot(record.workDir) ||
                    (typeof record.sessionDir === 'string' &&
                        !samePath(canonicalizeExisting(record.sessionDir), canonicalizeExisting(kimiSessionDir(wirePath))))
                ) {
                    throw new Error(`Kimi index project/session binding is invalid: ${indexPath}`);
                }
                literalCwd = record.workDir;
                cwd = canonicalizeExisting(record.workDir);
            }
        }
        const validate = () => {
            if (!validateState() || (literalCwd && !samePath(canonicalizeExisting(literalCwd), cwd ?? ''))) {
                return false;
            }
            if ('reason' in validateOpenedProviderTranscriptIdentitySync('kimi', indexPath, index)) {
                return false;
            }
            const current = statSync(indexPath);
            return current.size === index.stat.size && current.mtimeMs === index.stat.mtimeMs;
        };
        if (!validate()) {
            throw new Error(`Kimi index changed while reading: ${indexPath}`);
        }
        return cwd ? { cwd, timestamp: '', forked: fallbackForked, validate } : undefined;
    } finally {
        await index.handle.close();
    }
}
