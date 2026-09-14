import { Worker } from 'node:worker_threads';
import type { GenerationResult } from './generate.js';

export interface EmbeddingRefresh {
    done: Promise<GenerationResult | undefined>;
    stop(): void;
}

export function startEmbeddingRefresh(databasePath: string, report: (message: string) => void = console.warn): EmbeddingRefresh {
    // Only installed code is executable; this path is the daemon's configured
    // database, never a transcript path. Even synchronous native model loading
    // and all-current history scans stay off the ingestion event loop.
    const cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const worker = new Worker(new URL('./refresh-worker.js', import.meta.url), {
        workerData: { databasePath, cancellation: cancellation.buffer },
    });
    const done = new Promise<GenerationResult | undefined>((resolve, reject) => {
        let reply: { result?: GenerationResult } | undefined;
        let failure: unknown;
        worker.on('message', (message: { result?: GenerationResult; diagnostic?: string }) => {
            if (typeof message.diagnostic === 'string') {
                report(message.diagnostic);
            } else if (Object.hasOwn(message, 'result')) {
                reply = message;
            }
        });
        worker.once('error', (error) => {
            failure = error;
        });
        worker.once('exit', (code) => {
            if (failure) {
                reject(failure);
            } else if (code !== 0 || reply === undefined) {
                reject(new Error(`Embedding refresh worker exited without a result (code ${code}).`));
            } else {
                resolve(reply.result);
            }
        });
    });
    return { done, stop: () => Atomics.store(cancellation, 0, 1) };
}
