import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { CodexAdapter } from '../../adapters/codex.js';
import { BACKUP_KEEP } from '../../config/constants.js';
import { backupDatabaseAndReport } from '../../storage/backup.js';
import { defaultDbPath, openDb } from '../../storage/db.js';
import {
    applyExternalAgentImportPurge,
    type ExternalImportPurgePlan,
    planExternalAgentImportPurge,
    verifyExternalAgentImportPurge,
} from '../../storage/external-agent-import-purge.js';
import { MemoryStore, type PurgePlan, type PurgeScope } from '../../storage/memory-store.js';
import { runDestructiveOp } from '../destructive-op.js';
import { buildPurgeScope, PurgeHereScopeError, runPurgeWizard } from '../purge-wizard.js';
import { confirmYesNo, printPurgePlan, withCapturePaused } from '../shared.js';

interface PurgeCommandOptions {
    project?: string;
    newerThan?: string;
    olderThan?: string;
    here: boolean;
    externalAgentImports: boolean;
    orphan: boolean;
    revoked: boolean;
    all: boolean;
    apply: boolean;
    skipConfirmation: boolean;
}

interface PurgeOperationOptions {
    applyRequested: boolean;
    plan?: PurgePlan;
    confirm?: (plan: PurgePlan) => Promise<boolean>;
}

interface ExternalAgentImportOperationOptions {
    applyRequested: boolean;
    confirm?: (sessionCount: number) => Promise<boolean>;
}

export function registerPurge(program: Command): void {
    program
        .command('purge')
        .description(
            'Delete sessions, turns, and rollups (and any project row left with zero sessions) — the privacy instrument behind consent revocation. Dry-run by default.',
        )
        .option('--project <pathOrName>', 'purge everything for project rows matching this path or display name')
        .option('--here', 'purge everything for the project in the current working directory')
        .option('--newer-than <durationOrDate>', 'purge sessions last ingested at or after this time (e.g. "7d", "24h", or an ISO date)')
        .option('--older-than <durationOrDate>', 'purge sessions last ingested at or before this time (e.g. "30d", or an ISO date)')
        .option('--external-agent-imports', 'purge Codex rows whose source rollouts carry external-import turn ids')
        .option('--orphan', 'purge memory whose project directory is temporary or no longer exists')
        .option('--revoked', 'purge memory for projects you have revoked')
        .option('--all', 'purge everything - every session, every project row')
        .option('--apply', 'actually perform the deletion (default is a dry run that only prints the plan)')
        .option('--skip-confirmation', 'delete without the confirmation prompt')
        .action(async (opts: PurgeCommandOptions) => {
            if (opts.project !== undefined && opts.project.trim().length === 0) {
                console.error('--project must not be empty.');
                process.exitCode = 1;
                return;
            }
            if (opts.project !== undefined && opts.here) {
                console.error('Specify only one of --project or --here.');
                process.exitCode = 1;
                return;
            }
            const scopeSelectors = [
                opts.project !== undefined || opts.here,
                opts.externalAgentImports,
                opts.orphan,
                opts.revoked,
                opts.all,
            ].filter(Boolean).length;
            const hasTimeFilter = opts.newerThan !== undefined || opts.olderThan !== undefined;
            if (opts.externalAgentImports && hasTimeFilter) {
                console.error('--external-agent-imports cannot be combined with --newer-than or --older-than.');
                process.exitCode = 1;
                return;
            }
            if (scopeSelectors === 0 && !hasTimeFilter) {
                if (!process.stdin.isTTY) {
                    console.error(
                        'Specify one of --project <pathOrName>, --here, --newer-than/--older-than <durationOrDate>, --external-agent-imports, --orphan, --revoked, or --all.',
                    );
                    process.exitCode = 1;
                    return;
                }
                const db = openDb();
                const store = new MemoryStore(db);
                process.exitCode = await runPurgeWizard({
                    store,
                    runPurge: (scope, plan, confirm) => runPurgeOperation(store, scope, { applyRequested: true, plan, confirm }),
                    runExternalAgentImports: (confirm) => runExternalAgentImportPurge(db, { applyRequested: true, confirm }),
                });
                return;
            }
            if (scopeSelectors > 1) {
                console.error('Specify only one scope: --project/--here, --external-agent-imports, --orphan, --revoked, or --all.');
                process.exitCode = 1;
                return;
            }

            const db = openDb();
            if (opts.externalAgentImports) {
                await runExternalAgentImportPurge(db, { applyRequested: opts.apply });
                return;
            }

            const store = new MemoryStore(db);
            let scope: PurgeScope;
            try {
                scope = buildPurgeScope(store, opts);
            } catch (error) {
                if (error instanceof PurgeHereScopeError) {
                    console.error(error.message);
                    process.exitCode = 1;
                    return;
                }
                throw error;
            }
            await runPurgeOperation(store, scope, {
                applyRequested: opts.apply,
                confirm: async (plan) => {
                    if (!process.stdout.isTTY || opts.skipConfirmation) {
                        return true;
                    }
                    if (await confirmPurgeDeletion(plan.sessions.length)) {
                        return true;
                    }
                    console.log('Cancelled — nothing was deleted.');
                    return false;
                },
            });
        });
}

