import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(value: bigint, length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) {
        out = CROCKFORD[Number(value & 31n)] + out;
        value >>= 5n;
    }
    return out;
}

/** Generates a canonical 26-character ULID without adding a runtime dependency. */
export function newUlid(now = Date.now()): string {
    const time = encode(BigInt(now), 10);
    const randomness = randomBytes(10).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
    return `${time}${encode(randomness, 16)}`;
}
