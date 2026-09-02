import type { Database } from 'better-sqlite3';
import type { SessionAdapter, ToolName } from '../types/index.js';

export interface BackfillChange {
    transcriptMissing: boolean;
}

export interface BackfillPlan<Change> {
    changes: Change[];
    sessionsScanned: number;
    sessionsMissingTranscript: number;
}

export interface BackfillWriteResult {
    sessionsSkippedConcurrent?: number;
}

export interface BackfillDeriver<Session, Change extends BackfillChange, State = undefined> {
    load(db: Database): { sessions: Session[]; state: State };
    derive(input: {
        db: Database;
        adapters: Record<ToolName, SessionAdapter>;
        session: Session;
        state: State;
    }): Promise<Change | undefined>;
    shouldWrite(change: Change): boolean;
    write(db: Database, change: Change): BackfillWriteResult;
    finalize?(plan: BackfillPlan<Change>, state: State): BackfillPlan<Change>;
    recordConcurrentSkips?(plan: BackfillPlan<Change>, skipped: number): void;
    afterApply?(input: { db: Database; adapters: Record<ToolName, SessionAdapter>; plan: BackfillPlan<Change> }): Promise<void>;
}

// Plans and applies transcript-derived storage backfills. Verification reuses its plan result.
export async function planBackfill<Session, Change extends BackfillChange, State>(
    db: Database,
    adapters: Record<ToolName, SessionAdapter>,
    deriver: BackfillDeriver<Session, Change, State>,
): Promise<BackfillPlan<Change>> {
    const { sessions, state } = deriver.load(db);
    const changes: Change[] = [];
    let sessionsMissingTranscript = 0;

    for (const session of sessions) {
        const change = await deriver.derive({ db, adapters, session, state });
        if (change?.transcriptMissing) {
            sessionsMissingTranscript++;
        }
        if (change !== undefined) {
            changes.push(change);
        }
    }

    const plan = { changes, sessionsScanned: sessions.length, sessionsMissingTranscript };
    return deriver.finalize?.(plan, state) ?? plan;
}

export async function applyBackfill<Session, Change extends BackfillChange, State>(
    db: Database,
    adapters: Record<ToolName, SessionAdapter>,
    deriver: BackfillDeriver<Session, Change, State>,
): Promise<BackfillPlan<Change>> {
    const plan = await planBackfill(db, adapters, deriver);
    const apply = db.transaction((changes: Change[]) => {
        let sessionsSkippedConcurrent = 0;
        for (const change of changes) {
            if (!deriver.shouldWrite(change)) {
                continue;
            }
            sessionsSkippedConcurrent += deriver.write(db, change)?.sessionsSkippedConcurrent ?? 0;
        }
        return sessionsSkippedConcurrent;
    });
    const sessionsSkippedConcurrent = apply(plan.changes);
    deriver.recordConcurrentSkips?.(plan, sessionsSkippedConcurrent);
    await deriver.afterApply?.({ db, adapters, plan });
    return plan;
}
