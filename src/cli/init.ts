import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import * as clack from '@clack/prompts';
import { isWithin, normalizeForCompare, samePath } from '../config/paths.js';
import { IngestionDaemon } from '../daemon/index.js';
import { type DiscoveryResult, detectSessionTools, discoverFolderRepos, discoverSessionProjects } from '../discovery/session-projects.js';
import { reconcileCaptureService, serviceBackend } from '../install/service-backend.js';
import { SessionReader } from '../serving/session-reader.js';
import type { MemoryStore } from '../storage/memory-store.js';
import { ProjectResolver } from '../storage/project-resolver.js';
import { TOOL_METADATA } from '../types/index.js';
import {
    consentChanges,
    folderCandidates,
    groupFolderCandidates,
    type InitCandidate,
    type InitMode,
    individualCandidates,
} from './init-wizard.js';
import { printTagline, printWordmark } from './wordmark.js';

interface InitInput extends Readable {
    isTTY?: boolean;
}

interface InitOutput extends Writable {
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

export interface InitPrompts {
    intro(title: string): void;

    note(message: string, title?: string): void;

    spinner(): Spinner;

    select(options: { message: string; options: PromptOption[] }): Promise<InitMode | symbol>;

    multiselect(options: { message: string; options: PromptOption[]; initialValues: string[] }): Promise<string[] | symbol>;

    isCancel(value: unknown): boolean;

    cancel(message: string): void;

