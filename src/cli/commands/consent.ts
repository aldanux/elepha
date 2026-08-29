import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { canonicalizeExisting, isRefusedProjectRoot } from '../../config/paths.js';
import { IngestionDaemon } from '../../daemon/index.js';
import { reconcileCaptureService, serviceBackend } from '../../install/service-backend.js';
import { type ConsentRoot, ConsentStore } from '../../storage/consent-store.js';
import { openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { errorMessage } from '../../util/error.js';
import { runDestructiveOp } from '../destructive-op.js';
import { runInit } from '../init.js';
import { confirmYesNo } from '../shared.js';

interface ConsentPathOptions {
    here?: boolean;
}

interface ConsentPruneOptions {
    apply: boolean;
    skipConfirmation: boolean;
}

type ConsentPruneReason = 'missing' | 'refused';

interface ConsentPruneCandidate {
    root: ConsentRoot;
    reason: ConsentPruneReason;
}

class ConsentPruneChangedError extends Error {
    constructor(readonly paths: string[]) {
        super('Consent roots changed since preview.');
        this.name = 'ConsentPruneChangedError';
    }
}

function resolveConsentPath(rootPath: string | undefined, options: ConsentPathOptions): string | undefined {
    const hasPath = rootPath !== undefined;
    const hasHere = options.here === true;
    if (hasPath === hasHere) {
        console.error('Choose exactly one consent root: provide <path> or pass --here.');
        process.exitCode = 1;
        return undefined;
    }
    return path.resolve(rootPath ?? process.cwd());
}

function consentPruneReason(rootPath: string): ConsentPruneReason | undefined {
    if (!existsSync(rootPath)) {
        return 'missing';
    }
    try {
        return isRefusedProjectRoot(canonicalizeExisting(rootPath)) ? 'refused' : undefined;
    } catch {
        return 'missing';
    }
}

function planConsentPrune(store: ConsentStore): ConsentPruneCandidate[] {
    return store.list().flatMap((root) => {
        const reason = consentPruneReason(root.path);
        return reason === undefined ? [] : [{ root, reason }];
    });
}

async function confirmConsentPrune(count: number): Promise<boolean> {
    return confirmYesNo(`Remove these ${count} stale or refused consent root(s) from consent list? Captured memory will be kept. [y/N] `);
}

export function registerConsent(program: Command): void {
    const consent = program.command('consent').description('Manage the roots elepha may ingest: list / pending / grant / revoke / prune');

    consent.action(async () => {
        try {
            process.exitCode = await runInit({ store: new MemoryStore(openDb()), entry: 'consent' });
        } catch (error) {
            console.error(errorMessage(error));
            process.exitCode = 1;
        }
    });

    consent
        .command('list')
        .description('List every approved, denied, and pending memory root')
        .action(() => {
            const roots = new ConsentStore(openDb()).list();
            if (roots.length === 0) {
                console.log('No consent roots recorded.');
                return;
            }
            for (const root of roots) {
                console.log(`${root.state}\t${root.path}\t${root.source}\t${root.decided_at}`);
            }
        });

    consent
        .command('pending')
        .description('List roots seen by the daemon but not yet approved')
        .action(() => {
            const roots = new ConsentStore(openDb()).list('pending');
            if (roots.length === 0) {
                console.log('No pending consent roots.');
                return;
            }
            for (const root of roots) {
                console.log(`${root.path}\t${root.decided_at}`);
            }
        });

    consent
        .command('prune')
        .description('Remove missing or refused roots from consent list without deleting captured memory. Dry-run by default.')
        .option('--apply', 'actually remove the listed consent roots (default is a dry run that only prints the plan)')
        .option('--skip-confirmation', 'remove without the confirmation prompt')
        .action(async (options: ConsentPruneOptions) => {
            const db = openDb();
            const store = new ConsentStore(db);
            let verificationFailed = false;
            await runDestructiveOp({
                applyRequested: options.apply,
                db,
                operationLabel: 'consent prune',
                plan: () => planConsentPrune(store),
                describe: (plan) => {
                    if (plan.length === 0) {
                        console.log('No missing or refused consent roots found.');
                        return;
                    }
                    console.log('Consent roots eligible for pruning:');
                    for (const candidate of plan) {
                        console.log(`${candidate.reason}\t${candidate.root.path}`);
                    }
                    console.log(
                        '\nOnly these consent-list entries are affected; captured memory is kept. ' +
                            'Use elepha purge --orphan to preview orphaned memory.',
                    );
                },
                isEmpty: (plan) => plan.length === 0,
                messages: {
                    dryRun: '\nThis is a preview — nothing was deleted. Re-run with --apply to remove these consent-list entries.',
                },
                confirm: async (plan) => {
                    if (!process.stdout.isTTY || options.skipConfirmation) {
                        return true;
                    }
                    if (await confirmConsentPrune(plan.length)) {
                        return true;
                    }
                    console.log('Cancelled — nothing was deleted.');
                    return false;
                },
                apply: (plan) => {
                    const removeCandidates = db.transaction((candidates: ConsentPruneCandidate[]) => {
                        const findRoot = db.prepare('SELECT path, state FROM consent_roots WHERE ulid = ?');
                        const changedPaths: string[] = [];
                        let removed = 0;
                        for (const candidate of candidates) {
                            const current = findRoot.get(candidate.root.ulid) as Pick<ConsentRoot, 'path' | 'state'> | undefined;
                            const currentReason = current === undefined ? undefined : consentPruneReason(current.path);
                            if (
                                current === undefined ||
                                current.path !== candidate.root.path ||
                                current.state !== candidate.root.state ||
                                currentReason !== candidate.reason
                            ) {
                                changedPaths.push(candidate.root.path);
                                continue;
                            }
                            if (store.remove(candidate.root.ulid)) {
                                removed += 1;
                            } else {
                                changedPaths.push(candidate.root.path);
                            }
                        }
                        if (changedPaths.length > 0) {
                            throw new ConsentPruneChangedError(changedPaths);
                        }
                        return removed;
                    });
                    const removed = removeCandidates(plan);
                    console.log(
                        `Removed ${removed} consent root(s). Captured memory was not deleted; use elepha purge --orphan to preview it.`,
                    );
                },
                verify: (plan) => {
                    const remainingIds = new Set(store.list().map((root) => root.ulid));
                    const remaining = plan.filter((candidate) => remainingIds.has(candidate.root.ulid));
                    if (remaining.length > 0) {
                        verificationFailed = true;
                        console.error(`\nVERIFICATION FAILED: ${remaining.length} selected consent root(s) still remain.`);
                        process.exitCode = 1;
                    }
                },
            }).catch((error: unknown) => {
                if (!(error instanceof ConsentPruneChangedError)) {
                    throw error;
                }
                console.error(`Consent roots changed since preview:\n${error.paths.map((root) => `  ${root}`).join('\n')}`);
                console.error('Nothing was removed. Re-run elepha consent prune to see a fresh preview.');
                process.exitCode = 1;
            });
            if (verificationFailed) {
                process.exitCode = 1;
            }
        });

    consent
        .command('grant')
        .description('Grant consent to a root and capture its already-written transcripts without calling a synthesis provider')
        .argument('[path]', 'memory root to grant')
        .option('--here', 'use the current working directory as the memory root')
        .action(async (rootPath: string | undefined, options: ConsentPathOptions) => {
            const root = resolveConsentPath(rootPath, options);
            if (root === undefined) {
                return;
            }
            if (isRefusedProjectRoot(root)) {
                console.error(`${root} is a refused project root and cannot be granted.`);
                process.exitCode = 1;
                return;
            }
            const db = openDb();
            const consentStore = new ConsentStore(db);
            const store = new MemoryStore(db);
            const consentRoot = consentStore.grant(root);
            const daemon = new IngestionDaemon({ store, log: (message) => console.log(message) });
            const ingested = await daemon.backfillApprovedRoot(consentRoot.path);
            console.log(
                ingested > 0
                    ? `Granted ${consentRoot.path}; backfilled ${ingested} turn(s) without synthesis.`
                    : `Granted ${consentRoot.path}; no new turns to backfill.`,
            );
            try {
                const service = reconcileCaptureService(serviceBackend(), consentStore.list('approved').length);
                if (service === 'not installed') {
                    console.log('capture awaits elepha install');
                }
            } catch (error) {
                console.error(`consent recorded; capture service failed to activate: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    consent
        .command('revoke')
        .description('Revoke consent for a root without deleting its captured memory')
        .argument('[path]', 'memory root to revoke')
        .option('--here', 'use the current working directory as the memory root')
        .action((rootPath: string | undefined, options: ConsentPathOptions) => {
            const root = resolveConsentPath(rootPath, options);
            if (root === undefined) {
                return;
            }
            const db = openDb();
            const consentStore = new ConsentStore(db);
            const revoked = consentStore.revoke(root);
            try {
                reconcileCaptureService(serviceBackend(), consentStore.list('approved').length);
                console.log(`Revoked ${revoked.path}; captured memory retained.`);
            } catch (error) {
                console.error(`consent revoked; capture service failed to reconcile: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });
}
