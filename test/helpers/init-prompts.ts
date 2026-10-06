import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { InitPrompts } from '../../src/cli/init.js';
import type { DiscoveryResult } from '../../src/discovery/session-projects.js';

export const CANCELLED = Symbol('cancelled');

type Answer<T> = T | typeof CANCELLED;

export function ttyStream(): PassThrough {
    const stream = new PassThrough();
    Object.defineProperty(stream, 'isTTY', { value: true });
    return stream;
}

// Scripted answers for the staged `elepha init` prompts. The search prompt is
// recognized by its semantic option, the tool prompt by its question.
export function fakePrompts(
    mode: Answer<'folder' | 'individual'>,
    selection: Answer<string[]>,
    captureSelections: Array<Answer<string[]>> = [],
    staged: { search?: Answer<'semantic' | 'term'>; confirm?: Answer<boolean>; onConfirm?: () => void } = {},
) {
    const events: string[] = [];
    const output = new PassThrough();
    const prompts: InitPrompts = {
        intro: (title) => events.push(`intro:${title}`),
        note: (message) => events.push(`note:${message}`),
        spinner: () => ({ start: (message) => events.push(`start:${message}`), stop: () => events.push('stop') }),
        select: vi.fn<InitPrompts['select']>(async ({ options }) =>
            options.some((option) => option.value === 'semantic') ? (staged.search ?? 'term') : mode,
        ),
        multiselect: vi.fn(async ({ message, initialValues }) =>
            message === 'Which tools should elepha capture?' ? (captureSelections.shift() ?? initialValues) : selection,
        ),
        confirm: vi.fn(async () => {
            staged.onConfirm?.();
            return staged.confirm ?? true;
        }),
        isCancel: (value) => value === CANCELLED,
        cancel: (message) => events.push(`cancel:${message}`),
        outro: (message) => events.push(`outro:${message}`),
    };
    return { prompts, events, output };
}

export function discovery(
    projects: Array<{ root: string; displayName: string; sessionCount: number }>,
    detectedTools: DiscoveryResult['detectedTools'] = ['claude-code', 'codex'],
): DiscoveryResult {
    return {
        detectedTools,
        projects: projects.map((project) => ({
            ...project,
            tools: ['codex'],
            earliestSessionAt: '2026-08-01T00:00:00.000Z',
            latestSessionAt: '2026-08-02T00:00:00.000Z',
        })),
    };
}
