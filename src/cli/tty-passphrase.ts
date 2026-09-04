// Passphrases are read from the controlling terminal itself, never stdin.
// Raw mode supplies echo-free input without invoking stty or any subprocess.

import { closeSync, constants as fsConstants, openSync } from 'node:fs';
import { ReadStream } from 'node:tty';

export async function readTtyPassphrase(prompt: string, platform: NodeJS.Platform = process.platform): Promise<string> {
    process.stderr.write(prompt);
    const device = platform === 'win32' ? 'CONIN$' : '/dev/tty';
    const descriptor = openSync(device, fsConstants.O_RDONLY);
    let input: ReadStream;
    try {
        input = new ReadStream(descriptor);
    } catch (error) {
        closeSync(descriptor);
        throw error;
    }
    const wasRaw = input.isRaw;
    try {
        input.setEncoding('utf8');
        input.setRawMode(true);
        input.resume();
    } catch (error) {
        input.destroy();
        throw error;
    }

    return new Promise<string>((resolve, reject) => {
        let value = '';
        let settled = false;
        const finish = (error?: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            input.off('data', onData);
            input.off('error', onError);
            let resultError = error;
            try {
                input.setRawMode(wasRaw);
            } catch (cleanupError) {
                resultError ??= cleanupError as Error;
            }
            input.destroy();
            process.stderr.write('\n');
            if (resultError) {
                reject(resultError);
            } else {
                resolve(value);
            }
        };
        const onError = (error: Error): void => finish(error);
        const onData = (chunk: string | Buffer): void => {
            for (const character of chunk.toString()) {
                if (character === '\r' || character === '\n') {
                    finish();
                    return;
                }
                if (character === '\u0003' || character === '\u0004') {
                    finish(new Error('Passphrase entry cancelled.'));
                    return;
                }
                if (character === '\u007f' || character === '\b') {
                    value = [...value].slice(0, -1).join('');
                    continue;
                }
                if (character >= ' ') {
                    value += character;
                }
            }
        };
        input.on('data', onData);
        input.on('error', onError);
    });
}
