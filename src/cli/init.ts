import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import * as clack from '@clack/prompts';
import { isWithin, normalizeForCompare, samePath } from '../config/paths.js';
import { getSetting, type SettingKey } from '../config/settings.js';
import { IngestionDaemon } from '../daemon/index.js';
import { type DiscoveryResult, detectSessionTools, discoverFolderRepos, discoverSessionProjects } from '../discovery/session-projects.js';
import { type ReconcileStatus, reconcileCaptureService, serviceBackend } from '../install/service-backend.js';
import { SessionReader } from '../serving/session-reader.js';
import type { MemoryStore } from '../storage/memory-store.js';
import { ProjectResolver } from '../storage/project-resolver.js';
import { TOOL_METADATA, type ToolName } from '../types/index.js';
import { errorMessage } from '../util/error.js';
import { prepareMemoryPlus } from './commands/enable.js';
import {
    CONSENT_CONTRACT_DISCLOSURE,
    SEMANTIC_SEARCH_DISCLOSURE,
    TERM_SEARCH_DISCLOSURE,
    TERM_SEARCH_RETAINS_MEMORY_PLUS,
} from './consent-disclosure.js';
import {
    ApplyFailedError,
    applyInitPlan,
    capturePreviewState,
    InitApplyBusyError,
    type InitPlan,
    isEmptyPlan,
    type PlannedRoot,
    plannedRoot,
    type RecoveryOutcome,
    recoverInterruptedInitApply,
    runPostCommitJobs,
    SemanticSetupError,
    StalePreviewError,
} from './init-apply.js';
import { consentChanges, folderCandidates, groupFolderCandidates, type InitCandidate, individualCandidates } from './init-wizard.js';
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

    select(options: { message: string; options: PromptOption[]; initialValue?: string }): Promise<string | symbol>;

    multiselect(options: { message: string; options: PromptOption[]; initialValues: string[] }): Promise<string[] | symbol>;

    confirm(options: { message: string }): Promise<boolean | symbol>;

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
    configPath?: string;
    daemon?: Pick<IngestionDaemon, 'backfillApprovedRootsReport'>;
    reconcile?: (approvedRoots: number) => ReconcileStatus | undefined;
    // Installs and verifies the local semantic model; tests stub it so no model downloads.
    prepareSemanticSearch?: () => Promise<void>;
    // Test seam; production routes every visual element through @clack/prompts.
    prompts?: InitPrompts;
}

type SearchMode = 'semantic' | 'term';

function print(output: Writable, message: string): void {
    output.write(`${message}\n`);
}

