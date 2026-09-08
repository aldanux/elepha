import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

export function createOpencodeFixture(dbPath: string, projectPath: string): void {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                workspace_id TEXT,
                parent_id TEXT,
                slug TEXT,
                directory TEXT NOT NULL,
                path TEXT,
                title TEXT NOT NULL,
                version TEXT NOT NULL,
                agent TEXT,
                model TEXT,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                time_archived INTEGER
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE INDEX message_session_time ON message(session_id, time_created, id);
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
        `);

        const insertSession = db.prepare(
            `INSERT INTO session
             (id, parent_id, directory, title, version, time_created, time_updated)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        insertSession.run('ses_sub', 'ses_primary', projectPath, 'Sub-session', '1.18.29', 50, 100);
        insertSession.run('ses_primary', null, projectPath, 'Primary title', '1.18.29', 90, 200);

        const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
        insertMessage.run('msg_1', 'ses_primary', 1_000, 1_000, JSON.stringify({ role: 'user', time: { created: 1_000 } }));
        insertMessage.run(
            'msg_2',
            'ses_primary',
            1_100,
            1_100,
            JSON.stringify({ role: 'assistant', time: { created: 1_100 }, path: { cwd: '/wrong/message/cwd', root: '/wrong' } }),
        );
        insertMessage.run('msg_3', 'ses_primary', 2_000, 2_000, JSON.stringify({ role: 'user', time: { created: 2_000 } }));
        insertMessage.run('msg_4', 'ses_primary', 2_100, 2_100, JSON.stringify({ role: 'assistant', time: { created: 2_100 } }));

        const insertPart = db.prepare(
            'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
        );
        insertPart.run('part_1', 'msg_1', 'ses_primary', 1_001, 1_001, JSON.stringify({ type: 'text', text: 'First prompt' }));
        insertPart.run('part_2', 'msg_2', 'ses_primary', 1_101, 1_101, JSON.stringify({ type: 'reasoning', text: 'private thought' }));
        insertPart.run('part_3', 'msg_2', 'ses_primary', 1_102, 1_102, JSON.stringify({ type: 'step-start' }));
        insertPart.run(
            'part_4',
            'msg_2',
            'ses_primary',
            1_103,
            1_103,
            JSON.stringify({
                type: 'tool',
                tool: 'edit',
                callID: 'call_1',
                state: { status: 'completed', input: { filePath: 'src/a.ts' } },
            }),
        );
        insertPart.run('part_5', 'msg_2', 'ses_primary', 1_104, 1_104, JSON.stringify({ type: 'text', text: 'First answer' }));
        insertPart.run('part_6', 'msg_2', 'ses_primary', 1_105, 1_105, JSON.stringify({ type: 'step-finish' }));
        insertPart.run('part_7', 'msg_3', 'ses_primary', 2_001, 2_001, JSON.stringify({ type: 'text', text: 'Second prompt' }));
        insertPart.run('part_8', 'msg_4', 'ses_primary', 2_101, 2_101, JSON.stringify({ type: 'text', text: 'Second answer' }));
        insertPart.run('part_9', 'msg_4', 'ses_primary', 2_102, 2_102, JSON.stringify({ type: 'future-part' }));
    } finally {
        db.close();
    }
}
