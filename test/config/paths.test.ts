import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    claudeMcpPath,
    daemonHeartbeatPath,
    elephaHome,
    elephaPaths,
    isRefusedProjectRoot,
    isWithin,
    isWithinProviderStore,
    providerStoreRoot,
    samePath,
} from '../../src/config/paths.js';
import { defaultDbPath } from '../../src/storage/db.js';
import type { ToolName } from '../../src/types/index.js';

const savedEnvironment = { ...process.env };
const testScratchRoot = path.resolve(import.meta.dirname, '..', '..', '.test-scratch');
const temporaryDirectories: string[] = [];

afterEach(() => {
    process.env = { ...savedEnvironment };
    for (const directory of temporaryDirectories.splice(0)) {
        try {
            unlinkSync(path.join(directory, 'home-link'));
            rmSync(directory, { recursive: true, force: true });
        } catch {
            // Cleanup is a courtesy; sandbox permissions must not fail the assertion.
        }
    }
});

describe('isolated elepha paths', () => {
    it('moves elepha runtime state and the Claude MCP registry when explicitly overridden', () => {
        delete process.env.ELEPHA_HOME;
        delete process.env.ELEPHA_DB_PATH;
        delete process.env.ELEPHA_CLAUDE_MCP_PATH;

        const defaultHome = elephaHome();
        expect(defaultDbPath()).toBe(`${defaultHome}/elepha.db`);
        expect(claudeMcpPath()).not.toContain(`${defaultHome}/`);

        const explicit = elephaPaths('/Users/test');
        expect(explicit).toMatchObject({
            root: '/Users/test/.elepha',
            heartbeat: '/Users/test/.elepha/daemon.heartbeat.json',
            launchAgent: '/Users/test/Library/LaunchAgents/com.elepha.daemon.plist',
        });
        expect(explicit.launchAgent).not.toContain(`${explicit.root}/`);

        process.env.ELEPHA_HOME = '/tmp/elepha-gate7test/elepha';
        process.env.ELEPHA_DB_PATH = '/tmp/elepha-gate7test/elepha/elepha.db';
        process.env.ELEPHA_CLAUDE_MCP_PATH = '/tmp/elepha-gate7test/claude-mcp.json';

        expect(elephaHome()).toBe('/tmp/elepha-gate7test/elepha');
        expect(daemonHeartbeatPath()).toBe('/tmp/elepha-gate7test/elepha/daemon.heartbeat.json');
        expect(defaultDbPath()).toBe('/tmp/elepha-gate7test/elepha/elepha.db');
        expect(claudeMcpPath()).toBe('/tmp/elepha-gate7test/claude-mcp.json');
    });
});

describe('path comparison case handling', () => {
    it('folds case on macOS', () => {
        expect(samePath('/Users/test/Project', '/users/test/project', 'darwin')).toBe(true);
        expect(isWithin('/Users/test/Project', '/users/test/project/src', 'darwin')).toBe(true);
    });

    it('folds case on Windows', () => {
        expect(samePath('/Users/test/Project', '/users/test/project', 'win32')).toBe(true);
        expect(isWithin('/Users/test/Project', '/users/test/project/src', 'win32')).toBe(true);
    });

    it('preserves case on Linux', () => {
        expect(samePath('/Users/test/Project', '/users/test/project', 'linux')).toBe(false);
        expect(isWithin('/Users/test/Project', '/users/test/project/src', 'linux')).toBe(false);
    });
});

describe('refused project roots', () => {
    it('refuses lexical aliases to the home directory without refusing projects beneath it', () => {
        mkdirSync(testScratchRoot, { recursive: true });
        const fixture = mkdtempSync(path.join(testScratchRoot, 'refused-home-alias-'));
        temporaryDirectories.push(fixture);
        const alias = path.join(fixture, 'home-link');
        symlinkSync(homedir(), alias);

        expect(isRefusedProjectRoot(alias)).toBe(true);
        expect(isRefusedProjectRoot(path.join(homedir(), 'Sites', 'real-project'))).toBe(false);
        expect(isRefusedProjectRoot(path.join(homedir(), 'Documents', 'real-project'))).toBe(false);
    });

    it('refuses macOS and Linux temporary trees', () => {
        expect(isRefusedProjectRoot('/private/var/folders/zz/transient-checkout')).toBe(true);
        expect(isRefusedProjectRoot('/run/user/1000/transient-checkout')).toBe(true);
        expect(isRefusedProjectRoot('/dev/shm/transient-checkout')).toBe(true);
    });

    it('refuses WSL Windows homes and dump roots without refusing projects beneath them', () => {
        expect(isRefusedProjectRoot('/mnt/c/Users/dani')).toBe(true);
        expect(isRefusedProjectRoot('/mnt/c/Users/dani/Documents')).toBe(true);
        expect(isRefusedProjectRoot('/mnt/c/Users/dani/Desktop')).toBe(true);
        expect(isRefusedProjectRoot('/mnt/c/Users/dani/Downloads')).toBe(true);
        expect(isRefusedProjectRoot('/mnt/c/Users/dani/project')).toBe(false);
        expect(isRefusedProjectRoot('/mnt/c/Users/dani/Documents/project')).toBe(false);
    });
});

describe('provider transcript stores', () => {
    it('keeps tool config homes out of project roots without blocking provider transcript reads', () => {
        process.env.CLAUDE_CONFIG_DIR = '/Users/test/.claude-custom';
        process.env.CODEX_HOME = '/Users/test/.codex-custom';

        expect(providerStoreRoot('claude-code')).toBe('/Users/test/.claude-custom/projects');
        expect(providerStoreRoot('codex')).toBe('/Users/test/.codex-custom/sessions');
        expect(isRefusedProjectRoot('/Users/test/.claude-custom/memories')).toBe(true);
        expect(isRefusedProjectRoot('/Users/test/.codex-custom/memories')).toBe(true);
        expect(isWithinProviderStore('codex', '/Users/test/.codex-custom/sessions/rollout.jsonl')).toBe(true);
        expect(isWithinProviderStore('codex', '/tmp/evil.jsonl')).toBe(false);
        expect(isWithinProviderStore('future-tool' as ToolName, '/Users/test/.codex-custom/sessions/rollout.jsonl')).toBe(false);
    });
});
