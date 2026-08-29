import type { Command } from 'commander';
import { ClaudeCodeAdapter } from '../../adapters/claude-code.js';
import { CodexAdapter } from '../../adapters/codex.js';
import { gitRevParseShowToplevel, gitRootCommit } from '../../security/subprocess-allowlist.js';
import { applyCustomTitleBackfill, type CustomTitlePlan, planCustomTitleBackfill } from '../../storage/custom-title-backfill.js';
import { openDb } from '../../storage/db.js';
import {
    applyFirstPromptSearchBackfill,
    type FirstPromptSearchPlan,
    planFirstPromptSearchBackfill,
} from '../../storage/first-prompt-search-backfill.js';
import { applyRenderedCharsBackfill, planRenderedCharsBackfill, type RenderedCharsPlan } from '../../storage/rendered-chars-backfill.js';
import { applyRootCommitBackfill, planRootCommitBackfill, type RootCommitBackfillPlan } from '../../storage/root-commit-backfill.js';
import { applySessionFieldsBackfill, planSessionFieldsBackfill, type SessionFieldsPlan } from '../../storage/session-fields-backfill.js';
import { applySessionTitleBackfill, planSessionTitleBackfill, type SessionTitlePlan } from '../../storage/session-title-backfill.js';
import type { SessionAdapter, ToolName } from '../../types/index.js';
import { runDestructiveOp } from '../destructive-op.js';

