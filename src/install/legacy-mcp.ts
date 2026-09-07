import { createHash } from 'node:crypto';
import { closeSync, opendirSync, openSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
    LEGACY_MCP_INSPECTION_MAX_BYTES,
    LEGACY_MCP_PROCESS_METADATA_MAX_BYTES,
    LEGACY_MCP_RETIRE_POLL_MS,
    LEGACY_MCP_RETIRE_TIMEOUT_MS,
    LEGACY_MCP_SCAN_MAX_ENTRIES,
} from '../config/constants.js';
import { macosDatabaseOpenFiles, macosProcessCommand, macosProcessOpenFiles } from '../security/subprocess-allowlist.js';
import { errorMessage } from '../util/error.js';
import type { ResolvedElephaBin } from './binary.js';

export interface LegacyMcpProcess {
    pid: number;
    uid: number;
    startedAt: string;
    command: string | string[];
    executable: string;
    readOnly: boolean;
    mappedFiles: string[];
}

export interface LegacyMcpProbe {
    list(): number[];
    inspect(pid: number): LegacyMcpProcess | undefined;
}

interface DatabaseIdentity {
    dev: bigint;
    ino: bigint;
}

export interface LegacyMcpRuntime {
    platform?: NodeJS.Platform;
    uid?: number;
    pid?: number;
    probe?: LegacyMcpProbe;
    signal?: (pid: number, signal: 'SIGTERM') => void;
}

// npm's retire-path uses this path hash. Match the exact sibling belonging
// to the installed package, never a process-name or directory-prefix guess.
export function retiredNpmPackageRoot(packageRoot: string): string {
    const hash = createHash('sha1')
        .update(packageRoot)
        .digest('base64')
        .replace(/[^a-zA-Z0-9]+/g, '')
        .slice(0, 8);
    return path.join(path.dirname(packageRoot), `.${path.basename(packageRoot)}-${hash}`);
}

function disappeared(error: unknown): boolean {
    return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function processDescriptorsClosing(error: unknown): boolean {
    return ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function sameDatabase(first: DatabaseIdentity, second: DatabaseIdentity): boolean {
    return first.dev === second.dev && first.ino === second.ino;
}

function directoryNames(directory: string): string[] {
    const handle = opendirSync(directory);
    const names: string[] = [];
    try {
        for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
            if (names.length === LEGACY_MCP_SCAN_MAX_ENTRIES) {
                throw new Error(`Legacy MCP process inspection exceeded its directory limit: ${directory}`);
            }
            names.push(entry.name);
        }
    } finally {
        handle.closeSync();
    }
    return names;
}

function readProcFile(file: string, maxBytes: number = LEGACY_MCP_PROCESS_METADATA_MAX_BYTES): string {
    const descriptor = openSync(file, 'r');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    try {
        while (length < buffer.length) {
            const bytes = readSync(descriptor, buffer, length, buffer.length - length, null);
            if (bytes === 0) {
                return buffer.toString('utf8', 0, length);
            }
            length += bytes;
        }
        throw new Error(`Legacy MCP process inspection exceeded its byte limit: ${file}`);
    } finally {
        closeSync(descriptor);
    }
}

function procStartTime(text: string): string {
    // The comm field may contain spaces and parentheses; fields after its
    // final ')' have fixed positions, with starttime at field 22.
    const value = text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
    if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error('Legacy MCP process start time is unrecognized.');
    }
    return value;
}

export function linuxLegacyMcpProbe(database: DatabaseIdentity, uid: number, procRoot = '/proc'): LegacyMcpProbe {
    return {
        list: () =>
            directoryNames(procRoot)
                .filter((name) => /^\d+$/.test(name))
                .map(Number),
        inspect(pid) {
            const directory = path.join(procRoot, String(pid));
            try {
                if (statSync(directory).uid !== uid) {
                    return undefined;
                }
                const startedAt = procStartTime(readProcFile(path.join(directory, 'stat')));
                const command = readProcFile(path.join(directory, 'cmdline')).split('\0');
                if (command.pop() !== '' || command.length !== 4 || command[2] !== 'mcp' || command[3] !== 'serve') {
                    return undefined;
                }
                let foundDatabase = false;
                let readOnly = true;
                for (const name of directoryNames(path.join(directory, 'fd'))) {
                    if (!/^\d+$/.test(name)) {
                        continue;
                    }
                    const opened = statSync(path.join(directory, 'fd', name), { bigint: true });
                    if (!sameDatabase(opened, database)) {
                        continue;
                    }
                    foundDatabase = true;
                    const flags = /^flags:\s+([0-7]+)$/m.exec(readProcFile(path.join(directory, 'fdinfo', name)))?.[1];
                    if (flags === undefined) {
                        throw new Error('Legacy MCP database descriptor access mode is unrecognized.');
                    }
                    readOnly &&= (Number.parseInt(flags, 8) & 3) === 0;
                }
                if (!foundDatabase) {
                    return undefined;
                }
                const executable = readlinkSync(path.join(directory, 'exe'));
                const mappedFiles = readProcFile(path.join(directory, 'maps'), LEGACY_MCP_INSPECTION_MAX_BYTES)
                    .split('\n')
                    .flatMap((line) => {
                        const mapped = /^\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+(\/.*)$/.exec(line)?.[1];
                        return mapped === undefined ? [] : [mapped.replace(/ \(deleted\)$/, '')];
                    });
                if (procStartTime(readProcFile(path.join(directory, 'stat'))) !== startedAt || statSync(directory).uid !== uid) {
                    return undefined;
                }
                return { pid, uid, startedAt, command, executable, readOnly, mappedFiles };
            } catch (error) {
                if (disappeared(error)) {
                    return undefined;
                }
                throw error;
            }
        },
    };
}

