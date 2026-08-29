import { ELEPHA_TAGLINE, ELEPHA_WORDMARK } from '../config/constants.js';

interface WordmarkOutput {
    write(s: string): void;
    isTTY?: boolean;
}

function print(output: WordmarkOutput, message: string): void {
    output.write(`${message}\n`);
}

export function printWordmark(output: WordmarkOutput): void {
    const wordmark =
        output.isTTY && process.env.NO_COLOR === undefined ? `\n\x1b[38;2;0;211;242m${ELEPHA_WORDMARK}\x1b[0m` : `\n${ELEPHA_WORDMARK}`;
    print(output, wordmark);
}

export function printTagline(output: WordmarkOutput): void {
    const tagline =
        output.isTTY && process.env.NO_COLOR === undefined
            ? `\n\x1b[48;2;230;230;230m\x1b[38;2;26;26;26m${ELEPHA_TAGLINE}\x1b[0m\n`
            : `\n${ELEPHA_TAGLINE}\n`;
    print(output, tagline);
}
