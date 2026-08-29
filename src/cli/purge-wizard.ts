import type { Readable, Writable } from 'node:stream';
import * as clack from '@clack/prompts';
import { consentedProject } from '../hooks/common.js';
import type { MemoryStore, PurgePlan, PurgeScope } from '../storage/memory-store.js';
import { ProjectResolver, type ProjectSet } from '../storage/project-resolver.js';
import { parseSince } from '../storage/stats.js';
import { isLiveProjectPath } from './project-path.js';
import { printTagline } from './wordmark.js';

interface PurgeInput extends Readable {
    isTTY?: boolean;
}

interface PurgeOutput extends Writable {
    isTTY?: boolean;
}

interface PromptOption {
    value: string;
    label: string;
    hint?: string;
}

interface Spinner {
    start(message?: string): void;

    stop(message?: string): void;
}

export interface PurgePrompts {
    intro(title: string): void;

    select(options: { message: string; options: PromptOption[] }): Promise<string | symbol>;

    text(options: {
        message: string;
        placeholder?: string;
        validate?: (value: string | undefined) => string | undefined;
    }): Promise<string | symbol>;

    confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;

    isCancel(value: unknown): boolean;

    cancel(message: string): void;

    outro(message: string): void;

    spinner(): Spinner;
}

type ScopeChoice = 'project' | 'newer-than' | 'older-than' | 'external-agent-imports' | 'orphan' | 'revoked' | 'all';

export interface PurgeWizardOptions {
    input?: PurgeInput;
    output?: PurgeOutput;
    error?: Writable;
    store: MemoryStore;
    /** Test seam; production routes every visual element through @clack/prompts. */
    prompts?: PurgePrompts;
    runPurge(scope: PurgeScope, plan: PurgePlan, confirm: (plan: PurgePlan) => Promise<boolean>): Promise<boolean>;
    runExternalAgentImports(confirm: (sessionCount: number) => Promise<boolean>): Promise<boolean>;
}

export interface PurgeScopeOptions {
    project?: string;
    here?: boolean;
    newerThan?: string;
    olderThan?: string;
    orphan?: boolean;
    revoked?: boolean;
    all?: boolean;
}

export const PURGE_HERE_UNCONSENTED =
    'The current directory is not within a consented project. Use --project <pathOrName>, or cd into the project you want to purge.';

export class PurgeHereScopeError extends Error {
    constructor() {
        super(PURGE_HERE_UNCONSENTED);
        this.name = 'PurgeHereScopeError';
    }
}

function print(output: Writable, message: string): void {
    output.write(`${message}\n`);
}

function clackPrompts(input: PurgeInput, output: PurgeOutput): PurgePrompts {
    const common = { input, output };
    return {
        intro: (title) => clack.intro(title, common),
        select: (options) => clack.select({ ...options, ...common }) as Promise<string | symbol>,
        text: (options) => clack.text({ ...options, ...common }) as Promise<string | symbol>,
        confirm: (options) => clack.confirm({ ...options, ...common }) as Promise<boolean | symbol>,
        isCancel: clack.isCancel,
        cancel: (message) => clack.cancel(message, common),
        outro: (message) => clack.outro(message, common),
        spinner: () => clack.spinner({ output }),
    };
}

function cancellation(prompts: PurgePrompts): number {
    prompts.cancel('Operation cancelled. No changes were made.');
    return 0;
}

function scopeOptions(): PromptOption[] {
    return [
        { value: 'project', label: 'A project' },
        { value: 'newer-than', label: 'Sessions newer than a date or duration' },
        { value: 'older-than', label: 'Sessions older than a date or duration' },
        { value: 'external-agent-imports', label: 'External-agent imports' },
        { value: 'orphan', label: 'Orphaned or temporary projects' },
        { value: 'revoked', label: 'Revoked projects' },
        { value: 'all', label: 'Everything' },
    ];
}

function isScopeChoice(value: unknown): value is ScopeChoice {
    return (
        value === 'project' ||
        value === 'newer-than' ||
        value === 'older-than' ||
        value === 'external-agent-imports' ||
        value === 'orphan' ||
        value === 'revoked' ||
        value === 'all'
    );
}

function dateOrDuration(value: string | undefined): string | undefined {
    try {
        parseSince(value ?? '');
        return undefined;
    } catch {
        return 'Enter a duration such as 7d, 24h, or 30m, or an ISO date.';
    }
}

function projectOptions(store: MemoryStore): { options: PromptOption[]; projectsByValue: Map<string, ProjectSet> } {
    const sessionCounts = store.sessionCountsByProject();
    const projectsByValue = new Map<string, ProjectSet>();
    const options = new ProjectResolver(store.database)
        .list()
        .map((project) => ({ project, canonicalPath: project.gitRoot ?? project.paths[0] }))
        .filter(
            (project): project is { project: ProjectSet; canonicalPath: string } =>
                project.canonicalPath !== undefined && isLiveProjectPath(project.canonicalPath),
        )
        .map(({ project, canonicalPath }) => {
            projectsByValue.set(canonicalPath, project);
            const sessions = project.projectIds.reduce((total, projectId) => total + (sessionCounts.get(projectId) ?? 0), 0);
            const revoked = store.consent.isRevokedProjectSet(project.paths);
            return {
                value: canonicalPath,
                label: `${project.displayName}${revoked ? ' (revoked)' : ''}`,
                hint: `${canonicalPath} · ${sessions} sessions`,
            };
        });
    return { options, projectsByValue };
}