export function registerBackfills(program: Command): void {
    program
        .command('backfill-root-commits', { hidden: true })
        .description(
            'Fill projects.git_root_commit for legacy project rows when their repository still resolves. No summarizer call; dry-run by default. Unresolvable rows stay NULL and are reported.',
        )
        .option('--apply', 'actually write git_root_commit after the preview (default is a dry run)')
        .action(async (opts: { apply: boolean }) => {
            const db = openDb();
            await runDestructiveOp({
                applyRequested: opts.apply,
                db,
                operationLabel: 'backfill root commits',
                plan: () => planRootCommitBackfill(db, gitRevParseShowToplevel, gitRootCommit),
                describe: printRootCommitPlan,
                isEmpty: (plan) => plan.changes.length === 0,
                confirm: undefined,
                messages: { dryRun: '\nDry run only - nothing was written. Re-run with --apply to store these root commits.' },
                apply: () => {
                    const applied = applyRootCommitBackfill(db, gitRevParseShowToplevel, gitRootCommit);
                    console.log(`\nFilled git_root_commit for ${applied.changes.length} project(s).`);
                    if (applied.projectsUnresolvable > 0) {
                        console.log(`${applied.projectsUnresolvable} project(s) stay NULL because their repository cannot be resolved.`);
                    }
                    if (applied.projectsSkippedConcurrent > 0) {
                        console.warn(
                            `${applied.projectsSkippedConcurrent} project(s) changed during the backfill and were left untouched; post-verification will report any remaining resolvable row.`,
                        );
                    }
                },
                verify: () => {
                    const verify = planRootCommitBackfill(db, gitRevParseShowToplevel, gitRootCommit);
                    if (verify.changes.length > 0) {
                        console.error(`VERIFICATION FAILED: ${verify.changes.length} resolvable project(s) still have no git_root_commit.`);
                        process.exitCode = 1;
                        return;
                    }
                    console.log('Verified: every resolvable project has a git_root_commit.');
                    if (verify.projectsUnresolvable > 0) {
                        console.log(`${verify.projectsUnresolvable} project(s) stay NULL because their repository cannot be resolved.`);
                    }
                },
            });
        });

    program
        .command('backfill-rendered-chars', { hidden: true })
        .description(
            'Derive sessions.rendered_chars and sessions.rendered_turns from raw filtered turns on disk. No summarizer call; dry-run by default. ' +
                'Missing or unreadable transcripts stay NULL and are reported.',
        )
        .option('--apply', 'actually rewrite rendered_chars and rendered_turns after the preview (default is read-only)')
        .action(async (opts: { apply: boolean }) => {
            const db = openDb();
            const adapters: Record<ToolName, SessionAdapter> = { 'claude-code': new ClaudeCodeAdapter(), codex: new CodexAdapter() };
            await runDestructiveOp({
                applyRequested: opts.apply,
                db,
                operationLabel: 'backfill rendered chars',
                plan: () => planRenderedCharsBackfill(db, adapters),
                describe: printRenderedCharsPlan,
                isEmpty: (plan) => plan.changes.length === 0,
                confirm: undefined,
                messages: { dryRun: '\nDry run only - nothing was written. Re-run with --apply to store these exact counts.' },
                apply: async () => {
                    const applied = await applyRenderedCharsBackfill(db, adapters);
                    console.log(
                        `\nWrote rendered statistics for ${applied.changes.filter((change) => !change.transcriptMissing).length} session(s).`,
                    );
                    if (applied.sessionsSkippedConcurrent > 0) {
                        console.warn(
                            `${applied.sessionsSkippedConcurrent} session(s) changed during the backfill and were left untouched; post-verification will report any remaining mismatch.`,
                        );
                    }
                },
                verify: async () => {
                    const verify = await planRenderedCharsBackfill(db, adapters);
                    const stillPending = verify.changes.filter((change) => !change.transcriptMissing);
                    if (stillPending.length > 0) {
                        console.error(`VERIFICATION FAILED: ${stillPending.length} readable session(s) still differ from the renderer.`);
                        process.exitCode = 1;
                        return;
                    }
                    console.log('Verified: every readable session matches the raw-turn renderer.');
                    if (verify.sessionsMissingTranscript > 0) {
                        console.log(`${verify.sessionsMissingTranscript} session(s) stay NULL because their transcript is unavailable.`);
                    }
                },
            });
        });

    program
        .command('backfill-first-prompt-search', { hidden: true })
        .description(
            "Derive sessions.first_prompt_search from each segment's first stored user turn. No provider call; dry-run by default. " +
                'Rows stay body-unsearchable by elepha:query until this backfill succeeds; unavailable transcripts stay NULL and are reported.',
        )
        .option('--apply', 'actually write first_prompt_search after the preview (default is a dry run)')
        .action(async (opts: { apply: boolean }) => {
            const db = openDb();
            const adapters: Record<ToolName, SessionAdapter> = { 'claude-code': new ClaudeCodeAdapter(), codex: new CodexAdapter() };
            await runDestructiveOp({
                applyRequested: opts.apply,
                db,
                operationLabel: 'backfill first prompt search',
                plan: () => planFirstPromptSearchBackfill(db, adapters),
                describe: printFirstPromptSearchPlan,
                isEmpty: (plan) => plan.changes.length === 0,
                confirm: undefined,
                messages: {
                    dryRun: '\nDry run only - nothing was written. Re-run with --apply to make these rows body-searchable.',
                },
                apply: async () => {
                    const applied = await applyFirstPromptSearchBackfill(db, adapters);
                    console.log(
                        `Wrote first_prompt_search for ${applied.changes.filter((change) => !change.transcriptMissing).length} session(s).`,
                    );
                },
                verify: async () => {
                    const verify = await planFirstPromptSearchBackfill(db, adapters);
                    const stillPending = verify.changes.filter((change) => !change.transcriptMissing);
                    if (stillPending.length > 0) {
                        console.error(
                            `VERIFICATION FAILED: ${stillPending.length} readable session(s) still differ from their first stored prompt.`,
                        );
                        process.exitCode = 1;
                        return;
                    }
                    console.log('Verified: every readable segment has its derived first_prompt_search.');
                    if (verify.sessionsMissingTranscript > 0) {
                        console.log(
                            `${verify.sessionsMissingTranscript} session(s) stay body-unsearchable because their transcript is unavailable.`,
                        );
                    }
                },
            });
        });

    program
        .command('backfill-session-titles', { hidden: true })
        .description(
            'Derive each stored segment title from its ai-title or first real prompt. No provider call; dry-run by default. Missing transcripts stay unchanged and are reported.',
        )
        .option('--apply', 'actually write titles after the preview (default is a dry run)')
        .action(async (opts: { apply: boolean }) => {
            const db = openDb();
            const adapters: Record<ToolName, SessionAdapter> = { 'claude-code': new ClaudeCodeAdapter(), codex: new CodexAdapter() };
            await runDestructiveOp({
                applyRequested: opts.apply,
                db,
                operationLabel: 'backfill session titles',
                plan: () => planSessionTitleBackfill(db, adapters),
                describe: printSessionTitlePlan,
                isEmpty: (plan) => plan.changes.length === 0,
                confirm: undefined,
                messages: { dryRun: '\nDry run only - nothing was written. Re-run with --apply to store these exact titles.' },
                apply: async () => {
                    const applied = await applySessionTitleBackfill(db, adapters);
                    console.log(`Wrote titles for ${applied.changes.filter((change) => !change.transcriptMissing).length} session(s).`);
                },
                verify: async () => {
                    const verify = await planSessionTitleBackfill(db, adapters);
                    const stillPending = verify.changes.filter((change) => !change.transcriptMissing);
                    if (stillPending.length > 0) {
                        console.error(
                            `VERIFICATION FAILED: ${stillPending.length} readable session(s) still differ from their derived segment title.`,
                        );
                        process.exitCode = 1;
                        return;
                    }
                    console.log('Verified: every readable segment has its derived stored title.');
                },
            });
        });

    program
        .command('backfill-custom-titles', { hidden: true })
        .description(
            'Capture Claude Code custom-title UI events into sessions.custom_title. Dry-run by default; does not touch turns or rendered_chars.',
        )
        .option('--apply', 'actually write custom_title after the preview (default is a dry run)')
        .action(async (opts: { apply: boolean }) => {
            const db = openDb();
            const adapters: Record<ToolName, SessionAdapter> = { 'claude-code': new ClaudeCodeAdapter(), codex: new CodexAdapter() };
            await runDestructiveOp({
                applyRequested: opts.apply,
                db,
                operationLabel: 'backfill custom titles',
                plan: () => planCustomTitleBackfill(db, adapters),
                describe: printCustomTitlePlan,
                isEmpty: (plan) => plan.changes.length === 0,
                confirm: undefined,
                messages: { dryRun: '\nDry run only - nothing was written. Re-run with --apply to store these exact titles.' },
                apply: async () => {
                    const applied = await applyCustomTitleBackfill(db, adapters);
                    console.log(
                        `Wrote custom_title for ${applied.changes.filter((change) => !change.transcriptMissing).length} session(s).`,
                    );
                },
                verify: async () => {
                    const verify = await planCustomTitleBackfill(db, adapters);
                    const stillPending = verify.changes.filter((change) => !change.transcriptMissing);
                    if (stillPending.length > 0) {
                        console.error(
                            `VERIFICATION FAILED: ${stillPending.length} readable session(s) still differ from their transcript title.`,
                        );
                        process.exitCode = 1;
                        return;
                    }
                    console.log('Verified: every readable session matches its captured custom title.');
                },
            });
        });

    program
        .command('backfill-session-fields', { hidden: true })
        .description(
            'Re-derive sessions.surface/git_branch/kind/trailing_branch/trailing_files and memories.has_external_content ' +
                'from transcripts still on disk, for rows written before this capture existed. Structural only - no summarizer call. Dry-run by default.',
        )
        .option('--apply', 'actually rewrite the affected fields (default is a dry run that only prints them)')
        .action(async (opts: { apply: boolean }) => {
            const db = openDb();
            const adapters: Record<ToolName, SessionAdapter> = { 'claude-code': new ClaudeCodeAdapter(), codex: new CodexAdapter() };
            await runDestructiveOp({
                applyRequested: opts.apply,
                db,
                operationLabel: 'backfill session fields',
                plan: () => planSessionFieldsBackfill(db, adapters),
                describe: printSessionFieldsPlan,
                isEmpty: (plan) => plan.changes.length === 0,
                confirm: undefined,
                messages: { dryRun: '\nDry run only - nothing was written. Re-run with --apply to rewrite these fields.' },
                apply: async () => {
                    const applied = await applySessionFieldsBackfill(db, adapters);
                    console.log(`Rewrote fields for ${applied.changes.length} session(s).`);
                },
                verify: async () => {
                    const verify = await planSessionFieldsBackfill(db, adapters);
                    // A session whose transcript is permanently missing is reported every
                    // run (see session-fields-backfill.ts) so the operator can see it -
                    // that is not a pending change apply() could have applied, so it must
                    // not fail verification forever. Only a session whose fields could
                    // actually be rewritten but still differ counts as a real failure.
                    const stillPending = verify.changes.filter((c) => !c.transcriptMissing);
                    if (stillPending.length > 0) {
                        console.error(`\nVERIFICATION FAILED: ${stillPending.length} session(s) still show a pending change after apply.`);
                        process.exitCode = 1;
                        return;
                    }
                    console.log('Verified: no session shows a pending schema-field change.');
                    const missingCount = verify.changes.filter((c) => c.transcriptMissing).length;
                    if (missingCount > 0) {
                        console.log(`(${missingCount} session(s) have no transcript on disk and stay NULL - not counted as pending.)`);
                    }
                },
            });
        });
}

