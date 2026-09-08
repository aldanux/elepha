import type { Command } from 'commander';
import { openDb } from '../../storage/db.js';
import {
    type AuthenticatedReadGeneration,
    LOCKED_MEMORY_MESSAGE,
    memoryReadAuthorityMatchesGenerationInTransaction,
    withMemoryReadGeneration,
    withMemoryReadGenerationAsync,
} from '../../storage/paranoid-gate.js';
import { applySanitize, planSanitize, type SanitizePlan, verifySanitize } from '../../storage/sanitize-backfill.js';
import { runDestructiveOp } from '../destructive-op.js';
import type { CliOutputSink } from '../shared.js';

interface BufferedOutput {
    events: Array<{ channel: 'error' | 'log'; message: string }>;
    exitCode?: number;
    sink: CliOutputSink;
}

type SanitizeOutcome = { status: 'fulfilled' } | { reason: unknown; status: 'rejected' };

interface SanitizeExecution {
    outcome: SanitizeOutcome;
    output: BufferedOutput;
    status: 'locked' | 'ready';
    token: AuthenticatedReadGeneration;
}

export function registerSanitize(program: Command): void {
    program
        .command('sanitize', { hidden: true })
        .description(
            'Neutralize shell-active syntax already stored in rollups and turn rows. ' +
                'New writes are cleaned at the store choke points; this cleans what predates them. Dry-run by default.',
        )
        .option('--apply', 'actually rewrite the affected fields (default is a dry run that only prints them)')
        .action(async (opts: { apply: boolean }) => {
            const db = await openDb();
            const execution = await withMemoryReadGenerationAsync<SanitizeExecution | undefined>(
                db,
                () => undefined,
                async (token) => runSanitize(db, opts.apply, token),
            );
            if (execution === undefined || execution.status === 'locked') {
                console.log(LOCKED_MEMORY_MESSAGE);
                return;
            }
            const replayed = withMemoryReadGeneration(
                db,
                () => false,
                () => {
                    replayOutput(execution.output);
                    return true;
                },
                execution.token,
            );
            if (!replayed) {
                console.log(LOCKED_MEMORY_MESSAGE);
                return;
            }
            if (execution.output.exitCode !== undefined) {
                process.exitCode = execution.output.exitCode;
            }
            if (execution.outcome.status === 'rejected') {
                throw execution.outcome.reason;
            }
        });
}

async function runSanitize(
    db: Parameters<typeof planSanitize>[0],
    applyRequested: boolean,
    token: AuthenticatedReadGeneration,
): Promise<SanitizeExecution> {
    const output = bufferedOutput();
    let invalidated = false;
    const generationIsCurrent = (): boolean =>
        withMemoryReadGeneration(
            db,
            () => false,
            () => true,
            token,
        );
    const revalidateGeneration = (): boolean => {
        invalidated ||= !generationIsCurrent();
        return !invalidated;
    };
    const outcome: SanitizeOutcome = await runDestructiveOp({
        // Preview before acting, every time - including under --apply, and
        // with the actual before/after text rather than a count. A backfill
        // that rewrites stored memory is a destructive operation even though
        // it deletes nothing.
        applyRequested,
        db,
        // The paranoid-generation gate replays buffered output under this same
        // handle and token after runDestructiveOp returns, so it must not be
        // closed before resume. See D117 follow-up (data-to-observe §12).
        retainDbAfter: true,
        operationLabel: 'sanitize',
        output: output.sink,
        plan: () => planSanitize(db),
        describe: (plan) => {
            invalidated = !generationIsCurrent();
            if (!invalidated) {
                printSanitizePlan(plan, output.sink);
            }
        },
        isEmpty: (plan) => invalidated || plan.changes.length === 0,
        onEmpty: () => {
            if (revalidateGeneration()) {
                reportResidue(verifySanitize(db), output.sink);
            }
        },
        messages: { dryRun: '\nDry run only - nothing was written. Re-run with --apply to rewrite these fields.' },
        backupLog: output.sink.log,
        apply: (plan) => {
            if (!generationIsCurrent()) {
                invalidated = true;
                return;
            }
            const result = applySanitize(db, {
                beforeFirstMutation: () => memoryReadAuthorityMatchesGenerationInTransaction(db, token),
            });
            if (result.status === 'not_applied') {
                invalidated = true;
                return;
            }
            output.sink.log(`Rewrote ${plan.changes.length} field(s).`);
        },
        // Post-verification re-reads from SQL rather than trusting the plan
        // that was just applied. A backfill that reports success without
        // checking is exactly the silent-degradation shape this rule exists
        // to close.
        verify: () => {
            if (revalidateGeneration()) {
                reportResidue(verifySanitize(db), output.sink);
            }
        },
    }).then(
        () => ({ status: 'fulfilled' }),
        (reason: unknown) => ({ reason, status: 'rejected' }),
    );
    return {
        outcome,
        output,
        status: invalidated ? 'locked' : 'ready',
        token,
    };
}

function bufferedOutput(): BufferedOutput {
    const events: BufferedOutput['events'] = [];
    const output: BufferedOutput = {
        events,
        sink: {
            error: (message) => events.push({ channel: 'error', message }),
            exitCode: (code) => {
                output.exitCode = code;
            },
            log: (message) => events.push({ channel: 'log', message }),
        },
    };
    return output;
}

function replayOutput(output: BufferedOutput): void {
    for (const event of output.events) {
        console[event.channel](event.message);
    }
}

function reportResidue(residue: ReturnType<typeof verifySanitize>, output: CliOutputSink): void {
    if (residue.length === 0) {
        output.log('Verified: no stored field carries shell-active syntax.');
        return;
    }
    output.error(`\nVERIFICATION FAILED: ${residue.length} stored value(s) still carry shell-active syntax:`);
    for (const r of residue.slice(0, 20)) {
        output.error(`  ${r.table}#${r.rowId}.${r.field}: ${truncateForDisplay(r.text)}`);
    }
    if (residue.length > 20) {
        output.error(`  … and ${residue.length - 20} more.`);
    }
    output.exitCode?.(1);
}

function printSanitizePlan(plan: SanitizePlan, output: CliOutputSink): void {
    if (plan.changes.length === 0) {
        output.log('No stored field carries shell-active syntax. Nothing to sanitize.');
        return;
    }
    output.log('The following stored fields would be rewritten:\n');
    for (const c of plan.changes) {
        output.log(`  ${c.table}#${c.rowId}.${c.field}`);
        output.log(`    before: ${truncateForDisplay(c.before)}`);
        output.log(`    after:  ${truncateForDisplay(c.after)}`);
    }
    output.log(
        `\n${plan.changes.length} field(s) across ${plan.rollupRows} rollup row(s), ${plan.memoryRows} memory row(s), ` +
            `and ${plan.filteredTurnRows} filtered turn row(s).`,
    );
}

function truncateForDisplay(s: string | null): string {
    if (!s) {
        return '';
    }
    const oneLine = s.replace(/\n/g, '\\n');
    return oneLine.length <= 200 ? oneLine : `${oneLine.slice(0, 200)}…`;
}
