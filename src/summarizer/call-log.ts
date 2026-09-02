// Dogfooding instrumentation - one JSON-line per summarizer call, rotated by
// date and retained for a bounded diagnostic window. Answers: does cost or
// rate limiting bite under real parallel-project use?

import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { SUMMARIZER_LOG_RETENTION_DAYS } from '../config/constants.js';
import { elephaLogDir } from '../config/paths.js';
import { hardenDir, hardenFile } from '../security/file-permissions.js';
import type { SummarizerStatus } from '../types/index.js';

export interface SummarizerCallLogEntry {
    timestamp: string;
    job: 'turn_extraction' | 'rollup_merge';
    latencyMs: number;
    inputTokens: number | null;
    cacheCreationInputTokens: number | null;
    cacheReadInputTokens: number | null;
    outputTokens: number | null;
    attempt: number;
    rateLimited: boolean;
    error: string | null;
    // Distinguishes API success from an unparseable successful response;
    // both previously looked like error:null.
    status: SummarizerStatus;
}

export function defaultCallLogDir(): string {
    return elephaLogDir();
}

const MAX_ERROR_LENGTH = 300;
// API client errors can echo request headers or key material back in their
// message text (e.g. a 401 quoting the rejected Authorization header).
// Redact anything key/token-shaped before it reaches disk - this is a
// backstop, not a parser, so it's deliberately broad rather than tied to one
// provider's key format.
const BEARER_RE = /Bearer\s+\S+/gi;
const KEY_LIKE_RE = /\b[A-Za-z0-9_-]{20,}\b/g;
const SUMMARIZER_LOG_NAME_RE = /^summarizer-(\d{4}-\d{2}-\d{2})\.log$/;

interface SummarizerCallLogDependencies {
    today(): string;
    readText(file: string): string;
    removeFile(file: string): void;
}

const DEFAULT_DEPENDENCIES: SummarizerCallLogDependencies = {
    today: () => new Date().toISOString().slice(0, 10),
    readText: (file) => readFileSync(file, 'utf8'),
    removeFile: (file) => unlinkSync(file),
};

function validIsoDate(value: string): string | undefined {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

function datedLogFilenameDate(filename: string): string | undefined {
    const match = SUMMARIZER_LOG_NAME_RE.exec(filename);
    return match ? validIsoDate(match[1]) : undefined;
}

// Truncates and redacts key/token-shaped substrings from an error message before it's logged.
export function sanitizeErrorMessage(message: string): string {
    let out = message.replace(BEARER_RE, 'Bearer [redacted]').replace(KEY_LIKE_RE, '[redacted]');
    if (out.length > MAX_ERROR_LENGTH) {
        out = `${out.slice(0, MAX_ERROR_LENGTH)}…[truncated]`;
    }
    return out;
}

export class SummarizerCallLog {
    private readonly dependencies: SummarizerCallLogDependencies;

    constructor(
        private readonly dir: string = defaultCallLogDir(),
        dependencies: Partial<SummarizerCallLogDependencies> = {},
    ) {
        this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    }

    private fileFor(date: Date): string {
        return path.join(this.dir, `summarizer-${date.toISOString().slice(0, 10)}.log`);
    }

    append(entry: SummarizerCallLogEntry): void {
        mkdirSync(this.dir, { recursive: true });
        hardenDir(this.dir);
        const file = this.fileFor(new Date(entry.timestamp));
        appendFileSync(file, `${JSON.stringify(entry)}\n`);
        hardenFile(file);
        try {
            this.pruneExpiredFiles();
        } catch {
            // Diagnostic retention is best-effort and must not affect a summarizer call.
        }
    }

    private pruneExpiredFiles(): void {
        const cutoff = new Date(`${this.dependencies.today()}T00:00:00.000Z`);
        cutoff.setUTCHours(0, 0, 0, 0);
        cutoff.setUTCDate(cutoff.getUTCDate() - SUMMARIZER_LOG_RETENTION_DAYS);
        const cutoffDate = cutoff.toISOString().slice(0, 10);

        for (const filename of readdirSync(this.dir)) {
            const fileDate = datedLogFilenameDate(filename);
            if (!fileDate || fileDate >= cutoffDate) {
                continue;
            }
            try {
                this.dependencies.removeFile(path.join(this.dir, filename));
            } catch {
                // Keep pruning other expired logs if one file cannot be removed.
            }
        }
    }

    // Dated files older than the threshold day are rejected before opening.
    readEntriesSince(sinceIso: string): SummarizerCallLogEntry[] {
        let files: string[];
        try {
            files = readdirSync(this.dir).filter((f) => f.startsWith('summarizer-') && f.endsWith('.log'));
        } catch {
            return [];
        }

        const today = this.dependencies.today();
        const sinceDate = validIsoDate(sinceIso.slice(0, 10)) ?? today;
        const entries: SummarizerCallLogEntry[] = [];
        for (const file of files) {
            // Unknown shapes are treated as current so a future naming change
            // cannot make diagnostic entries disappear silently.
            if ((datedLogFilenameDate(file) ?? today) < sinceDate) {
                continue;
            }
            const text = this.dependencies.readText(path.join(this.dir, file));
            for (const line of text.split('\n')) {
                if (!line.trim()) {
                    continue;
                }
                try {
                    const entry = JSON.parse(line) as SummarizerCallLogEntry;
                    if (entry.timestamp >= sinceIso) {
                        entries.push(entry);
                    }
                } catch {
                    // malformed line - skip rather than fail the whole read
                }
            }
        }
        return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }
}
