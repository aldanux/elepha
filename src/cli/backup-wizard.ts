import type { Readable, Writable } from 'node:stream';
import * as clack from '@clack/prompts';
import type { MemoryStore } from '../storage/memory-store.js';
import { ProjectResolver, type ProjectSet } from '../storage/project-resolver.js';
import { isLiveProjectPath } from './project-path.js';
import { printTagline } from './wordmark.js';

interface BackupInput extends Readable {
    isTTY?: boolean;
}

interface BackupOutput extends Writable {
    isTTY?: boolean;
}

interface PromptOption {
    value: string;
    label: string;
    hint?: string;
}

export interface BackupPrompts {
    intro(title: string): void;
    select(options: { message: string; options: PromptOption[] }): Promise<string | symbol>;
    text(options: {
        message: string;
        initialValue: string;
        validate?: (value: string | undefined) => string | undefined;
    }): Promise<string | symbol>;
    isCancel(value: unknown): boolean;
    cancel(message: string): void;
    outro(message: string): void;
}

export interface BackupWizardOptions {
    input?: BackupInput;
    output?: BackupOutput;
    store: MemoryStore;
    defaultOutput(project?: ProjectSet): string;
    backupAll(output: string): Promise<string>;
    backupProject(project: ProjectSet, output: string): Promise<string>;
    /** Test seam; production routes every visual element through @clack/prompts. */
    prompts?: BackupPrompts;
}

function clackPrompts(input: BackupInput, output: BackupOutput): BackupPrompts {
    const common = { input, output };
    return {
        intro: (title) => clack.intro(title, common),
        select: (options) => clack.select({ ...options, ...common }) as Promise<string | symbol>,
        text: (options) => clack.text({ ...options, ...common }) as Promise<string | symbol>,
        isCancel: clack.isCancel,
        cancel: (message) => clack.cancel(message, common),
        outro: (message) => clack.outro(message, common),
    };
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
            const paused = store.consent.isRevokedProjectSet(project.paths);
            return {
                value: canonicalPath,
                label: `${project.displayName}${paused ? ' (paused)' : ''}`,
                hint: `${canonicalPath} · ${sessions} sessions`,
            };
        });
    return { options, projectsByValue };
}

function cancelled(prompts: BackupPrompts): number {
    prompts.cancel('Operation cancelled. No backup was written.');
    return 0;
}

async function chooseOutput(prompts: BackupPrompts, defaultOutput: string): Promise<string | undefined> {
    const output = await prompts.text({
        message: 'Where should elepha save the backup?',
        initialValue: defaultOutput,
        validate: (value) => (value?.trim() ? undefined : 'Enter a destination path.'),
    });
    return prompts.isCancel(output) || typeof output !== 'string' ? undefined : output.trim();
}

/** Interactive scope and destination selection for `elepha backup`. */
export async function runBackupWizard(options: BackupWizardOptions): Promise<number> {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const prompts = options.prompts ?? clackPrompts(input, output);
    printTagline(output);
    prompts.intro('Back up elepha memory');

    const scope = await prompts.select({
        message: 'What should elepha back up?',
        options: [
            { value: 'all', label: 'All memory' },
            { value: 'project', label: 'A specific project' },
        ],
    });
    if (prompts.isCancel(scope)) {
        return cancelled(prompts);
    }

    if (scope === 'all') {
        const destination = await chooseOutput(prompts, options.defaultOutput());
        if (destination === undefined) {
            return cancelled(prompts);
        }
        const written = await options.backupAll(destination);
        prompts.outro(`Backup written to ${written}.`);
        return 0;
    }

    if (scope !== 'project') {
        return cancelled(prompts);
    }
    const { options: projects, projectsByValue } = projectOptions(options.store);
    if (projects.length === 0) {
        prompts.outro('No live projects with captured memory are available.');
        return 0;
    }
    const selected = await prompts.select({ message: 'Which project should elepha back up?', options: projects });
    if (prompts.isCancel(selected)) {
        return cancelled(prompts);
    }
    const project = typeof selected === 'string' ? projectsByValue.get(selected) : undefined;
    if (!project) {
        return cancelled(prompts);
    }
    const destination = await chooseOutput(prompts, options.defaultOutput(project));
    if (destination === undefined) {
        return cancelled(prompts);
    }
    const written = await options.backupProject(project, destination);
    prompts.outro(`Backup written to ${written}.`);
    return 0;
}