    outro(message: string): void;
}

export interface InitOptions {
    input?: InitInput;
    output?: InitOutput;
    error?: Writable;
    entry?: 'init' | 'consent';
    store: MemoryStore;
    discover?: () => Promise<DiscoveryResult>;
    detectTools?: () => Promise<DiscoveryResult['detectedTools']>;
    daemon?: Pick<IngestionDaemon, 'backfillApprovedRoots'>;
    reconcile?: (approvedRoots: number) => void;
    // Test seam; production routes every visual element through @clack/prompts.
    prompts?: InitPrompts;
}

function print(output: Writable, message: string): void {
    output.write(`${message}\n`);
}

function plural(count: number, singular: string): string {
    return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function toolLabel(tool: DiscoveryResult['detectedTools'][number]): string {
    return TOOL_METADATA[tool].displayName;
}

function clackPrompts(input: InitInput, output: InitOutput): InitPrompts {
    const common = { input, output };
    return {
        intro: (title) => clack.intro(title, common),
        note: (message, title) => clack.note(message, title, common),
        spinner: () => clack.spinner({ output }),
        select: (options) => clack.select({ ...options, ...common }) as Promise<InitMode | symbol>,
        multiselect: (options) => clack.multiselect({ ...options, ...common }) as Promise<string[] | symbol>,
        isCancel: clack.isCancel,
        cancel: (message) => clack.cancel(message, common),
        outro: (message) => clack.outro(message, common),
    };
}

function promptOptions(candidates: InitCandidate[]): PromptOption[] {
    return candidates.map(({ root, label, hint }) => ({ value: root, label, hint }));
}

function cancellation(prompts: InitPrompts): number {
    prompts.cancel('Operation cancelled. No changes were made.');
    return 0;
}

// Interactive consent onboarding. It intentionally has no non-interactive mode.
export async function runInit(options: InitOptions): Promise<number> {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const error = options.error ?? process.stderr;
    const entry = options.entry ?? 'init';
    const command = entry === 'consent' ? 'consent' : 'init';
    if (entry === 'init') {
        printWordmark(output);
    }
    printTagline(output);
    if (!input.isTTY) {
        print(error, `\`elepha ${command}\` requires an interactive terminal: run it and select the projects you want elepha to remember.`);
        return 1;
    }

    const prompts = options.prompts ?? clackPrompts(input, output);
    const detected = (await (options.detectTools ?? detectSessionTools)()).map(toolLabel);
    prompts.note(`Tools detected: ${detected.join(', ') || 'none'}`);
    const scan = prompts.spinner();
    scan.start('Scanning local sessions…');
    const discovery = await (options.discover ?? discoverSessionProjects)();
    scan.stop();
    if (discovery.projects.length === 0) {
        prompts.outro(`No eligible git projects found in local sessions. Run \`elepha ${command}\` again whenever you want.`);
        return 0;
    }

    const mode = await prompts.select({
        message: 'How should elepha remember your projects?',
        options: [
            { value: 'folder', label: 'By folder — every project inside it, including new ones (recommended)' },
            { value: 'individual', label: 'By individual project — only the ones you pick' },
        ],
    });
    if (prompts.isCancel(mode) || (mode !== 'folder' && mode !== 'individual')) {
        return cancellation(prompts);
    }

    const resolver = new ProjectResolver(options.store.database);
    const sessionReader = new SessionReader(options.store.database);
    const projectSets = resolver.list();
    const effectiveSessionCount = (root: string, onDiskSessionCount: number): number => {
        const normalizedRoot = normalizeForCompare(root);
        const project = projectSets.find(
            (projectSet) =>
                (projectSet.gitRoot !== null && normalizeForCompare(projectSet.gitRoot) === normalizedRoot) ||
                projectSet.paths.some((projectPath) => normalizeForCompare(projectPath) === normalizedRoot),
        );
        const total = project === undefined ? 0 : sessionReader.counts(project).total;
        return total > 0 ? total : onDiskSessionCount;
    };
    const individualSource =
        mode === 'individual'
            ? [
                  ...discovery.projects,
                  ...(await discoverFolderRepos(
                      groupFolderCandidates(discovery.projects).map((group) => group.root),
                      discovery.projects,
                  )),
              ]
            : discovery.projects;
    const candidates =
        mode === 'folder'
            ? folderCandidates(
                  discovery.projects,
                  (root) => options.store.consent.isConsented(root),
                  (root) => options.store.consent.consentState(root),
                  effectiveSessionCount,
              )
            : individualCandidates(individualSource, (root) => options.store.consent.consentState(root), effectiveSessionCount);
    const selectedRoots = await prompts.multiselect({
        message: mode === 'folder' ? 'Which folders should elepha auto-sync?' : 'Which projects should elepha auto-sync?',
        options: promptOptions(candidates),
        initialValues: candidates.filter((candidate) => candidate.approved).map((candidate) => candidate.root),
    });
    if (prompts.isCancel(selectedRoots) || !Array.isArray(selectedRoots)) {
        return cancellation(prompts);
    }

    const changes = consentChanges(candidates, selectedRoots);
    const selectedCandidates = candidates.filter((candidate) => selectedRoots.includes(candidate.root));
    const newlyApproved = selectedCandidates.filter((candidate) => !candidate.approved);
    const daemon = options.daemon ?? new IngestionDaemon({ store: options.store });
    const backfill = prompts.spinner();
    backfill.start('Backfilling newly approved projects…');
    for (const root of changes.grantRoots) {
        options.store.consent.grant(root);
    }
    const backfilledTurns =
        newlyApproved.length === 0 ? 0 : await daemon.backfillApprovedRoots(newlyApproved.map((candidate) => candidate.root));

    const pausedRoots = new Set<string>();
    for (const root of changes.revokeRoots) {
        pausedRoots.add(root);
        for (const consent of options.store.consent.list('approved')) {
            if (isWithin(root, consent.path)) {
                pausedRoots.add(consent.path);
            }
        }
    }
    const pausedFolders: string[] = [];
    if (mode === 'individual') {
        // Individual selection is the whole whitelist, so a folder-level
        // approval that covers these projects must yield to it. Pause
        // (revoke — non-destructive; memory retained, not deleted) every
        // approved root that strictly contains a candidate and is not itself
        // selected. Deletion stays with `elepha purge`.
        const selected = new Set(selectedRoots.map((root) => normalizeForCompare(root)));
        for (const consent of options.store.consent.list('approved')) {
            if (selected.has(normalizeForCompare(consent.path))) {
                continue;
            }
            if (candidates.some((candidate) => isWithin(consent.path, candidate.root) && !samePath(consent.path, candidate.root))) {
                pausedRoots.add(consent.path);
                pausedFolders.push(consent.path);
            }
        }
    }
    for (const root of pausedRoots) {
        options.store.consent.revoke(root);
    }
    backfill.stop();

    (options.reconcile ?? ((approvedRoots) => reconcileCaptureService(serviceBackend(), approvedRoots)))(
        options.store.consent.list('approved').length,
    );
    const rememberedProjects = selectedCandidates.reduce((total, candidate) => total + candidate.projectCount, 0);
    const newlyAddedProjects = newlyApproved.reduce((total, candidate) => total + candidate.projectCount, 0);
    const consentedNoSessions = selectedCandidates
        .filter((candidate) => candidate.sessionCount === 0)
        .reduce((total, candidate) => total + candidate.projectCount, 0);
    const pausedProjects = candidates
        .filter((candidate) => !selectedRoots.includes(candidate.root) && (candidate.approved || candidate.paused))
        .reduce((total, candidate) => total + candidate.projectCount, 0);
    prompts.outro(
        `elepha's memory: ${plural(rememberedProjects, 'project')}${newlyAddedProjects > 0 ? ` (${newlyAddedProjects} new)` : ''}${
            consentedNoSessions > 0 ? ` · ${consentedNoSessions} with no sessions yet` : ''
        }${
            backfilledTurns > 0 ? ` · ${plural(backfilledTurns, 'turn')} imported` : ''
        }${pausedProjects > 0 ? ` · ${plural(pausedProjects, 'project')} paused` : ''}${
            pausedFolders.length > 0
                ? ` · auto-sync paused for ${plural(pausedFolders.length, 'folder')} (${pausedFolders.map((root) => path.basename(root)).join(', ')})`
                : ''
        }\n\nRun \`elepha ${command}\` anytime to change what's remembered, or \`elepha purge --revoked\` to clear revoked projects from elepha's memory.`,
    );
    return 0;
}