function printRootCommitPlan(plan: RootCommitBackfillPlan): void {
    if (plan.changes.length === 0) {
        console.log(`No resolvable project needs a git_root_commit (${plan.projectsScanned} NULL row(s) scanned).`);
    } else {
        console.log('The following project root commits would be written:\n');
        for (const change of plan.changes) {
            console.log(`  [${change.projectId}] ${change.path} -> ${change.gitRootCommit}`);
        }
    }
    if (plan.projectsUnresolvable > 0) {
        console.log(`${plan.projectsUnresolvable} project(s) cannot be resolved and will stay NULL.`);
    }
}

function printFirstPromptSearchPlan(plan: FirstPromptSearchPlan): void {
    if (plan.changes.length === 0) {
        console.log(`Every session already has its derived first_prompt_search (${plan.sessionsScanned} scanned).`);
        return;
    }
    console.log('The following first-prompt search documents would be written:\n');
    for (const change of plan.changes) {
        console.log(`  [${change.sessionId}] ${change.tool}:${change.nativeId}`);
        if (change.transcriptMissing) {
            console.log(`    transcript unavailable; row stays body-unsearchable: ${change.sourcePath}`);
        } else {
            console.log(`    first_prompt_search: ${change.before ?? 'NULL'} -> ${change.after ?? 'NULL'}`);
        }
    }
    console.log(
        `\n${plan.changes.length} session(s) of ${plan.sessionsScanned} scanned; ${plan.sessionsMissingTranscript} transcript(s) unavailable and left body-unsearchable.`,
    );
}

