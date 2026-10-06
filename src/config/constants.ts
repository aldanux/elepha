// Central registry for elepha's operational constants.

// CLI, serving, and capture policy
export const ELEPHA_WORDMARK = `███████╗ ██╗      ███████╗ ██████╗  ██╗  ██╗  █████╗
██╔════╝ ██║      ██╔════╝ ██╔══██╗ ██║  ██║ ██╔══██╗
█████╗   ██║      █████╗   ██████╔╝ ███████║ ███████║
██╔══╝   ██║      ██╔══╝   ██╔═══╝  ██╔══██║ ██╔══██║
███████╗ ███████╗ ███████╗ ██║      ██║  ██║ ██║  ██║
╚══════╝ ╚══════╝ ╚══════╝ ╚═╝      ╚═╝  ╚═╝ ╚═╝  ╚═╝`;
export const ELEPHA_TAGLINE = ` · 🐘 elepha · switch tools, keep the context · `;
export const DOCS_URL = 'https://github.com/aldanux/elepha#readme';
export { PACKAGE_VERSION, readInstalledPackageVersion } from './version.js';
export const BACKUP_KEEP = 5;
export const USER_BACKUPS_DIR_NAME = 'backups';
export const SQLITE_MINIMUM_DATABASE_BYTES = 512;
export const CHARS_PER_TOKEN = 4;
export const SESSION_TOKEN_BUDGET = 20_000;
export const SESSION_CHAR_BUDGET = SESSION_TOKEN_BUDGET * CHARS_PER_TOKEN;
export const ELEPHA_MCP_NAMESPACE = 'mcp__elepha';
// Provider call identifiers are short opaque tokens. Bound their UTF-8
// bytes before retaining them in correlation sets or durable receipt
// keys.
export const ELEPHA_MCP_CALL_ID_MAX_BYTES = 1024;
export const ELEPHA_MCP_UNMATCHED_RESULT_IDS_MAX = 64;
export const ELEPHA_MCP_UNMATCHED_RESULT_ID_BYTES_MAX = ELEPHA_MCP_UNMATCHED_RESULT_IDS_MAX * ELEPHA_MCP_CALL_ID_MAX_BYTES;
// Canonical MCP responses are already bounded by the session serving budget.
// Four UTF-8 bytes per served character accepts that complete bound
// without truncating multibyte text and caps retained security evidence.
export const ELEPHA_MCP_RESULT_MAX_BYTES = SESSION_CHAR_BUDGET * 4;
export const ELEPHA_MCP_RESULTS_PER_TURN_MAX = 64;
// One turn may contain several valid MCP results. Bound their combined body
// below the quote-back scan budget so recording a valid turn cannot make its
// own future protection permanently incomplete.
export const ELEPHA_MCP_RESULTS_PER_TURN_MAX_BYTES = 4 * 1024 * 1024;
// The working AI reports its own task state through this elepha MCP tool.
// Unlike every other elepha tool it serves no memory, so its call is parsed
// into a separate report field instead of dropping the invoking turn.
export const TASK_STATE_REPORT_TOOL = 'report_task_state';
// OpenCode V2 exposes direct MCP tools as <server>_<tool> when codemode is false.
export const OPENCODE_ELEPHA_MCP_PREFIX = 'elepha_';
// OpenCode V2 completed-compaction notifications are volatile and contain
// untrusted host text. Keep receipts small and evict old observations.
export const OPENCODE_COMPACTION_RECEIPT_MAX_TEXT_BYTES = 32 * 1024;
export const OPENCODE_COMPACTION_RECEIPT_MAX_CWD_BYTES = 4096;
export const OPENCODE_COMPACTION_RECEIPT_HOST_VERSION = '2.0.18';
export const OPENCODE_COMPACTION_RECEIPT_CONTRACT = `opencode-v${OPENCODE_COMPACTION_RECEIPT_HOST_VERSION}-session.compaction.ended`;
export const OPENCODE_COMPACTION_RECEIPT_ACK = 'elepha compaction receipt stored';
export const OPENCODE_TASK_STATE_RECEIPT_CONTRACT = `opencode-v${OPENCODE_COMPACTION_RECEIPT_HOST_VERSION}-report-task-state-success`;
export const OPENCODE_TASK_STATE_RECEIPT_ACK = 'elepha task-state call observed';
export const OPENCODE_TASK_STATE_RECEIPT_PENDING_MAX = 128;
export const OPENCODE_TASK_STATE_RECEIPT_PENDING_MAX_AGE_MS = 60_000;
export const OPENCODE_TASK_STATE_RECEIPTS_PER_SESSION = 32;
export const OPENCODE_TASK_STATE_RECEIPTS_GLOBAL_MAX = 4096;
export const OPENCODE_COMPACTION_RECEIPTS_PER_SESSION = 16;
export const OPENCODE_COMPACTION_RECEIPTS_GLOBAL_MAX = 4096;
// The tool's only successful result. Anything else fails the report closed,
// and a fixed body cannot carry served memory back into the transcript.
export const TASK_STATE_REPORT_ACK = 'elepha received the task-state report.';
export const TASK_STATE_REPORT_MODES = ['precompact_manifest', 'postcompact_retained'] as const;
export const TASK_STATE_REQUEST_ID_CHARS = 26;
export const TASK_STATE_REQUEST_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
// A report is bounded task evidence, not a transcript. Reject it whole when
// a field or the complete decoded input exceeds its ceiling.
export const TASK_STATE_REPORT_LIST_MAX_ITEMS = 8;
export const TASK_STATE_REPORT_ITEM_MAX_CHARS = 400;
export const TASK_STATE_REPORT_SOURCE_MAX_ITEMS = 2;
export const TASK_STATE_REPORT_SOURCE_QUOTE_MAX_CHARS = 500;
// Raw input ceiling, checked before a JSON-encoded argument string is
// decoded. The decoded report is checked against this ceiling separately.
export const TASK_STATE_REPORT_INPUT_MAX_BYTES = 32 * 1024;
export const TASK_STATE_MANIFEST_TIMESTAMP_MAX_BYTES = 64;
export const TASK_STATE_MANIFEST_MAX_SOURCE_TURNS = 64;
export const TASK_STATE_HISTORICAL_MAX_TAIL_ROWS = 64;
export const TASK_STATE_MANIFEST_VERIFY_DEADLINE_MS = 1_200;
// Checked before a JSON-encoded result envelope is decoded. The fixed
// acknowledgement plus its MCP envelope fits well inside this bound.
export const TASK_STATE_REPORT_RESULT_MAX_BYTES = 1024;
// Quote-back checks run on the ingestion hot path. These ceilings are well
// above ordinary per-chat injection volume while making incomplete coverage explicit.
export const INJECTION_QUOTE_BACK_MAX_ROWS = 512;
export const INJECTION_QUOTE_BACK_MAX_BYTES = 8 * 1024 * 1024;
// A quoted MCP result can approach 4 MiB. Twice that keeps room for
// surrounding conversation while bounding normalization input.
export const INJECTION_QUOTE_BACK_TURN_MAX_BYTES = 8 * 1024 * 1024;
// Quote-back runs synchronously during ingestion. A deadline makes
// repeated high-entropy comparisons fail closed instead of blocking.
export const INJECTION_QUOTE_BACK_BUDGET_MS = 100;
// 400k tokens sits far above a typical session while keeping pathological input bounded;
// this is a safety ceiling for resume, not a presentation budget.
export const RESUME_TOKEN_BUDGET = 400_000;
export const RESUME_CHAR_BUDGET = RESUME_TOKEN_BUDGET * CHARS_PER_TOKEN;
export const DURABLE_CAPTURE_FILTER_VERSION = 1;
// Per-field ceiling of the bounded per-turn projection recorded in turn search
// coverage. Text beyond it is reported as truncated coverage with its omitted
// character count, which stored-evidence and embedding readers consume.
export const TURN_SEARCH_INDEX_MAX_FIELD_CHARS = 64 * 1024;
// Reconciling coverage rows against retained copies pages memory ids so an
// upgrade of a large cache never materializes the whole index; copies load one
// at a time.
export const TURN_SEARCH_REBUILD_BATCH_SIZE = 1000;
// Structural offsets retain whole final messages without duplicating their
// text. Bound metadata independently when a turn contains many messages.
export const ASSISTANT_STRUCTURE_MAX_FINALS = 256;
export const DURABLE_CAPTURE_STATES = [
    'complete',
    'complete_truncated',
    'disabled_gap',
    'parse_error',
    'revoked',
    'incognito',
    'evicted',
] as const;
export type DurableCaptureState = (typeof DURABLE_CAPTURE_STATES)[number];
export const MAX_GET_SESSION_LAST_N = 500;
export const GET_SESSION_DEADLINE_MS = 5_000;
export const AUTO_BRIEF_TOKEN_BUDGET = 4_000;
export const AUTO_BRIEF_CHAR_BUDGET = AUTO_BRIEF_TOKEN_BUDGET * CHARS_PER_TOKEN;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MCP_LIST_SESSIONS_DEFAULT_LIMIT = 20;
export const ELEPHA_LIST_DEFAULT_LIMIT = 5;
export const ELEPHA_LIST_MAX_LIMIT = 100;
// Standing rules are a hard write-time contract, not a ranked budget. A rule
// set that fits in one screen and one small prompt block is the whole product
// promise, so exceeding either bound fails the write instead of evicting,
// truncating, or ranking anything the user explicitly entered.
export const STANDING_RULES_MAX_ACTIVE = 8;
export const STANDING_RULES_MAX_TOTAL_CHARS = 1_200;
export const STANDING_RULE_MAX_CHARS = 300;
// Bound an imported scalar before SQLite transfers it into JavaScript.
// Four bytes per allowed character accommodates every valid UTF-8 rule.
export const STANDING_RULE_IMPORT_MAX_BYTES = STANDING_RULE_MAX_CHARS * 4;
export const REMEMBER_SESSION_RECENCY_CAP = { global: 5_000, here: 5_000 } as const;
export const REMEMBER_SCAN_BUDGET_MS = 3_000;
export const REMEMBER_MAX_HITS = 5;
export const REMEMBER_QUERY_FILLER_WORDS = ['a', 'about', 'an', 'and', 'for', 'me', 'of', 'please', 'the', 'to'] as const;
export const FIRST_PROMPT_SEARCH_CAP = 4_000;
export const REMEMBER_MATCH_SCORES = {
    title: 12_000,
    exactPhrase: 10_000,
    rollup: 6_000,
    content: 4_500,
    body: 3_000,
} as const;

