import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ResolvedElephaBin } from './binary.js';
import type { IntegrationRefresh } from './integrations.js';

export function refreshInstalledIntegrations(installed: ResolvedElephaBin, launcher: string): Promise<IntegrationRefresh> {
    return new Promise((resolve, reject) => {
        // Only the resolved installed package supplies executable code. Provider
        // files remain inert input to its ownership-guarded filesystem transforms.
        const worker = new Worker(path.join(installed.packageRoot, 'dist/install/integration-refresh-worker.js'), {
            workerData: { launcher },
        });
        let result: IntegrationRefresh | undefined;
        worker.once('message', (value: IntegrationRefresh) => {
            result = value;
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
            if (code === 0 && result) {
                resolve(result);
            } else {
                reject(new Error(`integration refresh worker exited without a result (code ${code})`));
            }
        });
    });
}
