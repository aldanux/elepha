import { existsSync } from 'node:fs';
import { backupDatabaseAndReport } from '../storage/backup.js';
import { defaultDbPath, type openDb } from '../storage/db.js';
import { withCapturePaused } from './shared.js';

type MaybePromise<T> = T | Promise<T>;

export interface DestructiveOpOptions<Plan> {
    applyRequested: boolean;
    db: ReturnType<typeof openDb>;
    // Human-readable verb used if the live daemon prevents mutation.
    operationLabel?: string;
    plan(): MaybePromise<Plan>;
    describe(plan: Plan): void;
    isEmpty(plan: Plan): boolean;
    onEmpty?: (plan: Plan) => MaybePromise<void>;
    apply(plan: Plan): MaybePromise<void>;
    verify(plan: Plan): MaybePromise<void>;
    confirm?: (plan: Plan) => MaybePromise<boolean>;
    backupLog?: (message: string) => void;
    messages: {
        dryRun: string;
    };
}

// Runs the shared preview -> optional confirm -> backup -> apply -> verify sequence.
export async function runDestructiveOp<Plan>(opts: DestructiveOpOptions<Plan>): Promise<boolean> {
    const plan = await opts.plan();
    opts.describe(plan);
    if (opts.isEmpty(plan)) {
        await opts.onEmpty?.(plan);
        return true;
    }
    if (!opts.applyRequested) {
        console.log(opts.messages.dryRun);
        return true;
    }

    if (opts.confirm && !(await opts.confirm(plan))) {
        return true;
    }

    return withCapturePaused(opts.operationLabel ?? 'this operation', async () => {
        // Each backup is a full snapshot of exactly the data being changed - an
        // unbounded pile of them undercuts "revocation = deletion" as badly as
        // skipping the delete would.
        const dbPath = defaultDbPath();
        if (existsSync(dbPath)) {
            backupDatabaseAndReport(opts.db, dbPath, opts.backupLog);
        }

        await opts.apply(plan);
        await opts.verify(plan);
    });
}
