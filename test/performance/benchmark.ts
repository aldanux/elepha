// Reproducible, provider-free performance benchmark. Run with `npm run bench`.
//
// Every measurement drives a production entry point against a deterministic
// synthetic Claude Code corpus: approved-root backfill through the real
// adapter and daemon, `elepha:query` through the real UserPromptSubmit hook,
// and `recall` through the MCP tool handler. No summarizer, model, network,
// keychain, user database, or home-directory transcript is involved; all data
// is generated under a fresh directory in .test-scratch and removed at exit.
//
// Usage: npm run bench -- [--sizes 100,500,2000] [--projects 10] [--samples 20] [--warmup 5] [--ingest-samples 3] [--json]

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const scratchRoot = path.resolve(import.meta.dirname, '..', '..', '.test-scratch');
mkdirSync(scratchRoot, { recursive: true });
const workDirectory = realpathSync(mkdtempSync(path.join(scratchRoot, 'performance-')));

// Point every provider store and elepha-owned path into the scratch tree before
// any application module resolves them, so nothing outside the repository is read.
process.env.ELEPHA_HOME = path.join(workDirectory, 'elepha-home');
process.env.CODEX_HOME = path.join(workDirectory, 'codex');
process.env.XDG_DATA_HOME = path.join(workDirectory, 'xdg-data');
process.env.XDG_CONFIG_HOME = path.join(workDirectory, 'xdg-config');
mkdirSync(process.env.ELEPHA_HOME, { recursive: true });
// Same process-local seam test/setup.ts uses to keep database lease records out of ~/.elepha.
(globalThis as Record<symbol, unknown>)[Symbol.for('dev.elepha.internal.database-lifecycle-test-directory')] = path.join(
    workDirectory,
    'database-lifecycle',
);

const { IngestionDaemon } = await import('../../src/daemon/index.js');
const { runUserPromptSubmit } = await import('../../src/hooks/user-prompt-submit.js');
const { ElephaMcpService, openMcpReadOnlyDatabase } = await import('../../src/mcp/server.js');
const { openUnmanagedDb } = await import('../../src/storage/db.js');
const { MemoryStore } = await import('../../src/storage/memory-store.js');
const { PACKAGE_VERSION } = await import('../../src/config/version.js');

const { values: options } = parseArgs({
    options: {
        sizes: { type: 'string', default: '100,500,2000' },
        samples: { type: 'string', default: '20' },
        warmup: { type: 'string', default: '5' },
        'ingest-samples': { type: 'string', default: '3' },
        projects: { type: 'string', default: '10' },
        json: { type: 'boolean', default: false },
    },
});

