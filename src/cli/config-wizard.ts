import type { Readable, Writable } from 'node:stream';
import * as clack from '@clack/prompts';
import { elephaConfigPath } from '../config/paths.js';
import { type EffectiveSetting, listSettings, SETTING_SCHEMA, type SettingKey, setSetting, unsetSetting } from '../config/settings.js';
import { errorMessage } from '../util/error.js';
import { printTagline } from './wordmark.js';

interface ConfigInput extends Readable {
    isTTY?: boolean;
}

interface ConfigOutput extends Writable {
    isTTY?: boolean;
}

interface PromptOption {
    value: string;
    label: string;
    hint?: string;
}

export interface ConfigPrompts {
    intro(title: string): void;

    note(message: string, title?: string): void;

    select(options: { message: string; options: PromptOption[] }): Promise<string | symbol>;

    isCancel(value: unknown): boolean;

    cancel(message: string): void;

    outro(message: string): void;
}

export interface ConfigWizardOptions {
    input?: ConfigInput;
    output?: ConfigOutput;
    environment?: NodeJS.ProcessEnv;
    configPath?: string;
    // Test seam; production routes every visual element through @clack/prompts.
    prompts?: ConfigPrompts;
}

function clackPrompts(input: ConfigInput, output: ConfigOutput): ConfigPrompts {
    const common = { input, output };
    return {
        intro: (title) => clack.intro(title, common),
        note: (message, title) => clack.note(message, title, common),
        select: (options) => clack.select({ ...options, ...common }) as Promise<string | symbol>,
        isCancel: clack.isCancel,
        cancel: (message) => clack.cancel(message, common),
        outro: (message) => clack.outro(message, common),
    };
}

function cancelled(prompts: ConfigPrompts): number {
    prompts.cancel('Operation cancelled. No changes were made.');
    return 0;
}

export function renderSettingValue(key: SettingKey, value: EffectiveSetting['value'] | string): string {
    if (SETTING_SCHEMA[key].kind === 'boolean') {
        const enabled = typeof value === 'boolean' ? value : value === 'on';
        return enabled ? 'On' : 'Off';
    }
    return String(value);
}

function sourceMarker(setting: EffectiveSetting): string {
    return setting.source === 'config' ? '' : ` (${setting.source})`;
}

export function renderSetting(setting: EffectiveSetting): string {
    return `${setting.key} = ${renderSettingValue(setting.key, setting.value)}${sourceMarker(setting)}`;
}

function settingOptions(settings: EffectiveSetting[]): PromptOption[] {
    return settings.map((setting) => ({
        value: setting.key,
        label: renderSetting(setting),
    }));
}

function isDefaultChoice(key: SettingKey, value: string): boolean {
    const schema = SETTING_SCHEMA[key];
    if (schema.kind === 'boolean') {
        return (value === 'on') === schema.default;
    }
    return value === schema.default;
}

function settingChoices(key: SettingKey): PromptOption[] {
    const schema = SETTING_SCHEMA[key];
    const values = schema.kind === 'boolean' ? schema.values.filter((value) => value === 'on' || value === 'off') : schema.values;
    return values.map((value) => ({
        value,
        label: `${renderSettingValue(key, value)}${isDefaultChoice(key, value) ? ' (default)' : ''}`,
    }));
}

export async function runConfigWizard(options: ConfigWizardOptions = {}): Promise<number> {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const prompts = options.prompts ?? clackPrompts(input, output);
    const configPath = options.configPath ?? elephaConfigPath();
    const environment = options.environment ?? process.env;
    printTagline(output);
    prompts.intro('Configure elepha');

    while (true) {
        const settings = listSettings(environment, configPath);
        const selected = await prompts.select({
            message: 'Which setting should elepha change?',
            options: settingOptions(settings),
        });
        if (prompts.isCancel(selected) || typeof selected !== 'string') {
            return cancelled(prompts);
        }

        const setting = settings.find((candidate) => candidate.key === selected);
        if (!setting) {
            return cancelled(prompts);
        }
        if (setting.source === 'env') {
            prompts.note(
                'ELEPHA_NO_UPDATE_CHECK currently overrides this setting for this run. Your config preference will still be saved.',
                'Environment override',
            );
        }

        const choices = settingChoices(setting.key);
        const choice = await prompts.select({
            message: 'Which value should elepha use?',
            options: choices,
        });
        if (prompts.isCancel(choice) || typeof choice !== 'string' || !choices.some((option) => option.value === choice)) {
            return cancelled(prompts);
        }

        try {
            if (isDefaultChoice(setting.key, choice)) {
                unsetSetting(setting.key, configPath);
                prompts.outro(`${setting.key} returned to its default.`);
            } else {
                setSetting(setting.key, choice, configPath);
                prompts.outro(`${setting.key} set to ${renderSettingValue(setting.key, choice)}.`);
            }
            return 0;
        } catch (error) {
            prompts.note(errorMessage(error), 'Setting unchanged');
        }
    }
}