// Storage and session segmentation
export const DATABASE_KEY_BYTES = 32;
export const DATABASE_HEADER_BYTES = 16;
export const DATABASE_KEYRING_TIMEOUT_MS = 5_000;
export const DATABASE_LIFECYCLE_ACQUIRE_TIMEOUT_MS = 5_000;
export const DATABASE_LIFECYCLE_POLL_MS = 25;
export const DATABASE_LIFECYCLE_RECORD_MAX_BYTES = 4_096;
export const DATABASE_LIFECYCLE_BIRTHTIME_PROOF_ANCESTOR_LIMIT = 64;
// Millisecond-aligned leaf ctime cannot prove that an unlink/link ABA changed metadata.
export const DATABASE_LIFECYCLE_COARSE_TIMESTAMP_QUANTUM_NS = 1_000_000n;
export const DATABASE_LIFECYCLE_EXCLUSIVE_OWNER_PUBLICATION_ATTEMPTS = 3;
// Retries absorb brief leaf-path mutation races; every uncertain
// SQLite handle is closed before retry, and the fixed bound fails closed.
export const DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS = 8;
export const PARANOID_SCRYPT_N = 131_072;
export const PARANOID_SCRYPT_R = 8;
export const PARANOID_SCRYPT_P = 1;
export const PARANOID_SCRYPT_OUTPUT_BYTES = 32;
export const PARANOID_SCRYPT_SALT_BYTES = 16;
export const PARANOID_SCRYPT_MAXMEM_BYTES = 192 * 1024 * 1024;
export const PARANOID_HMAC_BYTES = 32;
export const PARANOID_STATE_FILE_NAME = 'paranoid.json';
export const DATABASE_MIGRATION_COPY_SPACE_NUMERATOR = 21;
export const DATABASE_MIGRATION_COPY_SPACE_DENOMINATOR = 10;
export const DATABASE_MIGRATION_HASH_CHUNK_BYTES = 1024 * 1024;
export const DATABASE_MIGRATION_QUIESCE_POLL_MS = 25;
export const DATABASE_MIGRATION_QUIESCE_TIMEOUT_MS = 5_000;
export const CLI_PROGRESS_FRAME_DELAY_MS = 80;
export const LEGACY_MCP_INSPECTION_TIMEOUT_MS = 2_000;
export const LEGACY_MCP_INSPECTION_MAX_BYTES = 1024 * 1024;
export const LEGACY_MCP_PROCESS_METADATA_MAX_BYTES = 64 * 1024;
export const LEGACY_MCP_SCAN_MAX_ENTRIES = 8192;
export const LEGACY_MCP_RETIRE_TIMEOUT_MS = 5_000;
export const LEGACY_MCP_RETIRE_POLL_MS = 25;
export const DATABASE_EXPORT_VERIFY_CHUNK_BYTES = 1024 * 1024;
// Restore/import metadata caps leave at least 8x row and 100x text headroom over the canonical schema.
export const DATABASE_SCHEMA_METADATA_MAX_ROWS = 256;
export const DATABASE_SCHEMA_METADATA_MAX_CHARS = 1024 * 1024;
export const MAX_TITLE_CHARS = 72;
export const TRAILING_FILES_CAP = 50;
export const SEGMENT_UNCONDITIONAL_GAP_HOURS = 7 * 24;
export const SEGMENT_MIN_GAP_HOURS = 4;
export const SEGMENT_FILE_OVERLAP_THRESHOLD = 0.2;
export const SEGMENT_FILE_CONTINUITY_THRESHOLD = 0.5;