// Existing preview -> backup -> apply -> verify engine for every SQLite purge scope.
export async function runPurgeOperation(store: MemoryStore, scope: PurgeScope, options: PurgeOperationOptions): Promise<boolean> {
    let cancelled = false;
    let verificationFailed = false;
    let appliedPlan: PurgePlan | undefined;
    // Preview BEFORE acting, every time - including under --apply. The
    // affected project list must be printed before anything is touched,
    // not as an after-the-fact report of what happened.
    const proceeded = await runDestructiveOp({
        applyRequested: options.applyRequested,
        db: store.database,
        operationLabel: 'purge',
        plan: () => options.plan ?? store.planPurge(scope),
        describe: printPurgePlan,
        isEmpty: (plan) => plan.sessions.length === 0,
        messages: {
            dryRun:
                "\nThis is a preview — nothing was deleted. This clears elepha's memory only — your original AI coding session history on disk is untouched. " +
                'Re-run with --apply to delete (a backup is saved first).',
        },
        confirm: async (plan) => {
            const confirmed = options.confirm ? await options.confirm(plan) : true;
            cancelled ||= !confirmed;
            return confirmed;
        },
        backupLog: reportPurgeBackup,
        apply: (plan) => {
            appliedPlan = store.applyPurgePlan(plan);
            const affectedProjects = new Set(appliedPlan.sessions.map((session) => session.projectId)).size;
            console.log(`Deleted ${appliedPlan.sessions.length} session(s) across ${affectedProjects} project(s) from elepha's memory.`);
        },
        verify: () => {
            const findSession = store.database.prepare('SELECT 1 FROM sessions WHERE id = ?');
            const remaining = (appliedPlan?.sessions ?? []).filter((session) => findSession.get(session.id) !== undefined);
            if (remaining.length > 0) {
                verificationFailed = true;
                console.error(`\nVERIFICATION FAILED: ${remaining.length} session(s) from the applied purge still remain.`);
                process.exitCode = 1;
            }
        },
    });
    return proceeded && !cancelled && !verificationFailed;
}

async function runExternalAgentImportPurge(db: ReturnType<typeof openDb>, options: ExternalAgentImportOperationOptions): Promise<boolean> {
    const adapter = new CodexAdapter();
    const plan = await planExternalAgentImportPurge(db, adapter);
    printExternalImportPurgePlan(plan);
    if (!options.applyRequested) {
        console.log('\nDry run only - nothing was written. Re-run with --apply to delete exactly these rows.');
        return true;
    }
    if (plan.issues.length > 0) {
        console.error('\nRefusing apply because one or more referenced Codex source transcripts could not be verified.');
        process.exitCode = 1;
        return false;
    }
    if (plan.sessions.length === 0) {
        return true;
    }
    if (options.confirm && !(await options.confirm(plan.sessions.length))) {
        return false;
    }
    let verificationFailed = false;
    const proceeded = await withCapturePaused('external-agent import purge', async () => {
        const dbPath = defaultDbPath();
        if (existsSync(dbPath)) {
            backupDatabaseAndReport(db, dbPath);
        }
        applyExternalAgentImportPurge(db, plan);
        const verification = await verifyExternalAgentImportPurge(db, adapter, plan);
        if (!verification.ok) {
            verificationFailed = true;
            console.error(`\nVERIFICATION FAILED:\n${verification.errors.map((error) => `  - ${error}`).join('\n')}`);
            process.exitCode = 1;
            return;
        }
        console.log(
            `\nDeleted ${plan.sessions.length} session row(s), ${plan.memoryRowsAffected} memory row(s), and ${plan.rollupsAffected} rollup(s). ` +
                'Verified resulting counts, foreign keys, and remaining Codex source rollouts.',
        );
    });
    return proceeded && !verificationFailed;
}

function reportPurgeBackup(message: string): void {
    if (message.startsWith('\nBacked up ')) {
        console.log(`Saved a backup of your memory database (keeping the last ${BACKUP_KEEP}).`);
    }
}

function printExternalImportPurgePlan(plan: ExternalImportPurgePlan): void {
    console.log(
        `External-agent import purge preview: scanned ${plan.sourcePathsScanned} referenced Codex source path(s); ` +
            `found ${plan.importedSourcePaths.length} imported source path(s).\n`,
    );
    for (const session of plan.sessions) {
        console.log(
            `  [${session.id}] ${session.projectPath}  (codex:${session.nativeId}, segment ${session.segmentIndex}, ` +
                `${session.memoryRows} memories)\n      ${session.sourcePath}`,
        );
    }
    if (plan.issues.length > 0) {
        console.log('\nSource path(s) that could not be classified:');
        for (const issue of plan.issues) {
            console.log(`  ${issue.sourcePath}: ${issue.reason}`);
        }
    }
    if (plan.emptiedProjects.length > 0) {
        console.log('\nProject row(s) that would be removed (left with zero sessions and no referenced memories):');
        for (const project of plan.emptiedProjects) {
            console.log(`  [${project.id}] ${project.path}`);
        }
    }
    console.log(
        `\nAffected: ${plan.sessions.length} session row(s), ${plan.memoryRowsAffected} memory row(s), ` +
            `${plan.rollupsAffected} rollup(s), ${plan.emptiedProjects.length} now-empty project row(s).`,
    );
    console.log(
        `Resulting counts: sessions ${plan.before.sessions} -> ${plan.resulting.sessions}; ` +
            `memories ${plan.before.memories} -> ${plan.resulting.memories}; ` +
            `rollups ${plan.before.rollups} -> ${plan.resulting.rollups}; ` +
            `projects ${plan.before.projects} -> ${plan.resulting.projects}.`,
    );
}

async function confirmPurgeDeletion(sessionCount: number): Promise<boolean> {
    return confirmYesNo(
        `Delete elepha's memory for these ${sessionCount} session(s)? Your Claude Code / Codex history on disk is untouched. This cannot be undone (a backup is saved). [y/N] `,
    );
}
