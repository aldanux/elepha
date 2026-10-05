// Applies a confirmed onboarding plan.
//
// Commit boundary: config.json is written first and the consent transaction
// commits last. That transaction also deletes the vectors of revoked roots, so
// every failure before it commits leaves consent, vectors and (after undoing
// this apply's own config write) settings exactly as they were. A journal
// beside config.json records the apply from before the config write until
// after the commit, so an interruption in between is detected and resolved on
// the next run. Resolution never writes consent: the database either holds
// the committed plan or the previous rows, and anything else is a newer
// decision that is left alone. Backfill and service reconciliation run only
// after the commit; their failure is a retryable gap, never a rollback.

import { statSync } from 'node:fs';
import {
    type HeldInitApplyJournal,
    INIT_SETTING_KEYS,
    type InitApplyConsent,
    type InitApplyJournal,
    type InitSettingKey,
    initApplyOwnerIsLive,
    newInitApplyJournal,
    publishInitApplyJournal,
    readInitApplyJournal,
    releaseInitApplyJournal,
} from '../config/init-apply-journal.js';
import { canonicalizeExisting, elephaConfigPath } from '../config/paths.js';
import { configuredSettings, getSetting, type SettingsUpdate, setSettings, validateSettings } from '../config/settings.js';
import type { BackfillReport, IngestionDaemon } from '../daemon/index.js';
import type { ReconcileStatus } from '../install/service-backend.js';
import type { ConsentRoot } from '../storage/consent-store.js';
import type { MemoryStore } from '../storage/memory-store.js';
import { errorMessage } from '../util/error.js';

export { INIT_SETTING_KEYS, InitApplyBusyError } from '../config/init-apply-journal.js';

// Incomplete backfill sources listed in the final report; the rest are counted.
export const INIT_BACKFILL_GAP_DISPLAY_LIMIT = 10;

export interface PlannedRoot {
    root: string;
    // Physical path and filesystem identity resolved when the plan was previewed.
    canonical: string;
    identity: string | null;
}

export interface InitPreviewState {
    settings: string;
    consent: string;
}

export interface InitPlan {
    // Every config key to write; empty when settings are unchanged.
    settings: Partial<Record<InitSettingKey, boolean>>;
    grants: PlannedRoot[];
    revokes: PlannedRoot[];
    // True when semantic search must be installed and verified before commit.
    prepareSemanticSearch: boolean;
    preview: InitPreviewState;
}

export class StalePreviewError extends Error {
    constructor() {
        super('Projects, consent or settings changed after this preview was shown.');
        this.name = 'StalePreviewError';
    }
}

export class SemanticSetupError extends Error {
    constructor(cause: unknown) {
        super(`Local semantic search setup failed: ${errorMessage(cause)}`, { cause });
        this.name = 'SemanticSetupError';
    }
}

export class ApplyFailedError extends Error {
    // `restored` is false only when undoing this apply's own config write also
    // failed; the journal then stays behind for the next run to resolve.
    constructor(
        cause: unknown,
        readonly restored: boolean,
    ) {
        super(`Applying the confirmed choices failed: ${errorMessage(cause)}`, { cause });
        this.name = 'ApplyFailedError';
    }
}

// The physical directory a root names, as `dev:ino`; null when none exists.
function rootIdentity(canonical: string): string | null {
    try {
        const stat = statSync(canonical);
        return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
    } catch {
        return null;
    }
}

export function plannedRoot(root: string): PlannedRoot {
    const canonical = canonicalizeExisting(root);
    return { root, canonical, identity: rootIdentity(canonical) };
}

// Pending rows are excluded: the daemon records newly seen roots at any time,
// and a pending root authorizes nothing, so it cannot invalidate a preview.
function consentFingerprint(store: MemoryStore): string {
    return JSON.stringify(
        store.consent
            .list()
            .filter((root) => root.state !== 'pending')
            .map(({ ulid, path, state, decided_at, source }) => [ulid, path, state, decided_at, source]),
    );
}

