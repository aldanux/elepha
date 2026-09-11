// Exact bytes owned by elepha's installed configuration and launcher formats.
export const LAUNCHER_MARKER = '# elepha-managed-launcher: v1';
export const OPENCODE_PLUGIN_MARKER = '// elepha-managed-opencode-plugin: v1';
export const KIMI_HOOK_MARKER = '// elepha-managed-kimi-hook: v1';
export const DEEPSEEK_HOOKS_FILE_MARKER = 'elepha-managed-deepseek-hooks: v1';

export const CODEX_SESSION_START_BEGIN = '# elepha-session-start: begin';
export const CODEX_SESSION_START_END = '# elepha-session-start: end';
export const CODEX_USER_PROMPT_SUBMIT_BEGIN = '# elepha-user-prompt-submit: begin';
export const CODEX_USER_PROMPT_SUBMIT_END = '# elepha-user-prompt-submit: end';
export const CODEX_MCP_START = '# elepha-mcp: begin';
export const CODEX_MCP_END = '# elepha-mcp: end';
export const DEEPSEEK_MCP_START = '# elepha-deepseek-mcp: begin';
export const DEEPSEEK_MCP_END = '# elepha-deepseek-mcp: end';
export const DEEPSEEK_HOOKS_START = '# elepha-deepseek-hooks: begin';
export const DEEPSEEK_HOOKS_END = '# elepha-deepseek-hooks: end';

export const CODEX_SESSION_START_TABLE = '[[hooks.SessionStart]]';
export const CODEX_SESSION_START_HOOK_TABLE = '[[hooks.SessionStart.hooks]]';
export const CODEX_USER_PROMPT_SUBMIT_TABLE = '[[hooks.UserPromptSubmit]]';
export const CODEX_USER_PROMPT_SUBMIT_HOOK_TABLE = '[[hooks.UserPromptSubmit.hooks]]';
export const CODEX_ADDITIONAL_CONTEXT_LIMIT = 'additionalContextLimit = 0';
