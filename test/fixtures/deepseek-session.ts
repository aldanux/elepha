import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import { dshSessionsRoot } from '../../src/config/paths.js';

export function deepSeekHeader(cwd: string, sessionId = 'session-main', generation = 3, isSeeded = false): object {
    return {
        type: 'session',
        version: generation,
        id: sessionId,
        createdAt: Date.parse('2026-09-11T00:00:00.000Z'),
        time: Date.parse('2026-09-11T00:00:00.000Z'),
        cwd,
        isSeeded,
        delegationDepth: 0,
        agentPreset: 'standard',
    };
}

export function deepSeekTurn(index: number, answer = `Answer ${index}`): object[] {
    const seq = index * 10 + 1;
    const startedAt = Date.parse(`2026-09-11T00:00:${String(index * 2).padStart(2, '0')}.000Z`);
    const endedAt = Date.parse(`2026-09-11T00:00:${String(index * 2 + 1).padStart(2, '0')}.000Z`);
    return [
        { type: 'turn/start', seq, time: startedAt, data: { turn: index + 1 } },
        {
            type: 'user/message',
            seq: seq + 1,
            time: startedAt,
            surfaceOp: 'append',
            data: {
                content: [{ type: 'text', text: `Prompt ${index}` }],
                source: { kind: 'user', rpcId: `rpc-${index}`, clientTimeZone: 'UTC' },
                role: 'user',
                id: `user-${index}`,
            },
        },
        {
            type: 'assistant/message',
            seq: seq + 2,
            time: startedAt,
            surfaceOp: 'append',
            data: {
                turn: index + 1,
                step: 1,
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'reasoning', text: 'Private reasoning' },
                        { type: 'tool-call', id: `tool-${index}`, name: 'bash', arguments: '{}' },
                        { type: 'text', text: answer },
                    ],
                    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
                    id: `assistant-${index}`,
                },
            },
        },
        { type: 'turn/end', seq: seq + 3, time: endedAt, data: { turn: index + 1, reason: { kind: 'completed' } } },
    ];
}

function frameBytes(records: object[]): Buffer {
    const input = Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    return zstdCompressSync(input, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
}

export function deepSeekZstdBytes(frames: object[][]): Buffer {
    return Buffer.concat(frames.map(frameBytes));
}

export function createDeepSeekFixture(
    projectPath: string,
    frames: object[][],
    options: { sessionId?: string; generation?: number; encoding?: 'raw' | 'zstd'; projectKey?: string } = {},
): string {
    const sessionId = options.sessionId ?? 'session-main';
    const generation = options.generation ?? 3;
    const encoding = options.encoding ?? 'zstd';
    const projectKey = options.projectKey ?? '--fixture-project--';
    const directory = path.join(dshSessionsRoot(), projectKey, sessionId);
    mkdirSync(directory, { recursive: true });
    const stem = generation === 0 ? 'session' : `session.v${generation}`;
    const filePath = path.join(directory, `${stem}.jsonl${encoding === 'zstd' ? '.zstd' : ''}`);
    const records = frames.length > 0 ? frames : [[deepSeekHeader(projectPath, sessionId, generation)]];
    writeFileSync(
        filePath,
        encoding === 'zstd'
            ? deepSeekZstdBytes(records)
            : `${records
                  .flat()
                  .map((record) => JSON.stringify(record))
                  .join('\n')}\n`,
    );
    return filePath;
}

export function appendDeepSeekZstdFrame(filePath: string, records: object[]): void {
    appendFileSync(filePath, frameBytes(records));
}
