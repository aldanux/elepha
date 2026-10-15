// Exact-session lookup shares the hook deadline and never reads unrelated rollouts.
export const CODEX_TASK_SOURCE_LOOKUP_MAX_ENTRIES = 8192;
export const CODEX_TASK_SOURCE_LOOKUP_MAX_DEPTH = 3;

export const CODEX_TASK_SOURCE_KIND = {
    projectInstructions: 'project_instructions',
    assistantBeforeReport: 'assistant_before_report',
} as const;

export const CODEX_TASK_SOURCE_LOOKUP_CODE = {
    missing: 'ENOENT',
    ambiguous: 'EEXIST',
    incomplete: 'E2BIG',
    unreadable: 'EACCES',
    changed: 'EAGAIN',
    invalidId: 'EINVAL',
} as const;
