import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { kimiSessionsRoot, kimiSessionWirePath } from '../../src/config/paths.js';

export function kimiTurn(index: number, answer = `Answer ${index}`, options: { failed?: boolean; model?: string } = {}): object[] {
    const time = 1000 + index * 1000;
    return [
        ...(options.model ? [{ type: 'profile.bind', agentId: 'main', modelAlias: options.model, time }] : []),
        {
            type: 'turn.prompt',
            agentId: 'main',
            promptId: `prompt-${index}`,
            origin: { kind: 'user' },
            input: [{ type: 'text', text: `Prompt ${index}` }],
            time,
        },
        {
            type: 'context.append_message',
            agentId: 'main',
            message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: `Prompt ${index}` }] },
            time: time + 1,
        },
        {
            type: 'context.append_loop_event',
            agentId: 'main',
            event: { type: 'step.begin', turnId: String(index), step: 0 },
            time: time + 2,
        },
        {
            type: 'context.append_loop_event',
            agentId: 'main',
            event: { type: 'content.part', turnId: String(index), step: 0, part: { type: 'think', think: 'Private reasoning' } },
            time: time + 3,
        },
        ...(!options.failed
            ? [
                  {
                      type: 'context.append_loop_event',
                      agentId: 'main',
                      event: { type: 'content.part', turnId: String(index), step: 0, part: { type: 'text', text: answer } },
                      time: time + 4,
                  },
              ]
            : []),
        { type: 'turn.ended', agentId: 'main', turnId: index, reason: options.failed ? 'failed' : 'completed', time: time + 700 },
        {
            type: 'prompt.completed',
            agentId: 'main',
            promptId: `prompt-${index}`,
            reason: options.failed ? 'failed' : 'completed',
            finishedAt: new Date(time + 800).toISOString(),
            time: time + 800,
        },
    ];
}

export function wireText(records: object[]): string {
    return `${[{ type: 'metadata', protocol_version: '1.5' }, ...records].map((record) => JSON.stringify(record)).join('\n')}\n`;
}

export function createKimiFixture(
    projectPath: string,
    records: object[],
    sessionId = 'session-main',
    forked = false,
): { wire: string; state: string } {
    const dir = path.join(kimiSessionsRoot(), 'workdir-key', sessionId);
    const wire = kimiSessionWirePath(dir);
    mkdirSync(path.dirname(wire), { recursive: true });
    const state = path.join(dir, 'state.json');
    writeFileSync(
        state,
        JSON.stringify({
            id: sessionId,
            version: 2,
            cwd: projectPath,
            title: 'Kimi fixture title',
            archived: false,
            createdAt: 1000,
            updatedAt: 5000,
            ...(forked ? { forkedFrom: 'session-parent' } : {}),
        }),
    );
    writeFileSync(wire, wireText(records));
    return { wire, state };
}
