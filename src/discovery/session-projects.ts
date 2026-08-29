// Metadata-only project discovery for `elepha init`. This deliberately does
// not use an adapter: adapters assemble turns and therefore read transcript
// content, which is forbidden before a root has been approved.

import { lstat, open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_METADATA_SCAN_BYTES, MAX_METADATA_SCAN_LINES, READABILITY_READ_CHUNK_BYTES } from '../config/constants.js';
import { claudeProjectsRoot, codexSessionsRoot, isRefusedProjectRoot, normalizeForCompare } from '../config/paths.js';
import type { ToolName } from '../types/index.js';

export interface DiscoveredProject {
    root: string;
    displayName: string;
    tools: ToolName[];
    sessionCount: number;
    earliestSessionAt: string;
    latestSessionAt: string;
}

export interface DiscoveryResult {
    detectedTools: ToolName[];
    projects: DiscoveredProject[];
}

export interface DiscoveryPaths {
    claudeProjects?: string;
    codexSessions?: string;
    isRefusedRoot?: (root: string) => boolean;
}

export interface SessionMetadata {
    cwd: string;
    timestamp: string;
}

interface CandidateAccumulator {
    root: string;
    tools: Set<ToolName>;
    sessionCount: number;
    earliestSessionAt: string;
    latestSessionAt: string;
}

const MAX_DEPTH = 6;
const NEWLINE_BYTE = 0x0a;

function discoveryStores(paths: DiscoveryPaths): Array<{ root: string; tool: ToolName; matches: (relativePath: string) => boolean }> {
    return [
        { root: paths.claudeProjects ?? claudeProjectsRoot(), tool: 'claude-code', matches: isClaudeSession },
        { root: paths.codexSessions ?? codexSessionsRoot(), tool: 'codex', matches: isCodexSession },
    ];
}

function isClaudeSession(relativePath: string): boolean {
    return relativePath.endsWith('.jsonl');
}

function isCodexSession(relativePath: string): boolean {
    return path.basename(relativePath).startsWith('rollout-') && relativePath.endsWith('.jsonl');
}

async function directoryExists(directory: string): Promise<boolean> {
    return (await stat(directory).catch(() => undefined))?.isDirectory() ?? false;
}

/**
 * Reads only enough JSONL metadata to find the session cwd and its timestamp.
 * The parsed `message`/turn payload, if present on that same line, is never
 * examined or retained. The reader stops at the first cwd line.
 */