function settingsFingerprint(configPath: string): string {
    return JSON.stringify(
        INIT_SETTING_KEYS.map((key) => {
            const setting = getSetting(key, {}, configPath);
            return [key, setting.value, setting.source];
        }),
    );
}

export function capturePreviewState(store: MemoryStore, configPath: string = elephaConfigPath()): InitPreviewState {
    return { settings: settingsFingerprint(configPath), consent: consentFingerprint(store) };
}

export function isEmptyPlan(plan: InitPlan): boolean {
    return Object.keys(plan.settings).length === 0 && plan.grants.length === 0 && plan.revokes.length === 0;
}

function assertStateFresh(plan: InitPlan, store: MemoryStore, configPath: string): void {
    const current = capturePreviewState(store, configPath);
    if (current.settings !== plan.preview.settings || current.consent !== plan.preview.consent) {
        throw new StalePreviewError();
    }
}

// Filesystem work, so it runs before the write transaction opens.
function assertRootsUnchanged(plan: InitPlan): void {
    for (const planned of [...plan.revokes, ...plan.grants]) {
        let canonical: string;
        try {
            canonical = canonicalizeExisting(planned.root);
        } catch {
            throw new StalePreviewError();
        }
        if (canonical !== planned.canonical || rootIdentity(canonical) !== planned.identity) {
            throw new StalePreviewError();
        }
    }
}

function currentSettings(journal: InitApplyJournal): Record<string, boolean | undefined> {
    return configuredSettings(Object.keys(journal.settings) as InitSettingKey[], journal.configPath);
}

// Puts back only keys that still hold this apply's own target value. A key
// holding anything else was changed by someone later and is left alone.
function revertOwnSettings(journal: InitApplyJournal): string[] {
    const current = currentSettings(journal);
    const revert: SettingsUpdate = {};
    const superseded: string[] = [];
    for (const [key, setting] of Object.entries(journal.settings)) {
        const value = current[key];
        if (value === (setting.previous ?? undefined)) {
            continue;
        }
        if (value === setting.target) {
            revert[key as InitSettingKey] = setting.previous === null ? null : String(setting.previous);
        } else {
            superseded.push(key);
        }
    }
    if (Object.keys(revert).length > 0) {
        setSettings(revert, journal.configPath);
    }
    return superseded;
}

export interface ApplyInitPlanOptions {
    store: MemoryStore;
    configPath?: string;
    prepareSemanticSearch: () => Promise<void>;
}

// Returns the newly approved roots for the post-commit backfill.
export async function applyInitPlan(plan: InitPlan, options: ApplyInitPlanOptions): Promise<string[]> {
    const { store } = options;
    const configPath = options.configPath ?? elephaConfigPath();
    assertStateFresh(plan, store, configPath);
    assertRootsUnchanged(plan);
    const target: SettingsUpdate = Object.fromEntries(Object.entries(plan.settings).map(([key, value]) => [key, String(value)]));
    const writesSettings = Object.keys(target).length > 0;
    if (writesSettings) {
        // An unreadable or invalid config.json is refused before anything changes.
        try {
            validateSettings(target, configPath);
        } catch (error) {
            throw new ApplyFailedError(error, true);
        }
    }
    if (plan.prepareSemanticSearch) {
        try {
            await options.prepareSemanticSearch();
        } catch (error) {
            throw new SemanticSetupError(error);
        }
        // Setup can take minutes; recheck everything it could have outlived.
        assertStateFresh(plan, store, configPath);
        assertRootsUnchanged(plan);
    }

    const previous = configuredSettings(Object.keys(plan.settings) as InitSettingKey[], configPath);
    const consent: InitApplyConsent[] = [
        ...plan.revokes.map((planned) => ({ planned, target: 'denied' as const })),
        ...plan.grants.map((planned) => ({ planned, target: 'approved' as const })),
    ].map(({ planned, target }) => ({
        root: planned.canonical,
        previous: store.consent.exactDecision(planned.canonical) ?? null,
        target,
        identity: planned.identity,
    }));
    const journal = newInitApplyJournal(
        configPath,
        Object.fromEntries(
            Object.entries(plan.settings).map(([key, value]) => [
                key,
                { previous: previous[key as InitSettingKey] ?? null, target: value },
            ]),
        ),
        consent,
        plan.grants.map((planned) => planned.canonical),
    );
    // Throws InitApplyBusyError before any change when another apply owns it.
    const held = publishInitApplyJournal(journal);

    const undo = (cause: unknown): never => {
        try {
            revertOwnSettings(journal);
            releaseInitApplyJournal(held);
        } catch {
            throw new ApplyFailedError(cause, false);
        }
        throw cause instanceof StalePreviewError ? cause : new ApplyFailedError(cause, true);
    };

    try {
        // A writer that checked for a journal just before it was published
        // could still have landed; everything captured above must still hold.
        assertStateFresh(plan, store, configPath);
    } catch (error) {
        releaseInitApplyJournal(held);
        throw error;
    }
    if (writesSettings) {
        try {
            setSettings(target, configPath);
        } catch (error) {
            undo(error);
        }
    }
    try {
        assertRootsUnchanged(plan);
        store.database
            .transaction(() => {
                // The decisive authorization check repeats inside the
                // transaction: a grant or revoke may have landed since.
                if (consentFingerprint(store) !== plan.preview.consent) {
                    throw new StalePreviewError();
                }
                for (const planned of plan.revokes) {
                    store.consent.revoke(planned.root);
                }
                for (const planned of plan.grants) {
                    store.consent.grant(planned.root);
                }
            })
            .immediate();
    } catch (error) {
        undo(error);
    }
    // Committed. A journal that cannot be removed now is resolved as
    // committed by the next run, so it is not a failure of this apply.
    try {
        releaseInitApplyJournal(held);
    } catch {
        // Left for recovery.
    }
    return journal.backfillRoots;
}

