import type { Command } from 'commander';
import { getSetting, listSettings, setSetting, unsetSetting } from '../../config/settings.js';
import { errorMessage } from '../../util/error.js';
import { renderSetting, renderSettingValue, runConfigWizard } from '../config-wizard.js';

function printSettings(): void {
    for (const setting of listSettings()) {
        console.log(renderSetting(setting));
    }
}

export function registerConfig(program: Command): void {
    const config = program.command('config').description('View and change persistent settings: list / get / set / unset');

    config
        .command('get')
        .argument('<key>')
        .action((key: string) => {
            try {
                const setting = getSetting(key);
                console.log(renderSettingValue(setting.key, setting.value));
            } catch (error) {
                console.error(errorMessage(error));
                process.exitCode = 1;
            }
        });

    config
        .command('set')
        .argument('<key>')
        .argument('<value>')
        .action((key: string, value: string) => {
            try {
                const setting = setSetting(key, value);
                console.log(`${setting.key} set to ${renderSettingValue(setting.key, setting.value)}`);
            } catch (error) {
                console.error(errorMessage(error));
                process.exitCode = 1;
            }
        });

    config
        .command('unset')
        .argument('<key>')
        .action((key: string) => {
            try {
                const setting = unsetSetting(key);
                console.log(`${setting.key} unset; effective value: ${renderSettingValue(setting.key, setting.value)}`);
            } catch (error) {
                console.error(errorMessage(error));
                process.exitCode = 1;
            }
        });

    config.command('list').action(printSettings);

    config.action(async () => {
        if (!process.stdout.isTTY) {
            printSettings();
            return;
        }
        try {
            process.exitCode = await runConfigWizard();
        } catch (error) {
            console.error(errorMessage(error));
            process.exitCode = 1;
        }
    });
}