// Daemon lifecycle and diagnostics
export const IDLE_CLOSE_MS = 30 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 3;
export const DAEMON_MISSING_PACKAGE_CHECK_LIMIT = 3;
export const DAEMON_PACKAGE_REPLACED_EXIT_CODE = 75;
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Runs off the ingestion hot path in its own worker thread, so a tighter cadence
// than the idle sweep is fine here. Only one pass runs at a time.
export const EMBEDDING_REFRESH_INTERVAL_MS = 60 * 1000;
export const FIRST_PROMPT_SEARCH_BACKFILL_BATCH_SIZE = 25;
export const UPDATE_CHECK_LOOP_INTERVAL_MS = 5 * 60 * 1000;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const NPM_REGISTRY_LOOKUP_TIMEOUT_MS = 10_000;
export const NPM_INSTALL_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_DEBOUNCE_MS = 800;
// Debounces synthesis spend for a failed Codex attempt. It is never evidence
// that the conversational turn is final; canonical ingestion keeps reparsing
// from its pre-turn cursor until a real closing boundary arrives.
export const OPEN_TURN_SUMMARY_GRACE_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_CONCURRENT = 3;
export const FAILURE_WINDOW_SIZE = 20;
export const FAILURE_RATE_THRESHOLD = 0.3;
export const FAILURE_WINDOW_MIN_SAMPLES = 5;
export const READABILITY_READ_CHUNK_BYTES = 16 * 1024;
export const READABILITY_FIRST_LINE_CAP_BYTES = 1024 * 1024;
export const MAX_UNKNOWN_LINE_DISCRIMINATOR_CHARS = 80;
export const MAX_DAEMON_UNKNOWN_LINE_WARNINGS = 1024;
export const DAEMON_LOG_ROTATE_MAX_BYTES = 5 * 1024 * 1024;
export const DAEMON_HEALTH_CHECK_DEADLINE_MS = 60_000;
export const DAEMON_HEALTH_CHECK_POLL_MS = 250;
export const CAPTURE_PAUSE_DEADLINE_MS = HEARTBEAT_STALE_MS * 2;
export const CAPTURE_PAUSE_POLL_MS = DAEMON_HEALTH_CHECK_POLL_MS;
export const DAEMON_BOOTOUT_DEADLINE_MS = 20_000;
export const DAEMON_STATE_CHECK_ATTEMPTS = 10;
export const DAEMON_OUTPUT_MAX_CHARS = 512;
export const DAEMON_STDERR_TAIL_CHARS = 2048;

