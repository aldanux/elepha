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
export { PACKAGE_VERSION } from './version.js';
export const BACKUP_KEEP = 5;
export const USER_BACKUPS_DIR_NAME = 'backups';
export const CHARS_PER_TOKEN = 4;
export const SESSION_TOKEN_BUDGET = 20_000;
export const SESSION_CHAR_BUDGET = SESSION_TOKEN_BUDGET * CHARS_PER_TOKEN;
export const DURABLE_CAPTURE_FILTER_VERSION = 1;
export const DURABLE_CAPTURE_STATES = [
    'complete',
    'complete_truncated',
    'disabled_gap',
    'backfilling',
    'source_unavailable',
    'parse_error',
    'revoked',
    'incognito',
] as const;
export type DurableCaptureState = (typeof DURABLE_CAPTURE_STATES)[number];
export const MAX_GET_SESSION_LAST_N = 500;
export const GET_SESSION_DEADLINE_MS = 5_000;
export const AUTO_BRIEF_TOKEN_BUDGET = 4_000;
export const AUTO_BRIEF_CHAR_BUDGET = AUTO_BRIEF_TOKEN_BUDGET * CHARS_PER_TOKEN;
export const AUTO_BRIEF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTO_BRIEF_NOTIFY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTO_BRIEF_MAX_COMMITS_BEHIND = 20;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTO_BRIEF_AGGREGATE_SESSION_LIMIT = 10;
export const AUTO_BRIEF_AGGREGATE_FILE_LIMIT = 3;
export const MCP_LIST_SESSIONS_DEFAULT_LIMIT = 20;
export const ELEPHA_LIST_DEFAULT_LIMIT = 5;
export const ELEPHA_LIST_MAX_LIMIT = 100;
export const REMEMBER_SESSION_RECENCY_CAP = { global: 5_000, here: 5_000 } as const;
export const REMEMBER_SCAN_BUDGET_MS = 3_000;
export const REMEMBER_MAX_HITS = 5;
export const REMEMBER_DISTINCTIVE_TOKEN_FRACTION = 0.005;
export const REMEMBER_QUERY_FILLER_WORDS = ['a', 'about', 'an', 'and', 'for', 'me', 'of', 'please', 'the', 'to'] as const;
export const FIRST_PROMPT_SEARCH_CAP = 4_000;
export const REMEMBER_MATCH_SCORES = {
    title: 12_000,
    exactPhrase: 10_000,
    rollup: 6_000,
    body: 3_000,
} as const;

// Storage and session segmentation
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
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const FIRST_PROMPT_SEARCH_BACKFILL_BATCH_SIZE = 25;
export const UPDATE_CHECK_LOOP_INTERVAL_MS = 5 * 60 * 1000;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_IDLE_DEBOUNCE_MS = 800;
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
export const MAX_METADATA_SCAN_BYTES = 4 * 1024 * 1024;
export const MAX_METADATA_SCAN_LINES = 2_048;
export const MAX_JSON_VALUE_DEPTH = 64;
export const MAX_JSON_VALUE_NODES = 100_000;
export const REFUSED_HOME_PROJECT_ROOTS = ['', 'Documents', 'Desktop', 'Downloads'] as const;
export const REFUSED_ABSOLUTE_PROJECT_ROOTS = ['/', '/tmp', '/var', '/etc', '/usr'] as const;
export const TEMPORARY_PROJECT_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/run/user', '/dev/shm'] as const;

// Installation and filesystem privacy
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_UMASK_MASK = 0o077;
export const MINIMUM_NODE_MAJOR = 22;
export const DEFAULT_ELEPHA_SERVICE_LABEL = 'com.elepha.daemon';
export const PLIST_THROTTLE_INTERVAL_SECONDS = 30;
export const PLIST_UMASK = 63;
export const PLIST_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const SYSTEMD_SERVICE_NAME = 'elepha.service';
export const SYSTEMD_RESTART_SECONDS = 30;
export const SYSTEMD_UMASK = '0077';
