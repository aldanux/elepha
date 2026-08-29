import type { Command } from 'commander';
import { serveMcp } from '../../mcp/server.js';

export function registerMcp(program: Command): void {
    program
        .command('mcp', { hidden: true })
        .description('Run elepha as a local MCP server')
        .command('serve')
        .description('Serve read-only historical sessions over stdio')
        .action(async () => {
            await serveMcp();
        });
}
