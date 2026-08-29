import type { Command } from 'commander';
import { ClaudeCodeAdapter } from '../../adapters/claude-code.js';
import { CodexAdapter } from '../../adapters/codex.js';
import { openDb } from '../../storage/db.js';
import {
    applyManualMerge,
    applyManualSplit,
    applyResegmentation,
    type ManualMergePlan,
    type ManualSplitPlan,
    planManualMerge,
    planManualSplit,
    planResegmentation,
    type ResegmentationPlan,
    verifyResegmentation,
} from '../../storage/resegmentation.js';
import type { SessionAdapter, ToolName } from '../../types/index.js';
import { prepareDestructiveApply } from '../shared.js';

export function registerSegment(program: Command): void {
    program
        .command('segment', { hidden: true })
        .description(
            'Preview or apply session re-segmentation, or manually correct one boundary. Dry-run by default; applied changes back up first.',
        )
        .option('--resegment', 'replay every retained native session through the current boundary evaluator')
        .option('--split <sessionId>', 'split an integer session id')
        .option('--at <turnIndex>', 'first retained turn_index of the new right-hand segment')
        .option('--merge <sessionIds...>', 'merge two adjacent integer session ids')
        .option('--apply', 'apply the previewed change (default is read-only preview)')
        .action(async (opts: { resegment: boolean; split?: string; at?: string; merge?: string[]; apply: boolean }) => {
            const operations = Number(opts.resegment) + Number(opts.split !== undefined) + Number(opts.merge !== undefined);
            if (operations !== 1) {
                console.error('Choose exactly one: --resegment, --split <id> --at <turn_index>, or --merge <id> <id>.');
                process.exitCode = 1;
                return;
            }

            const db = openDb();
            const adapters: Record<ToolName, SessionAdapter> = {
                'claude-code': new ClaudeCodeAdapter(),
                codex: new CodexAdapter(),
            };

            if (opts.resegment) {
                const preview = await planResegmentation(db, adapters);
                printResegmentationPlan(preview);
                if (preview.affectedGroups === 0) {
                    console.log('\nNothing needs re-segmentation. Nothing was written.');
                    return;
                }
                if (!opts.apply) {
                    console.log('\nDry run only - nothing was written. Re-run with --apply to apply this exact migration shape.');
                    return;
                }
                if (!prepareDestructiveApply(db, 'destructive segmentation')) {
                    return;
                }
                applyResegmentation(db, preview);
                const verification = verifyResegmentation(db, preview);
                if (!verification.ok) {
                    console.error(`\nVERIFICATION FAILED:\n${verification.errors.map((error) => `  - ${error}`).join('\n')}`);
                    process.exitCode = 1;
                    return;
                }
                console.log(
                    `\nApplied ${preview.affectedGroups} native-session migration(s); invalidated affected rollups. ` +
                        'Verified retained-turn partitions, trailing state, and foreign keys.',
                );
                return;
            }

            if (opts.split !== undefined) {
                const sessionId = parseIntegerOption(opts.split, '--split');
                const atTurnIndex = parseIntegerOption(opts.at, '--at');
                if (sessionId === undefined || atTurnIndex === undefined) {
                    return;
                }
                let preview: ManualSplitPlan;
                try {
                    preview = await planManualSplit(db, adapters, sessionId, atTurnIndex);
                } catch (error) {
                    console.error(`Cannot split: ${(error as Error).message}`);
                    process.exitCode = 1;
                    return;
                }
                console.log(
                    `Split preview: session ${preview.source.id} (${preview.source.tool}:${preview.source.native_id}, segment ${preview.source.segment_index}) ` +
                        `at turn ${preview.atTurnIndex}: ${preview.left.turnIndexes.length} turn(s) + ${preview.right.turnIndexes.length} turn(s).`,
                );
                console.log(
                    `Resulting indexes: ${preview.left.segmentIndex}, ${preview.right.segmentIndex}; ` +
                        `${preview.laterSessionIds.length} later segment(s) shift up; ${preview.rollupsInvalidated} rollup(s) invalidated.`,
                );
                if (!opts.apply) {
                    console.log('\nDry run only - nothing was written. Re-run with --apply to split.');
                    return;
                }
                if (!prepareDestructiveApply(db, 'destructive segmentation')) {
                    return;
                }
                const newId = applyManualSplit(db, preview);
                verifyForeignKeysOrFail(db);
                console.log(
                    `\nSplit applied: session ${preview.source.id} + new session ${newId}. Correction direction recorded as split.`,
                );
                return;
            }

            if (opts.merge?.length !== 2) {
                console.error('--merge requires exactly two integer session ids.');
                process.exitCode = 1;
                return;
            }
            const firstId = parseIntegerOption(opts.merge[0], '--merge');
            const secondId = parseIntegerOption(opts.merge[1], '--merge');
            if (firstId === undefined || secondId === undefined) {
                return;
            }
            let preview: ManualMergePlan;
            try {
                preview = await planManualMerge(db, adapters, firstId, secondId);
            } catch (error) {
                console.error(`Cannot merge: ${(error as Error).message}`);
                process.exitCode = 1;
                return;
            }
            console.log(
                `Merge preview: sessions ${preview.left.id} + ${preview.right.id} ` +
                    `(${preview.left.tool}:${preview.left.native_id}, indexes ${preview.left.segment_index}/${preview.right.segment_index}) ` +
                    `into ${preview.merged.turnIndexes.length} retained turn(s).`,
            );
            console.log(
                `${preview.laterSessionIds.length} later segment(s) shift down; ${preview.rollupsInvalidated} rollup(s) invalidated.`,
            );
            if (!opts.apply) {
                console.log('\nDry run only - nothing was written. Re-run with --apply to merge.');
                return;
            }
            if (!prepareDestructiveApply(db, 'destructive segmentation')) {
                return;
            }
            const keptId = applyManualMerge(db, preview);
            verifyForeignKeysOrFail(db);
            console.log(`\nMerge applied: kept session ${keptId}. Correction direction recorded as merge.`);
        });
}