interface LsofFile {
    descriptor: string;
    access?: string;
    type?: string;
    name?: string;
    dev?: string;
    ino?: string;
}

interface LsofProcess {
    pid: number;
    uid?: number;
    files: LsofFile[];
}

function parseLsof(text: string): LsofProcess[] {
    if (text === '') {
        return [];
    }
    const processes: LsofProcess[] = [];
    let process: LsofProcess | undefined;
    let file: LsofFile | undefined;
    for (const field of text.split('\0')) {
        const value = field.replace(/^\n/, '');
        if (value === '') {
            continue;
        }
        const content = value.slice(1);
        if (value[0] === 'p' && /^\d+$/.test(content)) {
            process = { pid: Number(content), files: [] };
            processes.push(process);
            file = undefined;
        } else if (process !== undefined && value[0] === 'u' && /^\d+$/.test(content)) {
            process.uid = Number(content);
        } else if (process !== undefined && value[0] === 'f') {
            file = { descriptor: content };
            process.files.push(file);
        } else if (file !== undefined) {
            if (value[0] === 'a') {
                file.access = content;
            } else if (value[0] === 't') {
                file.type = content;
            } else if (value[0] === 'n') {
                file.name = content;
            } else if (value[0] === 'D') {
                file.dev = content;
            } else if (value[0] === 'i') {
                file.ino = content;
            } else {
                throw new Error('Legacy MCP open-file inspection returned an unrecognized field.');
            }
        } else if (process === undefined || !['R', 'c'].includes(value[0] ?? '')) {
            throw new Error('Legacy MCP open-file inspection returned an unrecognized process.');
        }
    }
    if (!text.endsWith('\0\n') || processes.some((process) => process.uid === undefined)) {
        throw new Error('Legacy MCP open-file inspection returned incomplete output.');
    }
    return processes;
}

function databaseFiles(process: LsofProcess, database: DatabaseIdentity): LsofFile[] {
    return process.files.filter(
        (file) =>
            /^\d+$/.test(file.descriptor) &&
            file.type === 'REG' &&
            file.dev !== undefined &&
            /^0x[0-9a-f]+$/i.test(file.dev) &&
            file.ino !== undefined &&
            /^\d+$/.test(file.ino) &&
            sameDatabase({ dev: BigInt(file.dev), ino: BigInt(file.ino) }, database),
    );
}

export function macosLegacyMcpProbe(
    databasePath: string,
    database: DatabaseIdentity,
    inspection = { databaseFiles: macosDatabaseOpenFiles, processFiles: macosProcessOpenFiles, processCommand: macosProcessCommand },
): LegacyMcpProbe {
    return {
        list: () => parseLsof(inspection.databaseFiles(databasePath)).map((process) => process.pid),
        inspect(pid) {
            const commandText = inspection.processCommand(pid);
            if (commandText === '') {
                return undefined;
            }
            const command = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3} [A-Za-z]{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4})\s+([^\n]+)\n?$/.exec(commandText);
            if (command === null || Number(command[1]) !== pid) {
                throw new Error('Legacy MCP process command inspection returned unrecognized output.');
            }
            const records = parseLsof(inspection.processFiles(pid));
            const process = records.find((record) => record.pid === pid);
            if (process === undefined) {
                return undefined;
            }
            const files = databaseFiles(process, database);
            if (process.uid !== Number(command[2]) || files.length === 0 || inspection.processCommand(pid) !== commandText) {
                return undefined;
            }
            const mappedFiles = process.files
                .filter((file) => file.descriptor === 'txt' && file.type === 'REG')
                .flatMap((file) => (file.name === undefined ? [] : [file.name]));
            const executables = mappedFiles.filter((file) => path.basename(file) === 'node');
            const executable = executables[0];
            const startedAt = command[3];
            const argv = command[4];
            if (executables.length !== 1 || executable === undefined || startedAt === undefined || argv === undefined) {
                return undefined;
            }
            return {
                pid,
                uid: process.uid,
                startedAt,
                command: argv,
                executable,
                readOnly: files.every((file) => file.access === 'r'),
                mappedFiles,
            };
        },
    };
}

