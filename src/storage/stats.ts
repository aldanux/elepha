// Local diagnostics only; these metrics are not part of served memory.

export function median(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function minMedianMax(values: number[]): { min: number; median: number; max: number; count: number } {
    if (values.length === 0) {
        return { min: 0, median: 0, max: 0, count: 0 };
    }
    return { min: Math.min(...values), median: median(values), max: Math.max(...values), count: values.length };
}

const DURATION_RE = /^(\d+)([mhd])$/;

export function parseSince(input: string): string {
    const m = DURATION_RE.exec(input);
    if (!m) {
        return new Date(input).toISOString();
    }
    const amount = Number(m[1]);
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
    return new Date(Date.now() - amount * unitMs).toISOString();
}

export interface ToolCount {
    tool: string;
    sessions: number;
    turns: number;
}

export interface ProjectCount {
    project_id: number;
    project: string;
    memories: number;
    open_pending_items: number;
}

export interface ToolZeroPaths {
    tool: string;
    zero_paths: number;
    total: number;
}

export interface StatusCount {
    summarizer_status: string;
    count: number;
}

export interface Stats {
    since: string;
    totalMemories: number;
    byTool: ToolCount[];
    memoriesPerSession: { min: number; median: number; max: number; count: number };
    pendingItemsPerSession: { min: number; median: number; max: number; count: number };
    byProject: ProjectCount[];
    // Content shape only. Consult byStatus to distinguish a quiet model result
    // from a pipeline failure.
    noise: { count: number; total: number };
    // 'not_configured' is intentional capture-only data; 'parse_error' and
    // 'api_error' are pipeline failures with the same empty-array shape.
    byStatus: StatusCount[];
    filesTouchedZero: ToolZeroPaths[];
}
