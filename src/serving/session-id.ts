import type { ServedSession } from '../storage/session-read-model.js';

export function publicSessionId(session: Pick<ServedSession, 'tool' | 'native_id' | 'segment_index'>): string {
    return Buffer.from(JSON.stringify({ tool: session.tool, nativeId: session.native_id, segmentIndex: session.segment_index })).toString(
        'base64url',
    );
}