// Hooks
export const HOOK_WATCHDOG_TIMEOUT_MS = 2_000;
export const HOOK_PAYLOAD_MAX_CHARS = 64 * 1024;
export const HOOK_LOG_LINE_MAX_CHARS = 500;
export const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const INSTALLED_HOOK_TIMEOUT_SECONDS = 5;
export const OPENCODE_PLUGIN_OUTPUT_MAX_BYTES = 1024 * 1024;

// Synthesis
export const SUMMARIZER_LOG_RETENTION_DAYS = 30;
export const MAX_SUMMARIZATION_FIELD_CHARS = 4_000;
export const MAX_ROLLUP_BATCH_CHARS = 8_000;
export const MAX_ROLLUP_CARRY_CHARS = 4_000;
export const TURN_SUMMARIZATION_MAX_TOKENS = 1_024;
export const TURN_SUMMARIZATION_RETRY_MAX_TOKENS = 4_096;
export const ROLLUP_MAX_TOKENS = 4_096;
export const ROLLUP_RETRY_MAX_TOKENS = 8_192;
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
export const ANTHROPIC_INPUT_USD_PER_TOKEN = 1 / 1_000_000;
export const ANTHROPIC_OUTPUT_USD_PER_TOKEN = 5 / 1_000_000;
export const DECISION_PROVENANCE_OVERLAP_THRESHOLD = 0.5;

