import {
    LIVE_MEMORY_CAPACITY_BYTES,
    LIVE_MEMORY_CLEANUP_TARGET_BYTES,
    LIVE_MEMORY_WARNING_BYTES,
} from '../config/live-memory-retention.js';

function percentOfCapacity(bytes: number): string {
    return `${Math.round((bytes / LIVE_MEMORY_CAPACITY_BYTES) * 100)}%`;
}

// What approving a root means. `elepha init`, `elepha consent` and
// `elepha consent grant` all show this same text before any grant, so a user
// reaches the same filtered-capture and retention contract by every path.
export const CONSENT_CONTRACT_DISCLOSURE = [
    'Approving a folder or project:',
    '- Covers that physical path and the projects inside it. A separate worktree of the same repository is not included; it needs its own approval.',
    '- Lets elepha keep filtered memory of eligible past and future Claude Code and Codex sessions there. Sessions already gone from local history cannot be recovered.',
    '- Filtered memory keeps prompts, replies and which files tools touched. It does not store raw transcripts, model reasoning or fetched tool output.',
    `- Live memory is limited to ${LIVE_MEMORY_CAPACITY_BYTES.toLocaleString('en-US')} bytes of logical memory, not a cap on every file. ` +
        `From ${percentOfCapacity(LIVE_MEMORY_WARNING_BYTES)} new chats show a warning; at 100% elepha removes the oldest eligible complete sessions ` +
        `until at most ${percentOfCapacity(LIVE_MEMORY_CLEANUP_TARGET_BYTES)} remains. Installed models and recoverable backups are not counted.`,
].join('\n');

// Measured on an installed runtime: the q8 multilingual-e5-small model is about
// 113 MB and the isolated npm runtime adds several hundred MB more.
export const SEMANTIC_SEARCH_DISCLOSURE =
    'Local semantic search finds past sessions by meaning, in any language. After you confirm, elepha downloads a local runtime and model once ' +
    '(about 500 MB on disk) and uses about 1 GB of memory while indexing or searching. Everything runs on this machine; no session data leaves it.';

export const TERM_SEARCH_DISCLOSURE =
    'Term-only search keeps explicit term search and read commands. It does not match by meaning across languages or bring back related past work automatically.';

export const TERM_SEARCH_RETAINS_MEMORY_PLUS = "elepha's Memory-Plus turns off. Stored vectors and the local runtime are kept.";
