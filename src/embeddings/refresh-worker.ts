import { parentPort, workerData } from 'node:worker_threads';
import { getSetting } from '../config/settings.js';
import { openManagedDatabase } from '../storage/db.js';
import { type GenerationResult, generateEmbeddings } from './generate.js';
import { createEmbeddingProvider } from './provider-config.js';

const { databasePath, cancellation: buffer } = workerData as { databasePath: string; cancellation: SharedArrayBuffer };
const cancellation = new Int32Array(buffer);
const cancelled = new Error('Embedding refresh stopped.');
function checkRunning(): void {
    if (Atomics.load(cancellation, 0) !== 0) {
        throw cancelled;
    }
}

async function refresh(): Promise<GenerationResult | undefined> {
    // Recheck after thread startup, before opening storage or creating a provider.
    if (!getSetting('memory-plus').value || Atomics.load(cancellation, 0) !== 0) {
        return;
    }
    // The daemon already initialized the schema. Avoid migrations on each pass;
    // use the managed opener to preserve encryption and lifecycle protection.
    const db = await openManagedDatabase(databasePath, { fileMustExist: true });
    try {
        checkRunning();
        return await generateEmbeddings(db, {
            progress: checkRunning,
            createProvider: async (...args) => {
                checkRunning();
                const provider = await createEmbeddingProvider(...args);
                if (!provider) {
                    return;
                }
                return {
                    configuration: provider.configuration,
                    embed: (text, beforeUse, purpose) =>
                        provider.embed(
                            text,
                            () => {
                                checkRunning();
                                beforeUse();
                            },
                            purpose,
                        ),
                    dispose: () => provider.dispose(),
                };
            },
        });
    } catch (error) {
        if (error !== cancelled && !(error instanceof Error && error.cause === cancelled)) {
            throw error;
        }
    } finally {
        // Cooperative cancellation lets provider disposal and managed lifecycle
        // cleanup finish. Terminating a thread could strand a live-PID DB lease.
        db.close();
    }
}

parentPort?.postMessage({ result: await refresh() });
