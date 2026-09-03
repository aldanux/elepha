import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { writeJson } from '../util/fs.js';
import { PRIVATE_FILE_MODE } from './constants.js';
import { elephaConfigPath } from './paths.js';

const UPDATE_CHECK_KEY = 'update-check';
const BOOLEAN_SETTING_VALUES = ['true', 'false', '1', '0', 'on', 'off'] as const;

export const SETTING_KEYS = [UPDATE_CHECK_KEY, 'capture-claude-code', 'capture-codex', 'durable-capture', 'query-matching'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type SettingSource = 'config' | 'env' | 'default';
export type QueryMatchingMode = 'strict' | 'lax';

interface BooleanSettingSchema {
    kind: 'boolean';
    values: typeof BOOLEAN_SETTING_VALUES;
    default: boolean;
}

interface EnumSettingSchema {
    kind: 'enum';
    values: readonly string[];
    default: string;
}

type SettingSchema = BooleanSettingSchema | EnumSettingSchema;

export const SETTING_SCHEMA = {
    'update-check': { kind: 'boolean', values: BOOLEAN_SETTING_VALUES, default: true },
    'capture-claude-code': { kind: 'boolean', values: BOOLEAN_SETTING_VALUES, default: true },
    'capture-codex': { kind: 'boolean', values: BOOLEAN_SETTING_VALUES, default: true },
    'durable-capture': { kind: 'boolean', values: BOOLEAN_SETTING_VALUES, default: false },
    'query-matching': { kind: 'enum', values: ['strict', 'lax'], default: 'strict' },
} as const satisfies Record<SettingKey, SettingSchema>;

type SchemaValue<Schema> = Schema extends { kind: 'boolean' }
    ? boolean
    : Schema extends { values: readonly (infer Value extends string)[] }
      ? Value
      : never;
type SettingValueFor<K extends SettingKey> = SchemaValue<(typeof SETTING_SCHEMA)[K]>;

export interface EffectiveSetting<K extends SettingKey = SettingKey> {
    key: K;
    value: SettingValueFor<K>;
    source: SettingSource;
}

type ConfigObject = Record<string, unknown>;

interface ConfigRead {
    config: ConfigObject;
    exists: boolean;
    error?: string;
}

function validKey(key: string): key is SettingKey {
    return (SETTING_KEYS as readonly string[]).includes(key);
}

function unknownKeyError(key: string): Error {
    return new Error(`unknown setting "${key}"; valid keys: ${SETTING_KEYS.join(', ')}`);
}

function readConfig(filePath: string): ConfigRead {
    let raw: string;
    try {
        raw = readFileSync(filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { config: {}, exists: false };
        }
        return { config: {}, exists: true, error: 'cannot read config' };
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { config: {}, exists: true, error: 'config must be a JSON object' };
        }
        return { config: parsed as ConfigObject, exists: true };
    } catch {
        return { config: {}, exists: true, error: 'config is invalid JSON' };
    }
}

function readConfigForMutation(filePath: string): ConfigRead {
    const result = readConfig(filePath);
    if (result.error) {
        throw new Error(result.error);
    }
    return result;
}

function acceptedValues(values: readonly string[]): string {
    if (values.length === 2) {
        return `${values[0]} or ${values[1]}`;
    }
    return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
}

function parseSetting<K extends SettingKey>(key: K, value: string): SettingValueFor<K> {
    const schema = SETTING_SCHEMA[key];
    const normalized = value.toLowerCase();
    if (schema.kind === 'boolean') {
        if (normalized === 'true' || normalized === '1' || normalized === 'on') {
            return true as SettingValueFor<K>;
        }
        if (normalized === 'false' || normalized === '0' || normalized === 'off') {
            return false as SettingValueFor<K>;
        }
    } else if ((schema.values as readonly string[]).includes(normalized)) {
        return normalized as SettingValueFor<K>;
    }
    throw new Error(`${key} must be ${acceptedValues(schema.values)}`);
}

function configuredSetting<K extends SettingKey>(key: K, value: unknown): SettingValueFor<K> | undefined {
    const schema = SETTING_SCHEMA[key];
    if (schema.kind === 'boolean') {
        return (typeof value === 'boolean' ? value : undefined) as SettingValueFor<K> | undefined;
    }
    return (typeof value === 'string' && (schema.values as readonly string[]).includes(value) ? value : undefined) as
        | SettingValueFor<K>
        | undefined;
}

function captureEnabled(config: ConfigObject, key: 'capture-claude-code' | 'capture-codex'): boolean {
    return configuredSetting(key, config[key]) ?? SETTING_SCHEMA[key].default;
}

function writeConfig(filePath: string, config: ConfigObject): void {
    writeJson(filePath, config, PRIVATE_FILE_MODE);
    chmodSync(filePath, PRIVATE_FILE_MODE);
}

// `ELEPHA_NO_UPDATE_CHECK` is intentionally presence-based: it is a
// per-invocation kill switch, while config.json is the persistent preference.
export function getSetting<K extends SettingKey>(key: K, environment?: NodeJS.ProcessEnv, filePath?: string): EffectiveSetting<K>;
export function getSetting(key: string, environment?: NodeJS.ProcessEnv, filePath?: string): EffectiveSetting;
export function getSetting(
    key: string,
    environment: NodeJS.ProcessEnv = process.env,
    filePath: string = elephaConfigPath(),
): EffectiveSetting {
    if (!validKey(key)) {
        throw unknownKeyError(key);
    }
    if (key === UPDATE_CHECK_KEY && environment.ELEPHA_NO_UPDATE_CHECK !== undefined) {
        return { key, value: false, source: 'env' };
    }
    const configValue = readConfig(filePath).config[key];
    const configured = configuredSetting(key, configValue);
    if (configured !== undefined) {
        return { key, value: configured, source: 'config' };
    }
    return { key, value: SETTING_SCHEMA[key].default, source: 'default' };
}

export function listSettings(environment: NodeJS.ProcessEnv = process.env, filePath: string = elephaConfigPath()): EffectiveSetting[] {
    return SETTING_KEYS.map((key) => getSetting(key, environment, filePath));
}

export function setSetting(key: string, value: string, filePath: string = elephaConfigPath()): EffectiveSetting {
    if (!validKey(key)) {
        throw unknownKeyError(key);
    }
    const config = readConfigForMutation(filePath).config;
    const parsedValue = parseSetting(key, value);
    if (!parsedValue && key === 'capture-claude-code' && !captureEnabled(config, 'capture-codex')) {
        throw new Error('at least one capture tool must remain enabled');
    }
    if (!parsedValue && key === 'capture-codex' && !captureEnabled(config, 'capture-claude-code')) {
        throw new Error('at least one capture tool must remain enabled');
    }
    config[key] = parsedValue;
    writeConfig(filePath, config);
    return getSetting(key, {}, filePath);
}

export function unsetSetting(key: string, filePath: string = elephaConfigPath()): EffectiveSetting {
    if (!validKey(key)) {
        throw unknownKeyError(key);
    }
    if (!existsSync(filePath)) {
        return getSetting(key, {}, filePath);
    }
    const config = readConfigForMutation(filePath).config;
    if (key in config) {
        delete config[key];
        writeConfig(filePath, config);
    }
    return getSetting(key, {}, filePath);
}
