import { describe, expect, it } from 'vitest';
import { codexTrustHash, codexTrustStatus } from '../../src/hooks/codex-trust.js';
import {
    CODEX_ADDITIONAL_CONTEXT_LIMIT,
    CODEX_SESSION_START_HOOK_TABLE,
    CODEX_SESSION_START_TABLE,
    CODEX_USER_PROMPT_SUBMIT_HOOK_TABLE,
    CODEX_USER_PROMPT_SUBMIT_TABLE,
} from '../../src/install/markers.js';

const handler = {
    matcher: 'startup|clear|resume|compact',
    command: 'elepha hook session-start --tool codex',
    timeout: 5,
    statusMessage: 'Loading project memory',
    additionalContextLimit: 0,
};

describe('Codex 0.147.0 hook trust', () => {
    it('changes normalized identity for every material handler field', () => {
        const hash = codexTrustHash(handler);
        // Frozen from Codex 0.147.0's approved handler identity, not merely
        // a shape assertion that could agree with a wrong normalization.
        expect(hash).toBe('sha256:c3b3af1d9823ad954973cdbd63254219f9c8ca8e8661398bef0eb4f43e5765a0');
        expect(codexTrustHash({ ...handler, command: 'other' })).not.toBe(hash);
        expect(codexTrustHash({ ...handler, matcher: 'startup' })).not.toBe(hash);
        expect(codexTrustHash({ ...handler, timeout: 6 })).not.toBe(hash);
        expect(codexTrustHash({ ...handler, statusMessage: 'Other' })).not.toBe(hash);
        expect(codexTrustHash({ ...handler, additionalContextLimit: 1 })).not.toBe(hash);
    });

    it('reports awaiting approval, active, and invalidated independently', () => {
        const path = '/tmp/codex/config.toml';
        const base = `${CODEX_SESSION_START_TABLE}\nmatcher = "${handler.matcher}"\n${CODEX_SESSION_START_HOOK_TABLE}\ntype = "command"\ncommand = "${handler.command}"\ntimeout = 5\nstatusMessage = "${handler.statusMessage}"\n${CODEX_ADDITIONAL_CONTEXT_LIMIT}\n`;
        expect(codexTrustStatus(base, path)).toBe('awaiting approval');
        const key = `${path}:session_start:0:0`;
        expect(codexTrustStatus(`${base}\n[hooks.state."${key}"]\ntrusted_hash = "${codexTrustHash(handler)}"\n`, path)).toBe('active');
        expect(codexTrustStatus(`${base}\n[hooks.state."${key}"]\ntrusted_hash = "sha256:wrong"\n`, path)).toBe('hash invalidated');
    });

    it('uses the installed positional trust key after unrelated SessionStart handlers', () => {
        const path = '/tmp/codex/config.toml';
        const fixture = `${CODEX_SESSION_START_TABLE}
matcher = "other"
${CODEX_SESSION_START_HOOK_TABLE}
type = "command"
command = "other"

${CODEX_SESSION_START_TABLE}
matcher = "${handler.matcher}"
${CODEX_SESSION_START_HOOK_TABLE}
type = "command"
command = "${handler.command}"
timeout = 5
statusMessage = "${handler.statusMessage}"
${CODEX_ADDITIONAL_CONTEXT_LIMIT}
`;
        const key = `${path}:session_start:1:0`;
        expect(codexTrustStatus(`${fixture}\n[hooks.state."${key}"]\ntrusted_hash = "${codexTrustHash(handler)}"\n`, path)).toBe('active');
    });

    it('uses the defining project path while reading trust state from global TOML', () => {
        const definitionPath = '/repo/.codex/config.toml';
        const definition = `${CODEX_SESSION_START_TABLE}\nmatcher = "${handler.matcher}"\n${CODEX_SESSION_START_HOOK_TABLE}\ntype = "command"\ncommand = "${handler.command}"\ntimeout = 5\nstatusMessage = "${handler.statusMessage}"\n${CODEX_ADDITIONAL_CONTEXT_LIMIT}\n`;
        const key = `${definitionPath}:session_start:0:0`;
        const globalState = `[hooks.state."${key}"]\ntrusted_hash = "${codexTrustHash(handler)}"\n`;
        expect(codexTrustStatus(definition, definitionPath, globalState)).toBe('active');
    });

    it('hashes and reads the UserPromptSubmit event under its own positional trust namespace', () => {
        const path = '/tmp/codex/config.toml';
        const promptHandler = {
            command: 'elepha hook user-prompt-submit --tool codex',
            timeout: 5,
        };
        const definition = `${CODEX_USER_PROMPT_SUBMIT_TABLE}\n${CODEX_USER_PROMPT_SUBMIT_HOOK_TABLE}\ntype = "command"\ncommand = "${promptHandler.command}"\ntimeout = 5\n`;
        const hash = codexTrustHash(promptHandler, 'UserPromptSubmit');
        const key = `${path}:user_prompt_submit:0:0`;
        expect(codexTrustHash(promptHandler, 'SessionStart')).not.toBe(hash);
        expect(codexTrustStatus(definition, path, definition, promptHandler.command, 'UserPromptSubmit')).toBe('awaiting approval');
        expect(
            codexTrustStatus(
                `${definition}\n[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n`,
                path,
                undefined,
                promptHandler.command,
                'UserPromptSubmit',
            ),
        ).toBe('active');
    });
});
