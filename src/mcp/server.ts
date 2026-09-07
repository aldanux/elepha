// MCP read surface for raw filtered work episodes. It deliberately opens the
// local database read-only: this process has no
// permitted write path.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type Database from 'better-sqlite3-multiple-ciphers';
import { PACKAGE_VERSION } from '../config/constants.js';
import { SERVER_INSTRUCTIONS } from '../serving/instructions.js';
import type { DatabaseEncryptionRuntime } from '../storage/database-encryption.js';
import { defaultDbPath, openManagedDatabase } from '../storage/db.js';
import { ElephaMcpService, type McpToolHandlers, mcpToolDefinitions } from './tools.js';

export { SERVER_INSTRUCTIONS } from '../serving/instructions.js';
export { ElephaMcpService };

export interface McpToolResult {
    [key: string]: unknown;
    content: [{ type: 'text'; text: string }];
    structuredContent?: Record<string, unknown>;
}

export interface McpResponseShaper {
    result(text: string, structuredContent: Record<string, unknown>): McpToolResult;
    textResult(text: string): McpToolResult;
}

interface SchemaReadiness {
    ready: boolean;
    missingTables: string[];
}

const REQUIRED_TABLES = ['projects', 'sessions', 'memories', 'session_rollups', 'consent_roots'] as const;

function result(text: string, structuredContent: Record<string, unknown>): McpToolResult {
    return { content: [{ type: 'text', text }], structuredContent };
}

function textResult(text: string): McpToolResult {
    return { content: [{ type: 'text', text }] };
}

export const mcpResponseShaper: McpResponseShaper = { result, textResult };

// The MCP process is a read client. It checks the daemon-owned schema but
// never invokes openDb(): openDb() hardens files, migrates, and grandfathers
// consent roots, so all writes remain daemon-owned.
function schemaReadiness(db: Pick<Database.Database, 'prepare'>): SchemaReadiness {
    const names = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const missingTables = REQUIRED_TABLES.filter((table) => !names.has(table));
    return { ready: missingTables.length === 0, missingTables };
}

function schemaRefusal(readiness: SchemaReadiness): McpToolResult {
    const detail =
        readiness.missingTables.length === 0
            ? 'the database schema is unrecognized'
            : `missing table(s): ${readiness.missingTables.join(', ')}`;
    return {
        ...result(`elepha cannot serve this database: ${detail}. Start the elepha daemon to apply local schema updates, then retry.`, {
            empty: true,
            reason: 'schema_unrecognized',
            missing_tables: readiness.missingTables,
        }),
        isError: true,
    };
}

export function createMcpServer(service: McpToolHandlers): McpServer {
    const server = new McpServer({ name: 'elepha', version: PACKAGE_VERSION }, { instructions: SERVER_INSTRUCTIONS });
    registerTools(server, mcpToolDefinitions(service));
    return server;
}

// Builds either the normal read surface or the same four-tool surface whose
// calls refuse with a named schema reason. The check itself is read-only.
export function createMcpServerForDatabase(db: Database.Database): McpServer {
    const readiness = schemaReadiness(db);
    if (readiness.ready) {
        return createMcpServer(new ElephaMcpService(db, mcpResponseShaper));
    }

    const server = new McpServer({ name: 'elepha', version: PACKAGE_VERSION }, { instructions: SERVER_INSTRUCTIONS });
    registerTools(
        server,
        mcpToolDefinitions({
            listProjects: () => schemaRefusal(readiness),
            listSessions: () => schemaRefusal(readiness),
            getSession: async () => schemaRefusal(readiness),
            recall: async () => schemaRefusal(readiness),
        }),
    );
    return server;
}

function registerTools(server: McpServer, tools: ReturnType<typeof mcpToolDefinitions>): void {
    server.registerTool(tools.listProjects.name, tools.listProjects.configuration, tools.listProjects.handler);
    server.registerTool(tools.listSessions.name, tools.listSessions.configuration, tools.listSessions.handler);
    server.registerTool(tools.getSession.name, tools.getSession.configuration, tools.getSession.handler);
    server.registerTool(tools.recall.name, tools.recall.configuration, tools.recall.handler);
}

function requestScopedHandlers(dbPath: string): McpToolHandlers {
    const invoke = async (operation: (service: ElephaMcpService) => McpToolResult | Promise<McpToolResult>) => {
        const db = await openMcpReadOnlyDatabase(dbPath);
        try {
            const readiness = schemaReadiness(db);
            if (!readiness.ready) {
                return schemaRefusal(readiness);
            }
            return await operation(new ElephaMcpService(db, mcpResponseShaper));
        } finally {
            db.close();
        }
    };

    return {
        listProjects: () => invoke((service) => service.listProjects()),
        listSessions: (input) => invoke((service) => service.listSessions(input)),
        getSession: (input) => invoke((service) => service.getSession(input)),
        recall: (input) => invoke((service) => service.recall(input)),
    };
}

// Starts the only network-facing transport. stdout remains reserved for JSON-RPC.
export async function serveMcp(dbPath: string = defaultDbPath()): Promise<void> {
    // Coding clients keep their stdio MCP process alive for the whole chat.
    // Scope SQLite ownership to one tool call so an idle client cannot block
    // database migration, replacement, or restore.
    const server = createMcpServer(requestScopedHandlers(dbPath));
    await server.connect(new StdioServerTransport());
}

// Read-only connection seam used by the stdio server and its write-proof test.
export function openMcpReadOnlyDatabase(
    dbPath: string = defaultDbPath(),
    encryption?: DatabaseEncryptionRuntime,
): Promise<Database.Database> {
    return openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption });
}