function positiveInteger(name: string, value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(value)}`);
    }
    return parsed;
}

const SIZES = options.sizes.split(',').map((size) => positiveInteger('sizes', size.trim()));
const SAMPLES = positiveInteger('samples', options.samples);
const WARMUP = positiveInteger('warmup', options.warmup);
const INGEST_SAMPLES = positiveInteger('ingest-samples', options['ingest-samples']);
// Sessions are spread round-robin over this many consented projects. Read paths
// probe each project directory, so this is a cost axis separate from corpus size.
const PROJECT_COUNT = positiveInteger('projects', options.projects);

// Corpus shape. Fixed seed and fixed base time make every run byte-identical.
const SEED = 0x5eed_e1e9;
const MIN_TURNS = 4;
const MAX_TURNS = 8;
const NEEDLE = 'zephyrcache';
const NEEDLE_EVERY = 20;
const MISS_TERM = 'quuxnonexistentterm';
const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
const WORDS = (
    'api auth cache client config daemon database decision deploy endpoint error feature handler hook index ' +
    'ingest latency migration module parser project query recall refactor render request retry schema ' +
    'server session sqlite storage summary test timeout token transcript turn update validation watcher worker'
).split(' ');

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function sentence(random: () => number, words: number): string {
    return Array.from({ length: words }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ');
}

function sessionUuid(index: number): string {
    const hex = index.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
}

interface Corpus {
    root: string;
    watchRoot: string;
    projects: string[];
    sessions: number;
    turns: number;
    bytes: number;
}

// Writes N sessions in the Claude Code JSONL shape the adapter parses: a user
// prompt, an assistant tool call, its tool result, and a closing assistant
// answer per turn. Every NEEDLE_EVERY-th session mentions the needle term.
function writeCorpus(size: number, label = `corpus-${size}`): Corpus {
    const root = path.join(workDirectory, label);
    const approved = path.join(root, 'projects');
    // A Claude config root per corpus: the adapter resolves CLAUDE_CONFIG_DIR on
    // every call, so each measured corpus is read alone without deleting another.
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
    const watchRoot = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects');
    const projects: string[] = [];
    for (let index = 0; index < PROJECT_COUNT; index++) {
        const project = path.join(approved, `project-${index}`);
        mkdirSync(project, { recursive: true });
        // Stop Git discovery at the project so every project resolves as a non-repository.
        writeFileSync(path.join(project, '.git'), `gitdir: ${path.join(project, '.missing-git-dir')}\n`);
        projects.push(project);
    }
    const random = mulberry32(SEED);
    let turns = 0;
    let bytes = 0;
    for (let index = 0; index < size; index++) {
        const cwd = projects[index % PROJECT_COUNT]!;
        const sessionId = sessionUuid(index);
        const turnCount = MIN_TURNS + Math.floor(random() * (MAX_TURNS - MIN_TURNS + 1));
        const lines: string[] = [];
        let clock = BASE_TIME + index * 3_600_000;
        let parent: string | null = null;
        const record = (fields: Record<string, unknown>): void => {
            const uuid = `${sessionId}-${lines.length}`;
            clock += 1_000;
            lines.push(
                JSON.stringify({
                    parentUuid: parent,
                    isSidechain: false,
                    uuid,
                    timestamp: new Date(clock).toISOString(),
                    userType: 'external',
                    entrypoint: 'cli',
                    cwd,
                    sessionId,
                    version: '2.1.220',
                    gitBranch: 'main',
                    ...fields,
                }),
            );
            parent = uuid;
        };
        for (let turn = 0; turn < turnCount; turn++) {
            const needle = turn === 0 && index % NEEDLE_EVERY === 0 ? ` ${NEEDLE}` : '';
            const toolId = `${sessionId}-tool-${turn}`;
            record({ type: 'user', promptId: `p${turn}`, message: { role: 'user', content: `${sentence(random, 20)}${needle}` } });
            record({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: sentence(random, 12) },
                        { type: 'tool_use', name: 'Read', input: { file_path: `src/${WORDS[turn % WORDS.length]}.ts` }, id: toolId },
                    ],
                },
            });
            record({
                type: 'user',
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: sentence(random, 30) }] },
            });
            record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: sentence(random, 60) }] } });
        }
        turns += turnCount;
        const directory = path.join(watchRoot, `-bench-project-${index % PROJECT_COUNT}`);
        mkdirSync(directory, { recursive: true });
        const body = `${lines.join('\n')}\n`;
        writeFileSync(path.join(directory, `${sessionId}.jsonl`), body);
        bytes += Buffer.byteLength(body);
    }
    return { root: realpathSync(approved), watchRoot, projects, sessions: size, turns, bytes };
}

interface Stats {
    samples: number;
    median: number;
    p95: number;
    min: number;
    max: number;
}

function stats(values: number[]): Stats {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (quantile: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)]!;
    return { samples: sorted.length, median: at(0.5), p95: at(0.95), min: sorted[0]!, max: sorted.at(-1)! };
}

async function timeRepeated(run: () => Promise<void>): Promise<Stats> {
    for (let index = 0; index < WARMUP; index++) {
        await run();
    }
    const durations: number[] = [];
    for (let index = 0; index < SAMPLES; index++) {
        const started = performance.now();
        await run();
        durations.push(performance.now() - started);
    }
    return stats(durations);
}

interface IngestRun {
    ms: number;
    dbPath: string;
}

// One cold capture of the whole corpus into a fresh database through the
// daemon's approved-root backfill: adapter parse, consent check, turn storage.
async function ingestOnce(corpus: Corpus, label: string): Promise<IngestRun> {
    const dbPath = path.join(workDirectory, `${label}.db`);
    const store = new MemoryStore(openUnmanagedDb(dbPath));
    store.consent.grant(corpus.root);
    const daemon = new IngestionDaemon({ store, watchRoots: [corpus.watchRoot], logError: () => {} });
    const started = performance.now();
    const ingested = await daemon.backfillApprovedRoot(corpus.root);
    const ms = performance.now() - started;
    const sessions = (store.database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
    const turns = (store.database.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count;
    store.database.close();
    if (sessions !== corpus.sessions) {
        throw new Error(`ingestion stored ${sessions} sessions for a ${corpus.sessions}-session corpus (backfill reported ${ingested})`);
    }
    if (turns !== corpus.turns) {
        throw new Error(`ingestion stored ${turns} completed-turn rows for a ${corpus.turns}-turn corpus (backfill reported ${ingested})`);
    }
    return { ms, dbPath };
}

function fileBytes(filePath: string): number {
    return statSync(filePath).size;
}

// The WAL file is only present while the writer holds it open at checkpoint
// time; its absence (ENOENT) is a legitimate empty result, not a failure.
function optionalFileBytes(filePath: string): number {
    try {
        return statSync(filePath).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 0;
        }
        throw error;
    }
}

function contextOf(result: Awaited<ReturnType<typeof runUserPromptSubmit>>): string {
    if (!('output' in result)) {
        throw new Error(`elepha:query returned no output: ${result.reason}`);
    }
    return String((result.output.hookSpecificOutput as Record<string, unknown>).additionalContext);
}

// Classifies a response by its hit or empty header rather than by the query
// term, because both headers echo the term. Returns the reported match count
// (0 for the empty header) and rejects any other shape.
function matchCount(surface: string, text: string, hitHeader: RegExp): number {
    const hit = hitHeader.exec(text);
    if (hit !== null) {
        return Number(hit[1]);
    }
    if (text.includes('No recall matches found for “')) {
        return 0;
    }
    throw new Error(`${surface} returned neither a hit nor an empty-result response:\n${text}`);
}

const QUERY_HIT_HEADER = /^Recall hits for “[^”]*” \((\d+) shown of \d+\):$/m;
const RECALL_HIT_HEADER = /^Recall material for “[^”]*” \((\d+) matching episode\(s\)\):$/m;

function hookPayload(cwd: string, prompt: string): string {
    return JSON.stringify({
        session_id: 'benchmark-session',
        cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt,
        turn_id: 'turn-1',
        model: 'benchmark',
        permission_mode: 'default',
        transcript_path: null,
    });
}

interface SizeResult {
    sessions: number;
    turns: number;
    transcriptBytes: number;
    ingest: { stats: Stats; sessionsPerSecond: number; turnsPerSecond: number };
    database: { bytes: number; bytesPerSession: number };
    query: { hit: Stats; miss: Stats };
    recall: { hit: Stats; miss: Stats };
}

async function measureSize(size: number): Promise<SizeResult> {
    const corpus = writeCorpus(size);
    const ingestDurations: number[] = [];
    let dbPath = '';
    for (let sample = 0; sample < INGEST_SAMPLES; sample++) {
        const run = await ingestOnce(corpus, `ingest-${size}-${sample}`);
        ingestDurations.push(run.ms);
        dbPath = run.dbPath;
    }
    const ingest = stats(ingestDurations);

    // Closing the only connection checkpoints the WAL, so the main file is the settled size.
    const databaseBytes = fileBytes(dbPath) + optionalFileBytes(`${dbPath}-wal`);

    const cwd = corpus.projects[0]!;
    const queryOnce = async (term: string, expectHit: boolean): Promise<void> => {
        const context = contextOf(await runUserPromptSubmit(hookPayload(cwd, `elepha:query ${term}`), 'codex', { dbPath, log: () => {} }));
        if (matchCount('elepha:query', context, QUERY_HIT_HEADER) > 0 !== expectHit) {
            throw new Error(`elepha:query ${term} ${expectHit ? 'missed the needle' : 'unexpectedly matched'}`);
        }
    };
    const queryHit = await timeRepeated(() => queryOnce(NEEDLE, true));
    const queryMiss = await timeRepeated(() => queryOnce(MISS_TERM, false));

    // The MCP server holds one read-only connection for its lifetime; so does this.
    const mcpDb = await openMcpReadOnlyDatabase(dbPath);
    const service = new ElephaMcpService(mcpDb);
    const recallOnce = async (term: string, expectHit: boolean): Promise<void> => {
        const result = await service.recall({ query: term });
        const text = result.content.map((part) => part.text).join('\n');
        if (matchCount('recall', text, RECALL_HIT_HEADER) > 0 !== expectHit) {
            throw new Error(`recall ${term} ${expectHit ? 'missed the needle' : 'unexpectedly matched'}`);
        }
    };
    const recallHit = await timeRepeated(() => recallOnce(NEEDLE, true));
    const recallMiss = await timeRepeated(() => recallOnce(MISS_TERM, false));
    mcpDb.close();

    return {
        sessions: corpus.sessions,
        turns: corpus.turns,
        transcriptBytes: corpus.bytes,
        ingest: {
            stats: ingest,
            sessionsPerSecond: corpus.sessions / (ingest.median / 1000),
            turnsPerSecond: corpus.turns / (ingest.median / 1000),
        },
        database: { bytes: databaseBytes, bytesPerSession: databaseBytes / corpus.sessions },
        query: { hit: queryHit, miss: queryMiss },
        recall: { hit: recallHit, miss: recallMiss },
    };
}

const ms = (value: number): string => value.toFixed(1);
const range = (value: Stats): string => `${ms(value.median)} / ${ms(value.p95)}`;
const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(2);

function renderMarkdown(results: SizeResult[], environment: Record<string, string>): string {
    const lines = [
        '## Environment',
        '',
        ...Object.entries(environment).map(([key, value]) => `- ${key}: ${value}`),
        '',
        '## Ingestion (cold approved-root backfill, no summarizer)',
        '',
        `| Sessions | Turns | Transcript MiB | Median ms | Min–max ms | Sessions/s | Turns/s | Samples |`,
        '|---:|---:|---:|---:|---:|---:|---:|---:|',
        ...results.map(
            (result) =>
                `| ${result.sessions} | ${result.turns} | ${mib(result.transcriptBytes)} | ${ms(result.ingest.stats.median)} | ` +
                `${ms(result.ingest.stats.min)}–${ms(result.ingest.stats.max)} | ${result.ingest.sessionsPerSecond.toFixed(0)} | ` +
                `${result.ingest.turnsPerSecond.toFixed(0)} | ${result.ingest.stats.samples} |`,
        ),
        '',
        '## Database size',
        '',
        '| Sessions | Database MiB | KiB per session |',
        '|---:|---:|---:|',
        ...results.map(
            (result) => `| ${result.sessions} | ${mib(result.database.bytes)} | ${(result.database.bytesPerSession / 1024).toFixed(1)} |`,
        ),
        '',
        '## Query and recall latency (median / p95 ms)',
        '',
        '| Sessions | `elepha:query` hit | `elepha:query` miss | MCP `recall` hit | MCP `recall` miss |',
        '|---:|---:|---:|---:|---:|',
        ...results.map(
            (result) =>
                `| ${result.sessions} | ${range(result.query.hit)} | ${range(result.query.miss)} | ` +
                `${range(result.recall.hit)} | ${range(result.recall.miss)} |`,
        ),
        '',
        `Latency samples per cell: ${SAMPLES} after ${WARMUP} warmup runs.`,
    ];
    return lines.join('\n');
}

try {
    // Untimed warmup so module loading and JIT compilation do not land in the first ingestion sample.
    await ingestOnce(writeCorpus(Math.min(...SIZES), 'warmup'), 'warmup');

    const results: SizeResult[] = [];
    for (const size of SIZES) {
        results.push(await measureSize(size));
    }
    const cpu = cpus();
    const environment = {
        elepha: PACKAGE_VERSION,
        node: process.version,
        platform: `${platform()} ${release()} ${arch()}`,
        cpu: `${cpu[0]?.model ?? 'unknown'} (${cpu.length} logical cores)`,
        memory: `${(totalmem() / 1024 ** 3).toFixed(0)} GiB`,
        'peak RSS': `${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MiB`,
        corpus: `seed 0x${SEED.toString(16)}, ${PROJECT_COUNT} projects, ${MIN_TURNS}-${MAX_TURNS} turns/session, needle in 1/${NEEDLE_EVERY} sessions`,
    };
    process.stdout.write(`${options.json ? JSON.stringify({ environment, results }, null, 2) : renderMarkdown(results, environment)}\n`);
} finally {
    try {
        rmSync(workDirectory, { recursive: true, force: true });
    } catch (error) {
        // Cleanup must not mask a measurement failure; .test-scratch is gitignored.
        process.stderr.write(`benchmark scratch left at ${workDirectory}: ${(error as Error).message}\n`);
    }
}
