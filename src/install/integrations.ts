import { lstatSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import {
    claudeMcpPath,
    codexConfigPath,
    dshCordisPatchPath,
    kimiConfigTomlPath,
    kimiMcpPath,
    opencodeConfigPath,
    opencodePluginPath,
} from '../config/paths.js';
import {
    hasClaudeMcp,
    hasCodexMcp,
    hasDeepSeekMcp,
    hasKimiMcp,
    hasOpencodeMcp,
    ownsCodexMcp,
    transformClaudeMcp,
    transformCodexMcp,
    transformDeepSeekMcp,
    transformKimiMcp,
    transformOpencodeMcp,
} from '../mcp/installer.js';
import { applyConfigTransaction, type ConfigChange, type ConfigOriginal } from './config-file.js';
import {
    deepSeekCommandsStatus,
    deepSeekHooksPatchStatus,
    deepSeekHooksPath,
    ownsDeepSeekHooks,
    readDeepSeekHooks,
    renderDeepSeekHooks,
    transformDeepSeekHooksPatch,
} from './deepseek-hooks.js';
import { kimiHookStatus, transformKimiHook } from './kimi-hook.js';
import { opencodePluginStatus, transformOpencodePlugin } from './opencode-plugin.js';

export interface IntegrationPaths {
    claudeMcp: string;
    codexConfig: string;
    deepseekMcp: string;
    opencodeConfig: string;
    kimiMcp: string;
}

export interface IntegrationSources {
    claudeMcp?: string;
    codexConfig?: string;
    deepseekMcp?: string;
    opencodeConfig?: string;
    kimiMcp?: string;
    kimiConfig?: string;
    opencodePlugin?: string;
    deepseekHooks?: string;
}

export interface IntegrationNotice {
    integration: string;
    file: string;
    status: 'conflict' | 'invalid';
}

export interface IntegrationRefresh {
    refreshed: string[];
    skipped: IntegrationNotice[];
    originals: ConfigOriginal[];
    installed: Array<{ file: string; text: string }>;
}

export function integrationPaths(): IntegrationPaths {
    return {
        claudeMcp: claudeMcpPath(),
        codexConfig: codexConfigPath(),
        deepseekMcp: dshCordisPatchPath(),
        opencodeConfig: opencodeConfigPath(),
        kimiMcp: kimiMcpPath(),
    };
}

// Installation and refresh share rendering and validation. Refresh only admits
// existing owned entries; presence of a provider config is not installation consent.
export function planIntegrations(
    paths: IntegrationPaths,
    sources: IntegrationSources,
    launcher: string,
    mode: 'install' | 'refresh',
    selected = { claude: true, codex: true, deepseek: true, opencode: true, kimi: true },
): { changes: ConfigChange[]; skipped: IntegrationNotice[] } {
    const pluginPath = opencodePluginPath(paths.opencodeConfig);
    const deepseekHooks = renderDeepSeekHooks(launcher);
    const deepseekHooksFile = deepSeekHooksPath(paths.deepseekMcp);
    const deepseekStatus = () => {
        const mcp = hasDeepSeekMcp(sources.deepseekMcp ?? '', launcher);
        const commands = deepSeekCommandsStatus(sources.deepseekMcp ?? '', paths.deepseekMcp, launcher, sources.deepseekHooks);
        return commands === 'not installed' && mcp !== 'not installed' && mcp !== 'invalid' && mcp !== 'conflict'
            ? 'stale bridge'
            : commands;
    };
    const deepseekPatchStatus = () => {
        const mcp = hasDeepSeekMcp(sources.deepseekMcp ?? '', launcher);
        const commands = deepseekStatus();
        if (commands === 'conflict') {
            return 'conflict';
        }
        if (mcp === 'conflict') {
            return 'conflict';
        }
        if (mcp === 'invalid' || commands === 'invalid') {
            return 'invalid';
        }
        if (mcp === 'not installed' && commands === 'not installed') {
            return 'not installed';
        }
        return mcp === 'registered' && commands === 'active' ? 'active' : 'stale bridge';
    };
    const entries = [
        {
            selected: selected.claude,
            integration: 'Claude MCP',
            file: paths.claudeMcp,
            source: sources.claudeMcp,
            status: () => hasClaudeMcp(sources.claudeMcp ?? '', launcher),
            render: (source: string | undefined) => transformClaudeMcp(source ?? '', launcher),
            validate: JSON.parse,
        },
        {
            selected: selected.codex,
            integration: 'Codex MCP',
            file: paths.codexConfig,
            source: sources.codexConfig,
            status: () => {
                const status = hasCodexMcp(sources.codexConfig ?? '', launcher);
                return status !== 'not installed' && status !== 'invalid' && !ownsCodexMcp(sources.codexConfig ?? '') ? 'conflict' : status;
            },
            render: (source: string | undefined) => transformCodexMcp(source ?? '', launcher),
            validate: parse,
        },
        {
            selected: selected.deepseek,
            integration: 'DeepSeek Harness MCP',
            file: paths.deepseekMcp,
            source: sources.deepseekMcp,
            status: deepseekPatchStatus,
            render: (source: string | undefined) =>
                transformDeepSeekHooksPatch(transformDeepSeekMcp(source ?? '', launcher), deepseekHooksFile),
            validate: (value: string) => {
                if (hasDeepSeekMcp(value, launcher) !== 'registered' || deepSeekHooksPatchStatus(value, deepseekHooksFile) !== 'active') {
                    throw new Error('DeepSeek Harness cordis.patch.yml failed read-back verification');
                }
            },
        },
        {
            selected: selected.deepseek,
            integration: 'DeepSeek Harness commands',
            file: deepseekHooksFile,
            source: sources.deepseekHooks,
            status: deepseekStatus,
            refreshWhenMissing: () => (deepseekStatus() === 'stale bridge' ? 'stale bridge' : 'not installed'),
            render: (source: string | undefined) => {
                if (source !== undefined && !ownsDeepSeekHooks(source)) {
                    throw new Error('DeepSeek Harness hooks.json is user-owned; refusing to overwrite it');
                }
                return deepseekHooks;
            },
            validate: (value: string) => {
                if (value !== deepseekHooks) {
                    throw new Error('DeepSeek Harness hooks.json failed read-back verification');
                }
            },
        },
        {
            selected: selected.opencode,
            integration: 'OpenCode MCP',
            file: paths.opencodeConfig,
            source: sources.opencodeConfig,
            status: () => hasOpencodeMcp(sources.opencodeConfig ?? '', launcher),
            // Refresh never adds a plugin registration the user has not installed.
            render: (source: string | undefined) =>
                transformOpencodeMcp(source ?? '', launcher, false, mode === 'install' ? pluginPath : undefined),
            validate: JSON.parse,
        },
        {
            selected: selected.opencode,
            integration: 'OpenCode plugin',
            file: pluginPath,
            source: sources.opencodePlugin,
            status: () => opencodePluginStatus(sources.opencodePlugin, launcher),
            render: (source: string | undefined) => transformOpencodePlugin(source, launcher),
            validate: (value: string) => {
                if (value !== transformOpencodePlugin(value, launcher)) {
                    throw new Error('OpenCode plugin failed read-back verification');
                }
            },
        },
        {
            selected: selected.kimi,
            integration: 'Kimi Code MCP',
            file: paths.kimiMcp,
            source: sources.kimiMcp,
            status: () => hasKimiMcp(sources.kimiMcp ?? '', launcher),
            render: (source: string | undefined) => transformKimiMcp(source ?? '', launcher),
            validate: JSON.parse,
        },
        {
            selected: selected.kimi,
            integration: 'Kimi Code hook',
            file: kimiConfigTomlPath(paths.kimiMcp),
            source: sources.kimiConfig,
            status: () => kimiHookStatus(sources.kimiConfig ?? '', launcher),
            render: (source: string | undefined) => transformKimiHook(source ?? '', launcher),
            validate: parse,
        },
    ];
    const changes: ConfigChange[] = [];
    const skipped: IntegrationNotice[] = [];
    for (const entry of entries) {
        if (!entry.selected) {
            continue;
        }
        if (mode === 'refresh') {
            if (
                entry.source === undefined &&
                !('refreshWhenMissing' in entry && entry.refreshWhenMissing !== undefined && entry.refreshWhenMissing() !== 'not installed')
            ) {
                continue;
            }
            const status = entry.status();
            if (status === 'not installed') {
                continue;
            }
            if (status === 'invalid' || status === 'conflict') {
                skipped.push({ integration: entry.integration, file: entry.file, status });
                continue;
            }
        }
        const rendered = entry.render(entry.source);
        if (mode === 'install' || rendered !== entry.source) {
            changes.push({ kind: 'write', file: entry.file, text: rendered, validate: entry.validate });
        }
    }
    return { changes, skipped };
}

export function reconcileOwnedIntegrations(launcher: string, paths: IntegrationPaths = integrationPaths()): IntegrationRefresh {
    const skipped: IntegrationNotice[] = [];
    const read = (file: string, integration: string): string | undefined => {
        const stat = lstatSync(file, { throwIfNoEntry: false });
        if (!stat) {
            return undefined;
        }
        if (!stat.isFile()) {
            skipped.push({ integration, file, status: 'conflict' });
            return undefined;
        }
        return readFileSync(file, 'utf8');
    };
    const sources = {
        deepseekMcp: read(paths.deepseekMcp, 'DeepSeek Harness MCP'),
        kimiMcp: read(paths.kimiMcp, 'Kimi Code MCP'),
        kimiConfig: read(kimiConfigTomlPath(paths.kimiMcp), 'Kimi Code hook'),
        claudeMcp: read(paths.claudeMcp, 'Claude MCP'),
        codexConfig: read(paths.codexConfig, 'Codex MCP'),
        opencodeConfig: read(paths.opencodeConfig, 'OpenCode MCP'),
        opencodePlugin: read(opencodePluginPath(paths.opencodeConfig), 'OpenCode plugin'),
        deepseekHooks: readDeepSeekHooks(paths.deepseekMcp),
    };
    const plan = planIntegrations(paths, sources, launcher, 'refresh');
    const transaction = applyConfigTransaction(plan.changes);
    return {
        refreshed: plan.changes.map((change) => change.file),
        skipped: [...skipped, ...plan.skipped],
        originals: transaction ? transaction.originals : [],
        installed: plan.changes.flatMap((change) => (change.kind === 'write' ? [{ file: change.file, text: change.text }] : [])),
    };
}

export function restoreRefreshedIntegrations(refresh: IntegrationRefresh): void {
    // A later service/migration failure restores exact pre-update bytes, including
    // stale renders. Refuse to overwrite any intervening user edit during awaited work.
    for (const installed of refresh.installed) {
        const stat = lstatSync(installed.file, { throwIfNoEntry: false });
        if (!stat?.isFile() || readFileSync(installed.file, 'utf8') !== installed.text) {
            throw new Error(`integration changed after refresh: ${installed.file}`);
        }
    }
    applyConfigTransaction(
        refresh.originals.map((original) =>
            original.exists
                ? {
                      kind: 'write' as const,
                      file: original.file,
                      text: original.text,
                      validate: () => {},
                  }
                : { kind: 'delete' as const, file: original.file },
        ),
    );
}