function plural(count: number, singular: string): string {
    return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function toolLabel(tool: DiscoveryResult['detectedTools'][number]): string {
    return TOOL_METADATA[tool].displayName;
}

const CAPTURE_SETTING_FOR_TOOL = {
    'claude-code': 'capture-claude-code',
    codex: 'capture-codex',
    opencode: 'capture-opencode',
} as const satisfies Record<ToolName, SettingKey>;

function clackPrompts(input: InitInput, output: InitOutput): InitPrompts {
    const common = { input, output };
    return {
        intro: (title) => clack.intro(title, common),
        note: (message, title) => clack.note(message, title, common),
        spinner: () => clack.spinner({ output }),
        select: (options) => clack.select({ ...options, ...common }) as Promise<string | symbol>,
        multiselect: (options) => clack.multiselect({ ...options, ...common }) as Promise<string[] | symbol>,
        confirm: (options) => clack.confirm({ ...options, ...common }),
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

// Progress for the post-confirmation model setup. The labels say the mode is
// not active yet: the setting flips only after setup and the commit succeed.
function spinnerProgress(prompts: InitPrompts) {
    return (message: string) => {
        const spinner = prompts.spinner();
        spinner.start(`${message} (not active yet)`);
        return {
            done: () => spinner.stop(`${message}: done`),
            fail: () => spinner.stop(`${message}: failed`),
        };
    };
}

function gapReport(gaps: string[]): string {
    return gaps.length === 0
        ? ''
        : `\n\nIncomplete, retryable:\n${gaps.map((gap) => `- ${gap}`).join('\n')}\nYour confirmed choices are saved and already captured turns are kept.`;
}

async function finishRecovery(
    recovery: RecoveryOutcome,
    prompts: InitPrompts,
    options: InitOptions,
    command: string,
    reconcile: NonNullable<InitOptions['reconcile']>,
): Promise<number> {
    const rerun = `Run \`elepha ${command}\` again to review your choices.`;
    const keptNewer = (keys: string[]): string =>
        keys.length === 0 ? '' : ` Settings changed since then were kept as they are: ${keys.join(', ')}.`;
    if (recovery.kind === 'busy') {
        prompts.cancel(
            `Another elepha setup (process ${recovery.pid}) is applying choices. Nothing was changed; try again when it finishes.`,
        );
        return 1;
    }
    if (recovery.kind === 'failed') {
        prompts.cancel(
            `An interrupted setup could not be undone (${recovery.error}). Nothing else was changed; fix the cause and run \`elepha ${command}\` again. No new choices are accepted until it is resolved.`,
        );
        return 1;
    }
    if (recovery.kind === 'undone') {
        prompts.cancel(
            `An interrupted setup was undone before it committed; your previous consent and settings are in effect.${keptNewer(recovery.superseded)} ${rerun}`,
        );
        return 1;
    }
    if (recovery.kind === 'conflict') {
        prompts.cancel(
            `An interrupted setup overlaps decisions made after it (${recovery.roots.join(', ')}). Nothing was overwritten; current consent${
                recovery.settings.length > 0 ? ` and settings (${recovery.settings.join(', ')})` : ''
            } stay as they are. ${rerun}`,
        );
        return 1;
    }
    const post = await runPostCommitJobs({
        store: options.store,
        daemon: options.daemon ?? new IngestionDaemon({ store: options.store }),
        reconcile,
        backfillRoots: recovery.backfillRoots,
    });
    post.gaps.unshift(...recovery.rootGaps);
    prompts.outro(
        `Finished an interrupted setup with the choices you confirmed earlier${
            post.backfilledTurns > 0 ? ` · ${plural(post.backfilledTurns, 'turn')} imported` : ''
        }.${keptNewer(recovery.superseded)}${gapReport(post.gaps)}\n\nRun \`elepha ${command}\` again to make further changes.`,
    );
    return post.gaps.length > 0 ? 1 : 0;
}

// Interactive consent onboarding. It intentionally has no non-interactive mode.
// Every prompt only stages a choice; nothing is written before the final
// review is confirmed, so cancelling at any step leaves everything unchanged.
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
    const reconcile = options.reconcile ?? ((approvedRoots: number) => reconcileCaptureService(serviceBackend(), approvedRoots));
    let recovery: RecoveryOutcome | undefined;
    try {
        recovery = recoverInterruptedInitApply(options.store, options.configPath);
    } catch (recoveryError) {
        prompts.cancel(`${errorMessage(recoveryError)} No new choices were applied.`);
        return 1;
    }
    if (recovery !== undefined) {
        return finishRecovery(recovery, prompts, options, command, reconcile);
    }

    // Everything the preview shows is pinned here; apply refuses the plan if
    // consent or these settings change before it commits.
    const preview = capturePreviewState(options.store, options.configPath);
    const detectedTools = await (options.detectTools ?? detectSessionTools)();
    let selectedTools: Set<string> | undefined;
    if (detectedTools.length === 0) {
        prompts.note('Tools detected: none');
    } else {
        // Pre-check each box from the tool's current capture setting, not a
        // blanket "all on": a returning `elepha consent` run must not silently
        // re-enable a tool the user previously turned off. On first `init` no
        // config exists yet, so every capture default is true and all boxes
        // start checked, which is the intended onboarding state.
        const initialTools = detectedTools.filter(
            (tool) => getSetting(CAPTURE_SETTING_FOR_TOOL[tool], undefined, options.configPath).value === true,
        );
        for (;;) {
            const selection = await prompts.multiselect({
                message: 'Which tools should elepha capture?',
                options: detectedTools.map((tool) => ({ value: tool, label: toolLabel(tool) })),
                initialValues: initialTools,
            });
            if (prompts.isCancel(selection) || !Array.isArray(selection)) {
                return cancellation(prompts);
            }
            if (selection.length > 0) {
                selectedTools = new Set(selection);
                break;
            }
            prompts.note('At least one capture tool must remain enabled.', 'Capture unchanged');
        }
    }
    const scan = prompts.spinner();
    scan.start('Scanning local sessions…');
    const discovery = await (options.discover ?? discoverSessionProjects)();
    scan.stop();
    if (discovery.projects.length === 0) {
        prompts.outro(
            `No eligible git projects found in local sessions. Nothing was changed. Run \`elepha ${command}\` again whenever you want.`,
        );
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
    const approvedConsents = options.store.consent.list('approved');
    const pausedRoots = new Map<string, string>();
    const pause = (root: string): void => {
        pausedRoots.set(normalizeForCompare(root), root);
    };
    for (const root of changes.revokeRoots) {
        pause(root);
        for (const consent of approvedConsents) {
            if (isWithin(root, consent.path)) {
                pause(consent.path);
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
        for (const consent of approvedConsents) {
            if (selected.has(normalizeForCompare(consent.path))) {
                continue;
            }
            if (candidates.some((candidate) => isWithin(consent.path, candidate.root) && !samePath(consent.path, candidate.root))) {
                pause(consent.path);
                pausedFolders.push(consent.path);
            }
        }
    }
    const grants: PlannedRoot[] = changes.grantRoots.map(plannedRoot);
    const revokes: PlannedRoot[] = [...pausedRoots.values()]
        .filter((root) => !changes.grantRoots.some((grant) => samePath(grant, root)))
        .map(plannedRoot);

    // Search mode is an `init` choice; `elepha consent` never alters it.
    const memoryPlus = getSetting('memory-plus', {}, options.configPath);
    let search: SearchMode | undefined;
    if (entry === 'init') {
        // First setup recommends local semantic search; a returning user sees
        // the mode they already chose. Neither installs anything yet.
        const choice = await prompts.select({
            message: 'How should elepha search your memory?',
            options: [
                { value: 'semantic', label: 'Local semantic search — by meaning, any language (recommended)' },
                { value: 'term', label: 'Term-only search — matching words only' },
            ],
            initialValue: memoryPlus.source === 'config' && !memoryPlus.value ? 'term' : 'semantic',
        });
        if (prompts.isCancel(choice) || (choice !== 'semantic' && choice !== 'term')) {
            return cancellation(prompts);
        }
        search = choice;
    }

    const targetSettings: InitPlan['settings'] = {};
    for (const tool of detectedTools) {
        targetSettings[CAPTURE_SETTING_FOR_TOOL[tool]] = selectedTools?.has(tool) ?? false;
    }
    if (search !== undefined) {
        targetSettings['memory-plus'] = search === 'semantic';
    }
    // A search choice made for the first time is recorded even when it matches
    // the default, so the next run preselects what the user actually chose.
    const settingsChanged = Object.entries(targetSettings).some(([key, value]) => {
        const current = getSetting(key as keyof typeof targetSettings, {}, options.configPath);
        return current.value !== value || (key === 'memory-plus' && current.source !== 'config');
    });
    const plan: InitPlan = {
        settings: settingsChanged ? targetSettings : {},
        grants,
        revokes,
        prepareSemanticSearch: search === 'semantic' && !memoryPlus.value,
        preview,
    };
    if (isEmptyPlan(plan)) {
        prompts.outro(`Nothing to change. elepha's memory settings already match your choices.`);
        return 0;
    }

    const review: string[] = [];
    if (detectedTools.length > 0) {
        const on = detectedTools.filter((tool) => selectedTools?.has(tool)).map(toolLabel);
        const off = detectedTools.filter((tool) => !selectedTools?.has(tool)).map(toolLabel);
        review.push(`Capture: ${on.join(', ')}${off.length > 0 ? ` · off: ${off.join(', ')}` : ''}`);
    }
    if (grants.length > 0) {
        review.push('Approve:', ...grants.map((planned) => `  + ${planned.canonical}`));
    }
    if (revokes.length > 0) {
        review.push('Pause (captured memory is kept):', ...revokes.map((planned) => `  - ${planned.canonical}`));
    }
    if (grants.length === 0 && revokes.length === 0) {
        review.push('Projects: no consent changes');
    }
    if (search === 'semantic') {
        review.push('', `Search: local semantic search${memoryPlus.value ? ' (already on)' : ''}`, SEMANTIC_SEARCH_DISCLOSURE);
    } else if (search === 'term') {
        review.push('', 'Search: term-only', TERM_SEARCH_DISCLOSURE, ...(memoryPlus.value ? [TERM_SEARCH_RETAINS_MEMORY_PLUS] : []));
    }
    review.push('', CONSENT_CONTRACT_DISCLOSURE);
    prompts.note(review.join('\n'), 'Review before applying');
    const confirmed = await prompts.confirm({ message: 'Apply these choices?' });
    if (prompts.isCancel(confirmed) || confirmed !== true) {
        return cancellation(prompts);
    }

    let backfillRoots: string[];
    try {
        backfillRoots = await applyInitPlan(plan, {
            store: options.store,
            configPath: options.configPath,
            prepareSemanticSearch: options.prepareSemanticSearch ?? (() => prepareMemoryPlus({ progress: spinnerProgress(prompts) })),
        });
    } catch (applyError) {
        if (applyError instanceof StalePreviewError) {
            prompts.cancel(`${applyError.message} Nothing was changed. Run \`elepha ${command}\` again for a fresh preview.`);
        } else if (applyError instanceof SemanticSetupError) {
            prompts.cancel(`${applyError.message} Nothing was changed; your previous search mode, settings and consent remain in effect.`);
        } else if (applyError instanceof InitApplyBusyError) {
            prompts.cancel(
                `Another elepha setup is applying choices. Nothing was changed; run \`elepha ${command}\` again when it finishes.`,
            );
        } else if (applyError instanceof ApplyFailedError && applyError.restored) {
            prompts.cancel(`${applyError.message} Nothing was changed.`);
        } else {
            prompts.cancel(`${errorMessage(applyError)} Run \`elepha ${command}\` again to check and recover the interrupted setup.`);
        }
        return 1;
    }

    const backfill = prompts.spinner();
    backfill.start('Importing already-written sessions for newly approved projects…');
    const post = await runPostCommitJobs({
        store: options.store,
        daemon: options.daemon ?? new IngestionDaemon({ store: options.store }),
        reconcile,
        backfillRoots,
    });
    backfill.stop();

    const newlyApproved = selectedCandidates.filter((candidate) => !candidate.approved);
    const rememberedProjects = selectedCandidates.reduce((total, candidate) => total + candidate.projectCount, 0);
    const newlyAddedProjects = newlyApproved.reduce((total, candidate) => total + candidate.projectCount, 0);
    const consentedNoSessions = selectedCandidates
        .filter((candidate) => candidate.sessionCount === 0)
        .reduce((total, candidate) => total + candidate.projectCount, 0);
    const pausedProjects = candidates
        .filter((candidate) => !selectedRoots.includes(candidate.root) && (candidate.approved || candidate.paused))
        .reduce((total, candidate) => total + candidate.projectCount, 0);
    const searchSummary =
        plan.settings['memory-plus'] === undefined
            ? ''
            : plan.settings['memory-plus']
              ? ' · local semantic search on (existing sessions are indexed in the background)'
              : ' · term-only search';
    prompts.outro(
        `elepha's memory: ${plural(rememberedProjects, 'project')}${newlyAddedProjects > 0 ? ` (${newlyAddedProjects} new)` : ''}${
            consentedNoSessions > 0 ? ` · ${consentedNoSessions} with no sessions yet` : ''
        }${
            post.backfilledTurns > 0 ? ` · ${plural(post.backfilledTurns, 'turn')} imported` : ''
        }${pausedProjects > 0 ? ` · ${plural(pausedProjects, 'project')} paused` : ''}${
            pausedFolders.length > 0
                ? ` · auto-sync paused for ${plural(pausedFolders.length, 'folder')} (${pausedFolders.map((root) => path.basename(root)).join(', ')})`
                : ''
        }${searchSummary}${gapReport(post.gaps)}\n\nRun \`elepha ${command}\` anytime to change what's remembered, or \`elepha purge --revoked\` to clear revoked projects from elepha's memory.`,
    );
    return post.gaps.length > 0 ? 1 : 0;
}