function parseIntegerOption(value: string | undefined, name: string): number | undefined {
    if (value === undefined || !/^\d+$/.test(value)) {
        console.error(`${name} requires a non-negative integer.`);
        process.exitCode = 1;
        return undefined;
    }
    return Number(value);
}

function verifyForeignKeysOrFail(db: ReturnType<typeof openDb>): void {
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
        throw new Error(`foreign_key_check returned ${violations.length} violation(s)`);
    }
}

function printResegmentationPlan(plan: ResegmentationPlan): void {
    console.log(
        `Re-segmentation preview: ${plan.sessionsScanned} existing row(s), ${plan.nativeSessionsScanned} native session(s), ` +
            `${plan.retainedTurnsScanned} retained turn(s).`,
    );
    for (const group of plan.groups) {
        if (group.status === 'skipped') {
            console.log(
                `SKIP ${group.existingSessionIds.join(',')} ${group.tool}:${group.nativeId}: ${group.issue ?? 'unknown reason'} ` +
                    `(${group.retainedTurnCount} retained turn(s)).`,
            );
            continue;
        }
        const state = group.requiresWrite ? 'CHANGE' : 'UNCHANGED';
        console.log(
            `${state} ${group.existingSessionIds.join(',')} ${group.tool}:${group.nativeId}: ` +
                `${group.existingSegmentCount} -> ${group.resultingSegments.length} segment(s), ${group.retainedTurnCount} retained turn(s), ` +
                `${group.rollupsInvalidated} rollup(s) invalidated.`,
        );
        for (const cut of group.cuts) {
            const overlap = cut.fileOverlap === null ? 'unavailable' : cut.fileOverlap.toFixed(3);
            console.log(
                `  cut before turn ${cut.atTurnIndex}: gap ${cut.gapHours.toFixed(2)}h; evidence ${cut.evidence.join('+')}; file overlap ${overlap}`,
            );
        }
    }
    console.log(
        `\nResult: ${plan.affectedGroups} changed, ${plan.readyGroups - plan.affectedGroups} unchanged, ${plan.skippedGroups} skipped; ` +
            `${plan.resultingSessionRows} resulting row(s) across processable native sessions.`,
    );
}