export type RecoveryOutcome =
    | { kind: 'busy'; pid: number }
    | { kind: 'committed'; backfillRoots: string[]; superseded: string[]; rootGaps: string[] }
    | { kind: 'undone'; superseded: string[] }
    | { kind: 'conflict'; roots: string[]; settings: string[] }
    | { kind: 'failed'; error: string };

function sameRow(row: ConsentRoot | undefined, previous: ConsentRoot | null): boolean {
    if (row === undefined || previous === null) {
        return row === undefined && previous === null;
    }
    return (
        row.ulid === previous.ulid &&
        row.state === previous.state &&
        row.decided_at === previous.decided_at &&
        row.source === previous.source
    );
}

// Resolves an apply interrupted between its journal and its release. The
// consent transaction is the commit point: when it committed, the confirmed
// plan stands (config.json was written before it); when it did not, only
// config keys still holding this apply's target are put back. Consent is never
// written here, so a newer revoke is never undone and no changed physical
// root is re-authorized.
export function recoverInterruptedInitApply(store: MemoryStore, configPath: string = elephaConfigPath()): RecoveryOutcome | undefined {
    const held: HeldInitApplyJournal | undefined = readInitApplyJournal(configPath);
    if (held === undefined) {
        return undefined;
    }
    const { journal } = held;
    if (initApplyOwnerIsLive(journal)) {
        return { kind: 'busy', pid: journal.pid };
    }
    const committed: string[] = [];
    const untouched: string[] = [];
    const conflicting: string[] = [];
    for (const entry of journal.consent) {
        const row = store.consent.exactDecision(entry.root);
        if (sameRow(row, entry.previous) || (entry.previous === null && row?.state === 'pending')) {
            untouched.push(entry.root);
        } else if (row?.state === entry.target && row.source === 'cli') {
            committed.push(entry.root);
        } else {
            conflicting.push(entry.root);
        }
    }
    const current = currentSettings(journal);
    if (conflicting.length > 0 || (committed.length > 0 && untouched.length > 0)) {
        releaseInitApplyJournal(held);
        return { kind: 'conflict', roots: [...conflicting, ...committed], settings: Object.keys(journal.settings) };
    }
    const settingsLanded = Object.entries(journal.settings).every(([key, setting]) => current[key] === setting.target);
    // Without consent changes the atomic config write is the commit point.
    const planCommitted = journal.consent.length > 0 ? committed.length === journal.consent.length : settingsLanded;
    if (planCommitted) {
        const superseded = Object.entries(journal.settings)
            .filter(([key, setting]) => current[key] !== setting.target)
            .map(([key]) => key);
        releaseInitApplyJournal(held);
        // Backfill only the exact physical directory the user confirmed. A root
        // that is missing, was replaced at the same path, now resolves elsewhere
        // or had no verifiable directory in the preview keeps its committed
        // consent but is reported instead of imported under that approval.
        const backfillRoots: string[] = [];
        const rootGaps: string[] = [];
        for (const root of journal.backfillRoots) {
            const confirmed = journal.consent.find((entry) => entry.root === root)?.identity ?? null;
            const current = canonicalizeExisting(root) === root ? rootIdentity(root) : null;
            if (confirmed !== null && current === confirmed) {
                backfillRoots.push(root);
            } else {
                const problem =
                    confirmed === null
                        ? 'could not be verified as a directory when you confirmed it'
                        : current === null
                          ? 'is missing or no longer resolves to the confirmed directory'
                          : 'was replaced by a different directory at the same path';
                rootGaps.push(
                    `Importing already-written sessions for ${root} was skipped: it ${problem}. Its consent is kept. Check the folder, then retry with: elepha consent grant ${JSON.stringify(root)}`,
                );
            }
        }
        return { kind: 'committed', backfillRoots, superseded, rootGaps };
    }
    let superseded: string[];
    try {
        superseded = revertOwnSettings(journal);
    } catch (error) {
        return { kind: 'failed', error: errorMessage(error) };
    }
    releaseInitApplyJournal(held);
    return { kind: 'undone', superseded };
}

