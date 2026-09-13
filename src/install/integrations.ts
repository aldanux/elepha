import { lstatSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { claudeMcpPath, codexConfigPath, opencodeConfigPath, opencodePluginPath } from '../config/paths.js';
import {
    hasClaudeMcp,
    hasCodexMcp,
    hasOpencodeMcp,
    ownsCodexMcp,
    transformClaudeMcp,
    transformCodexMcp,
    transformOpencodeMcp,
} from '../mcp/installer.js';
import { applyConfigTransaction, type ConfigChange, type ConfigOriginal } from './config-file.js';
import { opencodePluginStatus, transformOpencodePlugin } from './opencode-plugin.js';

export interface IntegrationPaths {
    claudeMcp: string;
    codexConfig: string;
    opencodeConfig: string;
}

export interface IntegrationSources {
    claudeMcp?: string;
    codexConfig?: string;
    opencodeConfig?: string;
    opencodePlugin?: string;
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
    return { claudeMcp: claudeMcpPath(), codexConfig: codexConfigPath(), opencodeConfig: opencodeConfigPath() };
}

// Installation and refresh share rendering and validation. Refresh only admits
// existing owned entries; presence of a provider config is not installation consent.
export function planIntegrations(
    paths: IntegrationPaths,
    sources: IntegrationSources,
    launcher: string,
    mode: 'install' | 'refresh',
    selected = { claude: true, codex: true, opencode: true },
): { changes: ConfigChange[]; skipped: IntegrationNotice[] } {
    const pluginPath = opencodePluginPath(paths.opencodeConfig);
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
    ];
    const changes: ConfigChange[] = [];
    const skipped: IntegrationNotice[] = [];
    for (const entry of entries) {
        if (!entry.selected) {
            continue;
        }
        if (mode === 'refresh') {
            if (entry.source === undefined) {
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
        claudeMcp: read(paths.claudeMcp, 'Claude MCP'),
        codexConfig: read(paths.codexConfig, 'Codex MCP'),
        opencodeConfig: read(paths.opencodeConfig, 'OpenCode MCP'),
        opencodePlugin: read(opencodePluginPath(paths.opencodeConfig), 'OpenCode plugin'),
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
        refresh.originals.map((original) => ({
            kind: 'write',
            file: original.file,
            text: original.text,
            validate: () => {},
        })),
    );
}