export async function readSessionMetadata(filePath: string): Promise<SessionMetadata | undefined> {
    const handle = await open(filePath, 'r');
    let fileSize: number;
    try {
        fileSize = (await handle.stat()).size;
    } catch (error) {
        await handle.close();
        throw error;
    }
    let offset = 0;
    let scannedLines = 0;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;

    const metadataFrom = (record: Buffer): SessionMetadata | undefined => {
        let line: { cwd?: unknown; timestamp?: unknown; payload?: { cwd?: unknown } };
        try {
            line = JSON.parse(record.toString('utf8')) as { cwd?: unknown; timestamp?: unknown; payload?: { cwd?: unknown } };
        } catch {
            return undefined;
        }
        const cwd = typeof line.cwd === 'string' ? line.cwd : typeof line.payload?.cwd === 'string' ? line.payload.cwd : undefined;
        return cwd ? { cwd: path.resolve(cwd), timestamp: typeof line.timestamp === 'string' ? line.timestamp : '' } : undefined;
    };

    try {
        while (offset < fileSize && offset < MAX_METADATA_SCAN_BYTES && scannedLines < MAX_METADATA_SCAN_LINES) {
            const buffer = Buffer.alloc(Math.min(READABILITY_READ_CHUNK_BYTES, fileSize - offset, MAX_METADATA_SCAN_BYTES - offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            if (bytesRead === 0) {
                break;
            }
            offset += bytesRead;
            const data = buffer.subarray(0, bytesRead);
            let lineStart = 0;

            for (;;) {
                const newline = data.indexOf(NEWLINE_BYTE, lineStart);
                if (newline === -1) {
                    const tail = data.subarray(lineStart);
                    if (pendingBytes + tail.length > MAX_METADATA_SCAN_BYTES) {
                        return undefined;
                    }
                    if (tail.length > 0) {
                        pendingChunks.push(tail);
                        pendingBytes += tail.length;
                    }
                    break;
                }

                const lineTail = data.subarray(lineStart, newline);
                const recordBytes = pendingBytes + lineTail.length;
                if (recordBytes > MAX_METADATA_SCAN_BYTES) {
                    return undefined;
                }
                const record =
                    pendingChunks.length === 0
                        ? data.subarray(lineStart, newline)
                        : Buffer.concat(lineTail.length === 0 ? pendingChunks : [...pendingChunks, lineTail], recordBytes);
                scannedLines++;
                const metadata = metadataFrom(record);
                if (metadata) {
                    return metadata;
                }
                if (scannedLines >= MAX_METADATA_SCAN_LINES) {
                    return undefined;
                }

                pendingChunks = [];
                pendingBytes = 0;
                lineStart = newline + 1;
            }
        }

        if (offset >= fileSize && pendingBytes > 0 && scannedLines < MAX_METADATA_SCAN_LINES) {
            return metadataFrom(Buffer.concat(pendingChunks, pendingBytes));
        }
    } finally {
        await handle.close();
    }
    return undefined;
}

/**
 * Resolves a git worktree by metadata only. A `.git` directory or file is a
 * sufficient root marker; no git subprocess, config, or file contents are
 * read because the cwd originated in an unapproved transcript.
 */
async function gitRootFor(cwd: string): Promise<string | undefined> {
    let current = path.resolve(cwd);
    for (;;) {
        if (await lstat(path.join(current, '.git')).catch(() => undefined)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

function safeTimestamp(value: string): string {
    return Number.isNaN(new Date(value).getTime()) ? '' : new Date(value).toISOString();
}

/** Presence is based on a local transcript store, never on an interactive tool picker. */
export async function detectSessionTools(paths: DiscoveryPaths = {}): Promise<ToolName[]> {
    const detected: ToolName[] = [];
    for (const store of discoveryStores(paths)) {
        if (await directoryExists(store.root)) {
            detected.push(store.tool);
        }
    }
    return detected;
}

function accumulate(candidates: Map<string, CandidateAccumulator>, root: string, tool: ToolName, timestamp: string): void {
    const key = normalizeForCompare(root);
    const current = candidates.get(key);
    if (current) {
        current.tools.add(tool);
        current.sessionCount++;
        if (timestamp && (!current.earliestSessionAt || timestamp < current.earliestSessionAt)) {
            current.earliestSessionAt = timestamp;
        }
        if (timestamp && (!current.latestSessionAt || timestamp > current.latestSessionAt)) {
            current.latestSessionAt = timestamp;
        }
        return;
    }
    candidates.set(key, {
        root,
        tools: new Set([tool]),
        sessionCount: 1,
        earliestSessionAt: timestamp,
        latestSessionAt: timestamp,
    });
}

/** Metadata-only, like the rest of this module: checks directory structure and never opens transcript content. */
export async function discoverFolderRepos(
    roots: readonly string[],
    alreadyDiscovered: readonly DiscoveredProject[],
    isRefusedRoot: (root: string) => boolean = isRefusedProjectRoot,
): Promise<DiscoveredProject[]> {
    const discovered = new Set(alreadyDiscovered.map((project) => normalizeForCompare(project.root)));
    const seen = new Set<string>();
    const projects: DiscoveredProject[] = [];

    const scan = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) {
            return;
        }
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
        if (entries === undefined) {
            return;
        }
        if (entries.some((entry) => entry.name === '.git')) {
            const key = normalizeForCompare(dir);
            if (!isRefusedRoot(dir) && !discovered.has(key) && !seen.has(key)) {
                projects.push({
                    root: dir,
                    displayName: path.basename(dir),
                    tools: [],
                    sessionCount: 0,
                    earliestSessionAt: '',
                    latestSessionAt: '',
                });
                seen.add(key);
            }
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }
            await scan(path.join(dir, entry.name), depth + 1);
        }
    };

    for (const root of roots) {
        await scan(root, 0);
    }
    return projects;
}

/** Scans transcript metadata only; it never calls a turn parser or reads a turn's content. */
export async function discoverSessionProjects(paths: DiscoveryPaths = {}): Promise<DiscoveryResult> {
    const stores = discoveryStores(paths);
    const detectedTools = await detectSessionTools(paths);
    const candidates = new Map<string, CandidateAccumulator>();

    for (const store of stores) {
        if (!(await directoryExists(store.root))) {
            continue;
        }
        const files = await readdir(store.root, { recursive: true }).catch(() => [] as string[]);
        for (const relativePath of files.sort()) {
            if (!store.matches(relativePath)) {
                continue;
            }
            const metadata = await readSessionMetadata(path.join(store.root, relativePath));
            if (!metadata) {
                continue;
            }
            const gitRoot = await gitRootFor(metadata.cwd);
            const root = gitRoot ?? metadata.cwd;
            if ((paths.isRefusedRoot ?? isRefusedProjectRoot)(root)) {
                continue;
            }
            if (!(await directoryExists(root))) {
                continue;
            }
            accumulate(candidates, root, store.tool, safeTimestamp(metadata.timestamp));
        }
    }

    const projects = [...candidates.values()]
        .map((candidate) => ({
            root: candidate.root,
            displayName: path.basename(candidate.root),
            tools: [...candidate.tools].sort(),
            sessionCount: candidate.sessionCount,
            earliestSessionAt: candidate.earliestSessionAt,
            latestSessionAt: candidate.latestSessionAt,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.root.localeCompare(b.root));

    return { detectedTools, projects };
}