function printSessionFieldsPlan(plan: SessionFieldsPlan): void {
    if (plan.changes.length === 0) {
        console.log(
            `No session needs a schema-field update (${plan.sessionsScanned} scanned, ${plan.sessionsMissingTranscript} missing transcript).`,
        );
        return;
    }
    console.log('The following sessions would be updated:\n');
    for (const c of plan.changes) {
        console.log(
            `  [${c.sessionId}] ${c.nativeId} (${c.tool})${c.transcriptMissing ? '  [transcript missing - fields stay NULL]' : ''}`,
        );
        console.log(`    surface:         ${c.before.surface ?? 'NULL'} -> ${c.after.surface ?? 'NULL'}`);
        console.log(`    git_branch:      ${c.before.git_branch ?? 'NULL'} -> ${c.after.git_branch ?? 'NULL'}`);
        console.log(`    kind:            ${c.before.kind ?? 'NULL'} -> ${c.after.kind ?? 'NULL'}`);
        console.log(`    trailing_branch: ${c.before.trailing_branch ?? 'NULL'} -> ${c.after.trailing_branch ?? 'NULL'}`);
        if (c.memoryFlagsChanged > 0) {
            console.log(`    has_external_content: ${c.memoryFlagsChanged} turn(s) flip`);
        }
    }
    console.log(
        `\n${plan.changes.length} session(s) of ${plan.sessionsScanned} scanned (${plan.sessionsMissingTranscript} missing transcript, left NULL).`,
    );
}

function printRenderedCharsPlan(plan: RenderedCharsPlan): void {
    if (plan.changes.length === 0) {
        console.log(`Every session already has current rendered statistics (${plan.sessionsScanned} scanned).`);
        return;
    }
    console.log('The following rendered statistics would be written:\n');
    for (const change of plan.changes) {
        const result = change.transcriptMissing
            ? 'NULL [transcript unavailable]'
            : `${change.renderedChars} chars, ${change.renderedTurns} turns`;
        console.log(
            `  [${change.sessionId}] ${change.tool}:${change.nativeId}  ${change.beforeRenderedChars ?? 'NULL'} chars, ${
                change.beforeRenderedTurns ?? 'NULL'
            } turns -> ${result}`,
        );
        if (change.transcriptMissing) {
            console.log(`    ${change.sourcePath}`);
        }
    }
    console.log(
        `\n${plan.changes.length} session(s) of ${plan.sessionsScanned} scanned; ${plan.sessionsMissingTranscript} transcript(s) unavailable and left NULL.`,
    );
}

function printCustomTitlePlan(plan: CustomTitlePlan): void {
    if (plan.changes.length === 0) {
        console.log(`No session needs a custom_title update (${plan.sessionsScanned} scanned).`);
        return;
    }
    console.log('The following session titles would be updated:\n');
    for (const change of plan.changes) {
        console.log(`  [${change.sessionId}] ${change.tool}:${change.nativeId}`);
        if (change.transcriptMissing) {
            console.log(`    transcript unavailable: ${change.sourcePath}`);
        } else {
            console.log(`    custom_title: ${change.before ?? 'NULL'} -> ${change.after ?? 'NULL'}`);
        }
    }
    console.log(
        `\n${plan.changes.length} session(s) of ${plan.sessionsScanned} scanned; ${plan.sessionsMissingTranscript} transcript(s) unavailable.`,
    );
}

function printSessionTitlePlan(plan: SessionTitlePlan): void {
    if (plan.changes.length === 0) {
        console.log(`Every session already has its derived title (${plan.sessionsScanned} scanned).`);
        return;
    }
    console.log('The following segment titles would be written:\n');
    for (const change of plan.changes) {
        console.log(`  [${change.sessionId}] ${change.tool}:${change.nativeId}`);
        if (change.transcriptMissing) {
            console.log(`    transcript unavailable: ${change.sourcePath}`);
        } else {
            console.log(`    title: ${change.before ?? 'NULL'} -> ${change.after ?? 'NULL'}`);
        }
    }
    console.log(
        `\n${plan.changes.length} session(s) of ${plan.sessionsScanned} scanned; ${plan.sessionsMissingTranscript} transcript(s) unavailable.`,
    );
}