export interface PostCommitOptions {
    store: MemoryStore;
    daemon: Pick<IngestionDaemon, 'backfillApprovedRootsReport'>;
    reconcile: (approvedRoots: number) => ReconcileStatus | undefined;
    backfillRoots: string[];
}

export interface PostCommitResult {
    backfilledTurns: number;
    // Each entry names one incomplete job, its sources and how to retry it.
    gaps: string[];
}

function retryCommand(roots: string[]): string {
    return roots.map((root) => `elepha consent grant ${JSON.stringify(root)}`).join(' ; ');
}

export function backfillGap(report: BackfillReport, roots: string[]): string | undefined {
    if (report.incomplete.length === 0) {
        return undefined;
    }
    const shown = report.incomplete.slice(0, INIT_BACKFILL_GAP_DISPLAY_LIMIT);
    const hidden = report.incomplete.length - shown.length;
    return [
        `Importing already-written sessions is incomplete: ${report.incomplete.length} source(s) could not be read; ${report.ingested} turn(s) were imported and kept.`,
        ...shown.map((entry) => `  ${entry.source} (${entry.category}: ${entry.reason})`),
        ...(hidden > 0 ? [`  and ${hidden} more`] : []),
        `  Fix the cause, then retry with: ${retryCommand(roots)}`,
    ].join('\n');
}

export async function runPostCommitJobs(options: PostCommitOptions): Promise<PostCommitResult> {
    const gaps: string[] = [];
    let backfilledTurns = 0;
    if (options.backfillRoots.length > 0) {
        try {
            const report = await options.daemon.backfillApprovedRootsReport(options.backfillRoots);
            backfilledTurns = report.ingested;
            const gap = backfillGap(report, options.backfillRoots);
            if (gap !== undefined) {
                gaps.push(gap);
            }
        } catch (error) {
            gaps.push(
                `Importing already-written sessions failed: ${errorMessage(error)} Retry with: ${retryCommand(options.backfillRoots)}`,
            );
        }
    }
    try {
        if (options.reconcile(options.store.consent.countApproved()) === 'not installed') {
            gaps.push('Capture awaits `elepha install`; nothing new is captured until the service is installed.');
        }
    } catch (error) {
        gaps.push(`Capture service failed to reconcile: ${errorMessage(error)} Run \`elepha doctor\`, then \`elepha install\` to retry.`);
    }
    return { backfilledTurns, gaps };
}