// Transcript and project capture policy
export const FINGERPRINT_WINDOW_BYTES = 4096;
export const MAX_TRANSCRIPT_RECORD_BYTES = 64 * 1024 * 1024;
export const CLAUDE_COMPACT_SUMMARY_TAIL_SCAN_MAX_BYTES = 4 * 1024 * 1024;
export const CLAUDE_COMPACT_SUMMARY_MAX_BYTES = 64 * 1024;
export const MAX_METADATA_SCAN_BYTES = 4 * 1024 * 1024;
export const CODEX_WORKTREE_METADATA_MAX_BYTES = 4 * 1024;
export const MAX_METADATA_SCAN_LINES = 2_048;
// Revision of historical guardian exclusion, not full reclassification.
// Repair consumes a bounded preamble, never turns.
export const SESSION_KIND_REVISION = 1;
export const SESSION_KIND_RECONCILIATION_BATCH_SIZE = 25;
export const SESSION_KIND_RECONCILIATION_BUDGET_MS = 5_000;
export const SESSION_KIND_PREAMBLE_MAX_BYTES = 1024 * 1024;
export const MAX_JSON_VALUE_DEPTH = 64;
export const MAX_JSON_VALUE_NODES = 100_000;
export const REFUSED_HOME_PROJECT_ROOTS = ['', 'Documents', 'Desktop', 'Downloads'] as const;
export const REFUSED_ABSOLUTE_PROJECT_ROOTS = ['/', '/tmp', '/var', '/etc', '/usr'] as const;
export const TEMPORARY_PROJECT_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/run/user', '/dev/shm'] as const;

// Installation and filesystem privacy
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_UMASK_MASK = 0o077;
export const MINIMUM_NODE_VERSION = '22.15.0';
export const DEFAULT_ELEPHA_SERVICE_LABEL = 'com.elepha.daemon';
export const PLIST_THROTTLE_INTERVAL_SECONDS = 30;
export const PLIST_UMASK = 63;
export const PLIST_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const SYSTEMD_SERVICE_NAME = 'elepha.service';
export const SYSTEMD_RESTART_SECONDS = 30;
export const SYSTEMD_UMASK = '0077';

