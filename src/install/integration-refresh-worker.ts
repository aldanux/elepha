import { parentPort, workerData } from 'node:worker_threads';
import { reconcileOwnedIntegrations } from './integrations.js';

// This installed-package entry point gets a fresh module cache after npm replaces
// the build. A cache-busted import alone would still reuse old renderer dependencies.
if (parentPort) {
    parentPort.postMessage(reconcileOwnedIntegrations(workerData.launcher));
}