function eligibleProcess(candidate: LegacyMcpProcess, installed: ResolvedElephaBin, uid: number, ownPid: number): boolean {
    if (
        !Number.isSafeInteger(candidate.pid) ||
        candidate.pid <= 1 ||
        candidate.pid === ownPid ||
        candidate.uid !== uid ||
        !candidate.readOnly ||
        !path.isAbsolute(candidate.executable) ||
        path.basename(candidate.executable) !== 'node'
    ) {
        return false;
    }
    const retiredRoot = retiredNpmPackageRoot(installed.packageRoot);
    const nativeRoots = ['better-sqlite3', 'better-sqlite3-multiple-ciphers'].map((name) => `${retiredRoot}/node_modules/${name}/`);
    if (
        !candidate.mappedFiles.some(
            (file) => path.normalize(file) === file && nativeRoots.some((root) => file.startsWith(root)) && file.endsWith('.node'),
        )
    ) {
        return false;
    }
    const scripts = [installed.bin, path.join(installed.packageRoot, 'bin', 'elepha.js'), path.join(retiredRoot, 'bin', 'elepha.js')];
    const commands = ['node', candidate.executable].flatMap((node) => scripts.map((script) => [node, script, 'mcp', 'serve']));
    return commands.some((command) =>
        typeof candidate.command === 'string'
            ? candidate.command === command.join(' ')
            : candidate.command.length === command.length && candidate.command.every((argument, index) => argument === command[index]),
    );
}

function sameProcess(first: LegacyMcpProcess, second: LegacyMcpProcess): boolean {
    return JSON.stringify(first) === JSON.stringify(second);
}

// Only the installer may retire an obsolete stdio MCP. Never signal a writer,
// parent application, daemon, arbitrary PID, or a process inferred from a name.
export async function retireLegacyMcpReaders(
    databasePath: string,
    installed: ResolvedElephaBin,
    runtime: LegacyMcpRuntime = {},
): Promise<number> {
    const canonical = realpathSync(databasePath);
    const database = statSync(canonical, { bigint: true });
    const uid = runtime.uid ?? process.getuid?.();
    if (uid === undefined || !database.isFile() || database.uid !== BigInt(uid)) {
        throw new Error('Legacy MCP retirement requires a database owned by the current user.');
    }
    const platform = runtime.platform ?? process.platform;
    const probe =
        runtime.probe ??
        (platform === 'darwin'
            ? macosLegacyMcpProbe(canonical, database)
            : platform === 'linux'
              ? linuxLegacyMcpProbe(database, uid)
              : undefined);
    if (probe === undefined) {
        throw new Error('Legacy MCP retirement is supported on macOS and Linux.');
    }
    const ownPid = runtime.pid ?? process.pid;
    const signal = runtime.signal ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
    const deadline = Date.now() + LEGACY_MCP_RETIRE_TIMEOUT_MS;
    const retired: LegacyMcpProcess[] = [];
    const pids = new Set(probe.list());
    if (pids.size > LEGACY_MCP_SCAN_MAX_ENTRIES) {
        throw new Error('Legacy MCP process inspection exceeded its process limit.');
    }
    try {
        for (const pid of pids) {
            if (Date.now() >= deadline) {
                throw new Error('Legacy MCP process inspection exceeded its time limit.');
            }
            const candidate = probe.inspect(pid);
            if (candidate === undefined || !eligibleProcess(candidate, installed, uid, ownPid)) {
                continue;
            }
            // Keep the complete process generation and ownership proof adjacent
            // to signaling. There is no awaited work in this final check.
            const current = probe.inspect(pid);
            if (
                current === undefined ||
                !sameProcess(candidate, current) ||
                !sameDatabase(database, statSync(canonical, { bigint: true })) ||
                realpathSync(databasePath) !== canonical
            ) {
                continue;
            }
            if (Date.now() >= deadline) {
                throw new Error('Legacy MCP process inspection exceeded its time limit.');
            }
            try {
                signal(pid, 'SIGTERM');
                retired.push(candidate);
            } catch (error) {
                if (!disappeared(error)) {
                    throw error;
                }
            }
        }
        const closeDeadline = Date.now() + LEGACY_MCP_RETIRE_TIMEOUT_MS;
        while (true) {
            let stillOpen = false;
            for (const candidate of retired) {
                if (Date.now() >= closeDeadline) {
                    throw new Error('A retired elepha MCP did not release the database before the timeout.');
                }
                let current: LegacyMcpProcess | undefined;
                try {
                    current = probe.inspect(candidate.pid);
                } catch (error) {
                    // Linux may deny a final /proc/<pid>/fd lookup while the
                    // signaled process exits. Keep waiting; never infer closure.
                    if (!processDescriptorsClosing(error)) {
                        throw error;
                    }
                    stillOpen = true;
                    break;
                }
                if (current !== undefined && current.startedAt === candidate.startedAt) {
                    stillOpen = true;
                    break;
                }
            }
            if (!stillOpen) {
                return retired.length;
            }
            await delay(LEGACY_MCP_RETIRE_POLL_MS);
        }
    } catch (error) {
        if (retired.length > 0) {
            throw new Error(`Legacy MCP retirement stopped after signaling ${retired.length} process(es): ${errorMessage(error)}`, {
                cause: error,
            });
        }
        throw error;
    }
}