// Manual embedding jobs keep one source and one model input resident at a time.
export const EMBEDDING_SESSION_PAGE_SIZE = 100;
// Offline turn-vector passes bound both source reads and local inference work.
export const TURN_EMBEDDING_PAGE_SIZE = 16;
export const TURN_EMBEDDING_PASS_MAX_ROWS = 32;
export const TURN_EMBEDDING_RECENT_PASS_ROWS = 8;
// Keep the newest interaction text; provider input remains small even when a
// filtered source turn reaches the directed-read byte ceiling.
export const TURN_EMBEDDING_MAX_TEXT_CHARS = 4_000;
// Leave room for the fixed tool and project parameters under SQLite's variable limit.
export const SESSION_ELIGIBILITY_BATCH_SIZE = 500;
// Retrieval was evaluated by presence among the five nearest sessions.
export const SEMANTIC_RECALL_MAX_HITS = 5;
// Bound synchronous cache traversal, including stale and out-of-scope rows.
export const SEMANTIC_SCAN_MAX_ROWS = 1_000;
// Check between rows because a blocked event loop cannot run the hook watchdog.
export const SEMANTIC_SCAN_BUDGET_MS = 100;
// Interactive retrieval has no cosine floor. Correct multilingual paraphrase
// hits measured 0.79 to 0.88 against real rollups, so 0.95 admitted none of them.
// Similarity ranks reliably but is not calibrated confidence; noise is bounded
// by the per-chat cap rather than by this number.
export const AUTOMATIC_RECALL_MIN_SIMILARITY = 0.8;
// Cap what cannot be calibrated: a chat receives at most this many automatic
// candidates in total, and explicit recall stays available afterwards.
export const AUTOMATIC_RECALL_MAX_PER_CHAT = 3;
// Match today's semantic shortlist while keeping hook work bounded if retrieval grows.
export const AUTOMATIC_RECALL_MAX_CANDIDATES = 5;
export const AUTOMATIC_RECALL_MAX_PROMPT_CHARS = 4_000;
// A complete production payload measured 2,854 characters and needed a
// 2,855-character cap because selection reserves one character. A 3,000
// cap provides bounded headroom without truncating structural finals.
export const AUTOMATIC_RECALL_MAX_CONTEXT_CHARS = 3_000;
// Query-aware expansion shares the automatic evidence source selection.
export const SESSION_EVIDENCE_MAX_CONTEXT_CHARS = 4_000;
export const SESSION_EVIDENCE_MAX_QUERY_CHARS = 4_000;
export const SESSION_EVIDENCE_EXCERPT_CHARS = 800;
// A directed first-interaction read stops once found, or at this byte ceiling.
export const SESSION_EVIDENCE_SOURCE_MAX_BYTES = 4 * 1024 * 1024;
export const CURRENT_CHAT_EVIDENCE_MAX_CHARS = 3_000;
export const CURRENT_CHAT_EVIDENCE_MAX_TURNS = 3;
export const CURRENT_CHAT_EVIDENCE_MAX_CANDIDATES = 12;
export const CURRENT_CHAT_EVIDENCE_SEGMENT_PAGE = 16;
export const CURRENT_CHAT_EVIDENCE_MAX_SEGMENT_READS = 16;
export const CURRENT_CHAT_EVIDENCE_MAX_QUERY_CHARS = 4_000;
export const CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES = 1_024;
export const CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES = 4_096;
export const CURRENT_CHAT_EVIDENCE_DEADLINE_MS = 1_200;
export const CURRENT_CHAT_EVIDENCE_MAX_METADATA_PAGES = 4;
export const CURRENT_CHAT_SEMANTIC_MAX_VECTOR_ROWS = 128;
export const CURRENT_CHAT_SEMANTIC_MAX_VECTOR_BYTES = 256 * 1024;
export const CURRENT_CHAT_SEMANTIC_DEADLINE_MS = 5_000;
export const CURRENT_CHAT_OPENCODE_MAX_SOURCE_ROWS = 2_048;
// Retry a bounded number of open V2 sessions per SQLite event; unchanged tails
// are probed by their indexed last row and do not trigger another scan.
export const OPENCODE_V2_PENDING_SCAN_LIMIT = 32;
// Same-ID V1/V2 sessions are revisited by id keyset, independent of the V2
// time watermark; one page per SQLite event keeps each scan bounded.
export const OPENCODE_V2_OVERLAP_PAGE_SIZE = 32;
// Provider message ids are short opaque keys; a longer boundary id is treated
// as malformed rather than hydrated into a cursor.
export const OPENCODE_V2_HANDOFF_MAX_ID_BYTES = 256;
export const CURRENT_CHAT_OPENCODE_MAX_MESSAGE_ROWS = 512;
export const CURRENT_CHAT_OPENCODE_MAX_INDEX_ROWS = 8_192;
// Capsules use stored metadata only. The row ceiling applies before hydration;
// the smaller response ceiling includes provenance, framing and omission notices.
export const SESSION_CAPSULE_METADATA_MAX_BYTES = 65_536;
// Authorization must not bypass the capsule's pre-hydration bound through project metadata.
export const PROJECT_AUTHORIZATION_ROW_MAX_BYTES = 65_536;
export const SESSION_CAPSULE_MAX_CONTEXT_CHARS = 8_000;
export const SESSION_CAPSULE_SUMMARY_CHARS = 2_000;
export const SESSION_CAPSULE_DECISIONS_CHARS = 2_000;
export const SESSION_CAPSULE_PENDING_CHARS = 2_000;
export const SESSION_CAPSULE_FILES_CHARS = 1_000;
export const SESSION_CAPSULE_MAX_DECISIONS = 3;
export const SESSION_CAPSULE_MAX_FILES = 5;
export const EMBEDDING_LOCAL_MAX_TOKENS = 512;
export const EMBEDDING_CHUNK_CHARACTERS = 1000;
export const EMBEDDING_API_TIMEOUT_MS = 30_000;
export const EMBEDDING_API_RESPONSE_BYTES = 128 * 1024;
export const EMBEDDING_LOCAL_DIMENSIONS = 384;
export const EMBEDDING_API_DIMENSIONS = 1536;
// Check in SQLite before transferring a BLOB; a row limit alone cannot bound a
// malformed vector. Both supported models fit this float32 payload ceiling.
export const SEMANTIC_SCAN_MAX_VECTOR_BYTES = Math.max(EMBEDDING_LOCAL_DIMENSIONS, EMBEDDING_API_DIMENSIONS) * 4;

// Keep optional runtime upgrades within the supported Transformers major.
export const MEMORY_PLUS_TRANSFORMERS_MIN_VERSION = '4.2.0';
