import { createRequire } from 'node:module';
import { memoryPlusPackagePath } from './dependency.js';

export const MEMORY_PLUS_INSTALL_HINT = 'Run elepha enable memory-plus to install or repair the local runtime.';

// Only the runtime surface used here is typed; the optional package is absent
// from normal installs, including development and TypeScript builds.
export interface FeatureExtractionPipeline {
    (text: string, options: { pooling: 'mean'; normalize: true }): Promise<{ data: ArrayLike<number> }>;
    tokenizer: { encode(text: string): number[] };
    dispose(): Promise<void>;
}

interface TransformersRuntime {
    env: { allowLocalModels: boolean };
    pipeline(
        task: 'feature-extraction',
        model: string,
        options: { revision: string; dtype: 'q8'; device: 'cpu'; cache_dir: string },
    ): Promise<FeatureExtractionPipeline>;
}

export function loadLocalRuntime(): TransformersRuntime {
    try {
        // An absolute package directory resolves its Node entry point without
        // falling back to elepha's or an ancestor's node_modules.
        const runtime = createRequire(import.meta.url)(memoryPlusPackagePath()) as TransformersRuntime;
        if (typeof runtime.pipeline !== 'function' || !runtime.env) {
            throw new Error('Invalid Transformers runtime');
        }
        return runtime;
    } catch (error) {
        throw new Error(`elepha Memory Plus local runtime is missing or could not be loaded. ${MEMORY_PLUS_INSTALL_HINT}`, {
            cause: error,
        });
    }
}
