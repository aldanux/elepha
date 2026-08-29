import type { Command } from 'commander';
import { openDb } from '../../storage/db.js';
import { applySanitize, planSanitize, type SanitizePlan, verifySanitize } from '../../storage/sanitize-backfill.js';
import { runDestructiveOp } from '../destructive-op.js';

export function registerSanitize(program: Command): void {
    program
        .command('sanitize', { hidden: true })
        .description(
            'Neutralize shell-active syntax already stored in rollups and turn rows. ' +
                'New writes are cleaned at the store choke points; this cleans what predates them. Dry-run by default.',
        )
        .option('--apply', 'actually rewrite the affected fields (default is a dry run that only prints them)')
        .action(async (opts: { apply: boolean }) => {
            const db = openDb();

            // Preview before acting, every time - including under --apply, and
            // with the actual before/after text rather than a count. A backfill
            // that rewrites stored memory is a destructive operation even though
            // it deletes nothing.
            await runDestructiveOp({
                applyRequested: opts.apply,
                db,
                operationLabel: 'sanitize',
                plan: () => planSanitize(db),
                describe: printSanitizePlan,
                isEmpty: (plan) => plan.changes.length === 0,
                onEmpty: () => reportResidue(verifySanitize(db)),
                messages: { dryRun: '\nDry run only - nothing was written. Re-run with --apply to rewrite these fields.' },
                backupLog: console.log,
                apply: (plan) => {
                    applySanitize(db);
                    console.log(`Rewrote ${plan.changes.length} field(s).`);
                },
                // Post-verification re-reads from SQL rather than trusting the plan
                // that was just applied. A backfill that reports success without
                // checking is exactly the silent-degradation shape this rule exists
                // to close.
                verify: () => reportResidue(verifySanitize(db)),
            });
        });
}

function reportResidue(residue: ReturnType<typeof verifySanitize>): void {
    if (residue.length === 0) {
        console.log('Verified: no stored field carries shell-active syntax.');
        return;
    }
    console.error(`\nVERIFICATION FAILED: ${residue.length} stored value(s) still carry shell-active syntax:`);
    for (const r of residue.slice(0, 20)) {
        console.error(`  ${r.table}#${r.rowId}.${r.field}: ${truncateForDisplay(r.text)}`);
    }
    if (residue.length > 20) {
        console.error(`  … and ${residue.length - 20} more.`);
    }
    process.exitCode = 1;
}

function printSanitizePlan(plan: SanitizePlan): void {
    if (plan.changes.length === 0) {
        console.log('No stored field carries shell-active syntax. Nothing to sanitize.');
        return;
    }
    console.log('The following stored fields would be rewritten:\n');
    for (const c of plan.changes) {
        console.log(`  ${c.table}#${c.rowId}.${c.field}`);
        console.log(`    before: ${truncateForDisplay(c.before)}`);
        console.log(`    after:  ${truncateForDisplay(c.after)}`);
    }
    console.log(`\n${plan.changes.length} field(s) across ${plan.rollupRows} rollup row(s) and ${plan.memoryRows} memory row(s).`);
}

function truncateForDisplay(s: string | null): string {
    if (!s) {
        return '';
    }
    const oneLine = s.replace(/\n/g, '\\n');
    return oneLine.length <= 200 ? oneLine : `${oneLine.slice(0, 200)}…`;
}
