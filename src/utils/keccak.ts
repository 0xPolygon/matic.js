import { keccak224, keccak384, keccak256 as k256, keccak512 } from 'ethereum-cryptography/keccak';

export class Keccak {
    /**
     * Throws if input is not a buffer
     * @param {Buffer} input value to check
     */
    static assertIsBuffer = function (input: Buffer): void {
        if (!Buffer.isBuffer(input)) {
        const msg = `This method only supports Buffer but input was: ${input}`;
        throw new Error(msg);
        }
    };

    /**
     * Creates Keccak hash of a Buffer input
     * @param a The input data (Buffer)
     * @param bits (number = 256) The Keccak width
     */
    static keccak = function (a: Buffer, bits = 256): Buffer {
        Keccak.assertIsBuffer(a);
        switch (bits) {
            case 224: {
                return Buffer.from(keccak224(a));
            }
            case 256: {
                return Buffer.from(k256(a));
            }
            case 384: {
                return Buffer.from(keccak384(a));
            }
            case 512: {
                return Buffer.from(keccak512(a));
            }
            default: {
                throw new Error(`Invalid algorithm: keccak${bits}`);
            }
        }
    };

    /**
     * Creates Keccak-256 hash of the input, alias for keccak(a, 256).
     * @param a The input data (Buffer)
     */
    static keccak256 = function (a: Buffer): Buffer {
        return Keccak.keccak(a);
    };
}
