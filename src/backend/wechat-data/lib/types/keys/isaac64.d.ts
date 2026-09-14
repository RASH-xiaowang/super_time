/** One ISAAC-64 state: 256 64-bit words + the a/b/c accumulators. */
export declare class Isaac64 {
    #private;
    /**
     * Seed with a decimal (or 0x-prefixed) string, mirroring WeFlow's
     * BigInt(seed) usage.
     * @param seed - seed value; empty or unparsable seeds use 0.
     */
    constructor(seed: string | number | bigint);
    /** The ISAAC-64 golden ratio mixing constant. */
    static GOLDEN: bigint;
    /**
     * Return the next 64-bit output (reverse table order, like the reference).
     * @returns the next unsigned 64-bit value.
     */
    randU64(): bigint;
    /**
     * Serialize one 64-bit output to 8 bytes in a WeFlow word format.
     * @param raw - the 64-bit output.
     * @param wordFormat - byte layout (raw_le/raw_be/be_swap32/le_swap32).
     * @returns the 8-byte serialization.
     */
    static rawToBytes(raw: bigint, wordFormat: 'raw_le' | 'raw_be' | 'be_swap32' | 'le_swap32'): Buffer;
    /**
     * Generate a keystream of the requested size.
     * @param size - number of bytes to produce.
     * @param wordFormat - WeFlow word byte layout (default be_swap32).
     * @returns the keystream bytes.
     */
    generateKeystream(size: number, wordFormat?: 'raw_le' | 'raw_be' | 'be_swap32' | 'le_swap32'): Buffer;
}
