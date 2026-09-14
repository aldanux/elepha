import type { Database } from 'better-sqlite3-multiple-ciphers';
import type { Command } from 'commander';
import { getSetting, setSetting } from '../../config/settings.js';
import { installMemoryPlusDependency } from '../../embeddings/dependency.js';
import { generateEmbeddings } from '../../embeddings/generate.js';
import { createEmbeddingProvider, type EmbeddingProvider, embeddingConfiguration } from '../../embeddings/provider-config.js';
import { openDb } from '../../storage/db.js';
import { errorMessage } from '../../util/error.js';
import { confirmYesNo } from '../shared.js';

export const MEMORY_PLUS_INTRO = 'elepha Memory Plus finds past sessions by meaning, not just matching words. Works in any language.';
export const MEMORY_PLUS_LOCAL_NOTICE =
    'Downloads a small AI model once (~113MB), runs locally, uses ~1GB of memory while active. No session data leaves your machine.';
export const MEMORY_PLUS_API_NOTICE =
    'Uses OpenAI embeddings because OPENAI_API_KEY is configured. Session titles, first-prompt search text, summaries, decisions, pending items and any stored instructions sent for embedding leave your machine and are sent to OpenAI. API usage is billed by OpenAI. No local model is downloaded.';
export const MEMORY_PLUS_CONFIRM = 'Continue? [y/N] ';
export const MEMORY_PLUS_PROBE = 'elepha Memory Plus setup check';

export async function enableMemoryPlus(
    options: {
        configPath?: string;
        environment?: NodeJS.ProcessEnv;
        confirm?: typeof confirmYesNo;
        createProvider?: typeof createEmbeddingProvider;
        installDependency?: typeof installMemoryPlusDependency;
        openDatabase?: () => Promise<Database>;
        log?: (message: string) => void;
    } = {},
): Promise<boolean> {
    const environment = { ...(options.environment ?? process.env) };
    const log = options.log ?? console.log;
    log(MEMORY_PLUS_INTRO);
    log('');
    log(embeddingConfiguration(true, environment)?.provider === 'openai' ? MEMORY_PLUS_API_NOTICE : MEMORY_PLUS_LOCAL_NOTICE);
    log('');
    if (!(await (options.confirm ?? confirmYesNo)(MEMORY_PLUS_CONFIRM))) {
        log('Cancelled. elepha Memory Plus settings were not changed.');
        return false;
    }
    let provider: EmbeddingProvider | undefined;
    try {
        if (embeddingConfiguration(true, environment)?.provider === 'local') {
            log('Installing elepha Memory Plus local runtime…');
            await (options.installDependency ?? installMemoryPlusDependency)();
        }
        provider = await (options.createProvider ?? createEmbeddingProvider)(true, environment);
        if (provider === undefined) {
            throw new Error('Embedding provider was not available.');
        }
        // Verification uses fixed synthetic text, never session content. The
        // persistent flag is committed only after setup and cleanup succeed.
        await provider.embed(MEMORY_PLUS_PROBE, () => {});
        await provider.dispose();
        provider = undefined;
        setSetting('memory-plus', 'true', options.configPath);
    } catch (error) {
        if (getSetting('memory-plus', {}, options.configPath).value) {
            setSetting('memory-plus', 'false', options.configPath);
        }
        throw error;
    } finally {
        await provider?.dispose();
    }
    // Setup succeeded. A partial backfill keeps both the opt-in and completed
    // vectors so the next automatic pass (or an explicit retry) can resume.
    try {
        log('Indexing existing history for elepha Memory Plus…');
        const db = await (options.openDatabase ?? openDb)();
        try {
            const result = await generateEmbeddings(db, {
                configPath: options.configPath,
                environment,
                createProvider: options.createProvider,
                progress: ({ generated, current }) => log(`Indexing: ${generated} sessions indexed, ${current} already current.`),
            });
            log(
                `elepha Memory Plus enabled. ${result.generated} sessions indexed, ${result.current} already current, ${result.ineligibleOrEmpty} ineligible or empty sessions skipped. New and updated sessions will be indexed automatically.`,
            );
        } finally {
            db.close();
        }
    } catch (error) {
        throw new Error(
            `elepha Memory Plus remains enabled, but initial indexing failed: ${errorMessage(error)} Completed vectors are retained. Automatic indexing will retry; run elepha embeddings to retry now.`,
            { cause: error },
        );
    }
    return true;
}

export function registerEnable(program: Command): void {
    program
        .command('enable')
        .description('Enable an optional feature after confirming its setup and privacy trade-offs')
        .command('memory-plus')
        .description('Prepare local multilingual embeddings, or OpenAI embeddings when OPENAI_API_KEY is configured')
        .action(async () => {
            try {
                await enableMemoryPlus();
            } catch (error) {
                console.error(`elepha Memory Plus setup failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });
}