export function buildPurgeScope(store: MemoryStore, options: PurgeScopeOptions): PurgeScope {
    const projects = store.listProjects();
    const hereProject = options.here ? consentedProject(store.database, process.cwd()) : undefined;
    if (options.here && hereProject === undefined) {
        throw new PurgeHereScopeError();
    }
    const selectedProjects = options.orphan ? projects.filter((project) => !isLiveProjectPath(project.path)) : [];
    const revokedProjects = options.revoked ? projects.filter((project) => store.consent.isRevoked(project.path)) : [];
    return {
        projectPath: options.here ? undefined : options.project,
        projectIds:
            hereProject !== undefined
                ? hereProject.projectIds
                : options.orphan
                  ? selectedProjects.map((project) => project.id)
                  : options.revoked
                    ? revokedProjects.map((project) => project.id)
                    : undefined,
        newerThan: options.newerThan !== undefined ? parseSince(options.newerThan) : undefined,
        olderThan: options.olderThan !== undefined ? parseSince(options.olderThan) : undefined,
        all: options.all,
    };
}

async function confirmPurge(prompts: PurgePrompts, sessionCount: number): Promise<boolean> {
    const confirmed = await prompts.confirm({
        message: `Delete elepha's memory for these ${sessionCount} session(s)? Your Claude Code / Codex history on disk is untouched. A backup is saved first.`,
        initialValue: false,
    });
    if (prompts.isCancel(confirmed) || confirmed !== true) {
        cancellation(prompts);
        return false;
    }
    return true;
}

/** Interactive front-end for the existing purge engines. It does not delete or back up data itself. */
export async function runPurgeWizard(options: PurgeWizardOptions): Promise<number> {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const error = options.error ?? process.stderr;
    if (!input.isTTY) {
        print(
            error,
            'Specify one of --project <pathOrName>, --here, --newer-than/--older-than <durationOrDate>, --external-agent-imports, --orphan, --revoked, or --all.',
        );
        return 1;
    }

    const prompts = options.prompts ?? clackPrompts(input, output);
    printTagline(output);
    prompts.intro('Purge elepha memory');
    const selected = await prompts.select({ message: 'What should elepha forget?', options: scopeOptions() });
    if (prompts.isCancel(selected) || !isScopeChoice(selected)) {
        return cancellation(prompts);
    }

    if (selected === 'external-agent-imports') {
        let cancelled = false;
        const completed = await options.runExternalAgentImports(async (sessionCount) => {
            const confirmed = await confirmPurge(prompts, sessionCount);
            cancelled ||= !confirmed;
            return confirmed;
        });
        if (!completed) {
            return cancelled ? 0 : 1;
        }
        prompts.outro('Purge complete.');
        return 0;
    }

    let value: string | undefined;
    let projectIds: number[] | undefined;
    if (selected === 'project') {
        const projects = projectOptions(options.store);
        if (projects.options.length === 0) {
            prompts.outro('No projects with captured memory are available to purge.');
            return 0;
        }
        const project = await prompts.select({ message: 'Which project should elepha forget?', options: projects.options });
        if (prompts.isCancel(project) || typeof project !== 'string') {
            return cancellation(prompts);
        }
        const selectedProject = projects.projectsByValue.get(project);
        if (selectedProject === undefined) {
            return cancellation(prompts);
        }
        projectIds = selectedProject.projectIds;
    } else if (selected === 'newer-than' || selected === 'older-than') {
        const cutoff = await prompts.text({
            message:
                selected === 'newer-than'
                    ? 'Delete sessions last ingested at or after what time?'
                    : 'Delete sessions last ingested at or before what time?',
            placeholder: '7d, 24h, or 2026-08-01',
            validate: dateOrDuration,
        });
        if (prompts.isCancel(cutoff) || typeof cutoff !== 'string') {
            return cancellation(prompts);
        }
        value = cutoff;
    }

    const scope =
        selected === 'project'
            ? { projectIds }
            : buildPurgeScope(options.store, {
                  newerThan: selected === 'newer-than' ? value : undefined,
                  olderThan: selected === 'older-than' ? value : undefined,
                  orphan: selected === 'orphan',
                  revoked: selected === 'revoked',
                  all: selected === 'all',
              });
    const preview = prompts.spinner();
    preview.start('Preparing purge preview…');
    const plan = options.store.planPurge(scope);
    preview.stop();
    let cancelled = false;
    const completed = await options.runPurge(scope, plan, async (purgePlan) => {
        const confirmed = await confirmPurge(prompts, purgePlan.sessions.length);
        cancelled ||= !confirmed;
        return confirmed;
    });
    if (!completed) {
        return cancelled ? 0 : 1;
    }
    prompts.outro(plan.sessions.length === 0 ? 'Nothing was deleted.' : 'Purge complete.');
    return 0;
}
