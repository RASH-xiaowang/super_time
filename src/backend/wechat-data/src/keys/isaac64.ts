/**
 * ISAAC-64 PRNG (WeFlow WxIsaac64-compatible), migrated from WeChatDataAnalysis
 * `isaac64.py`. Moments (SNS) video decryption XORs the first 128 KiB of the
 * MP4 with this keystream using the `be_swap32` word format.
 */
const MASK_64 = 0xFFFFFFFFFFFFFFFFn

/** Wrap an integer to an unsigned 64-bit value. */
function u64(v: bigint): bigint {
  return v & MASK_64
}

/** One ISAAC-64 state: 256 64-bit words + the a/b/c accumulators. */
export class Isaac64 {
  #mm = new Array<bigint>(256).fill(0n)
  #aa = 0n
  #bb = 0n
  #cc = 0n
  #randrsl = new Array<bigint>(256).fill(0n)
  #randcnt = 0

  /**
   * Seed with a decimal (or 0x-prefixed) string, mirroring WeFlow's
   * BigInt(seed) usage.
   * @param seed - seed value; empty or unparsable seeds use 0.
   */
  constructor(seed: string | number | bigint) {
    const text = String(seed).trim()
    let seedVal = 0n
    if (text !== '') {
      try {
        seedVal = BigInt(text)
      } catch {
        seedVal = 0n
      }
    }
    this.#randrsl[0] = u64(seedVal)
    this.#init(true)
  }

  /** The ISAAC-64 golden ratio mixing constant. */
  static GOLDEN = 0x9E3779B97F4A7C15n

  /** Run the 8-way mixer over the a-h state once. */
  #mix(state: { a: bigint; b: bigint; c: bigint; d: bigint; e: bigint; f: bigint; g: bigint; h: bigint }): void {
    state.a = u64(state.a - state.e)
    state.f = u64(state.f ^ (state.h >> 9n))
    state.h = u64(state.h + state.a)
    state.b = u64(state.b - state.f)
    state.g = u64(state.g ^ (state.a << 9n))
    state.a = u64(state.a + state.b)
    state.c = u64(state.c - state.g)
    state.h = u64(state.h ^ (state.b >> 23n))
    state.b = u64(state.b + state.c)
    state.d = u64(state.d - state.h)
    state.a = u64(state.a ^ (state.c << 15n))
    state.c = u64(state.c + state.d)
    state.e = u64(state.e - state.a)
    state.b = u64(state.b ^ (state.d >> 14n))
    state.d = u64(state.d + state.e)
    state.f = u64(state.f - state.b)
    state.c = u64(state.c ^ (state.e << 20n))
    state.e = u64(state.e + state.f)
    state.g = u64(state.g - state.c)
    state.d = u64(state.d ^ (state.f >> 17n))
    state.f = u64(state.f + state.g)
    state.h = u64(state.h - state.d)
    state.e = u64(state.e ^ (state.g << 14n))
    state.g = u64(state.g + state.h)
  }

  /** Initialize the 256-word table (two passes when seeded). */
  #init(flag: boolean): void {
    const s = {
      a: Isaac64.GOLDEN, b: Isaac64.GOLDEN, c: Isaac64.GOLDEN, d: Isaac64.GOLDEN,
      e: Isaac64.GOLDEN, f: Isaac64.GOLDEN, g: Isaac64.GOLDEN, h: Isaac64.GOLDEN,
    }
    for (let round = 0; round < 4; round += 1) this.#mix(s)
    for (let i = 0; i < 256; i += 8) {
      if (flag) {
        s.a = u64(s.a + (this.#randrsl[i] ?? 0n))
        s.b = u64(s.b + (this.#randrsl[i + 1] ?? 0n))
        s.c = u64(s.c + (this.#randrsl[i + 2] ?? 0n))
        s.d = u64(s.d + (this.#randrsl[i + 3] ?? 0n))
        s.e = u64(s.e + (this.#randrsl[i + 4] ?? 0n))
        s.f = u64(s.f + (this.#randrsl[i + 5] ?? 0n))
        s.g = u64(s.g + (this.#randrsl[i + 6] ?? 0n))
        s.h = u64(s.h + (this.#randrsl[i + 7] ?? 0n))
      }
      this.#mix(s)
      this.#mm[i] = s.a
      this.#mm[i + 1] = s.b
      this.#mm[i + 2] = s.c
      this.#mm[i + 3] = s.d
      this.#mm[i + 4] = s.e
      this.#mm[i + 5] = s.f
      this.#mm[i + 6] = s.g
      this.#mm[i + 7] = s.h
    }
    if (flag) {
      for (let i = 0; i < 256; i += 8) {
        s.a = u64(s.a + (this.#mm[i] ?? 0n))
        s.b = u64(s.b + (this.#mm[i + 1] ?? 0n))
        s.c = u64(s.c + (this.#mm[i + 2] ?? 0n))
        s.d = u64(s.d + (this.#mm[i + 3] ?? 0n))
        s.e = u64(s.e + (this.#mm[i + 4] ?? 0n))
        s.f = u64(s.f + (this.#mm[i + 5] ?? 0n))
        s.g = u64(s.g + (this.#mm[i + 6] ?? 0n))
        s.h = u64(s.h + (this.#mm[i + 7] ?? 0n))
        this.#mix(s)
        this.#mm[i] = s.a
        this.#mm[i + 1] = s.b
        this.#mm[i + 2] = s.c
        this.#mm[i + 3] = s.d
        this.#mm[i + 4] = s.e
        this.#mm[i + 5] = s.f
        this.#mm[i + 6] = s.g
        this.#mm[i + 7] = s.h
      }
    }
    this.#isaac64()
    this.#randcnt = 256
  }

  /** Refill the output table. */
  #isaac64(): void {
    this.#cc = u64(this.#cc + 1n)
    this.#bb = u64(this.#bb + this.#cc)
    for (let i = 0; i < 256; i += 1) {
      const x = (this.#mm[i] ?? 0n)
      if ((i & 3) === 0) this.#aa = u64(this.#aa ^ (u64(this.#aa << 21n) ^ MASK_64))
      else if ((i & 3) === 1) this.#aa = u64(this.#aa ^ (this.#aa >> 5n))
      else if ((i & 3) === 2) this.#aa = u64(this.#aa ^ (this.#aa << 12n))
      else this.#aa = u64(this.#aa ^ (this.#aa >> 33n))
      this.#aa = u64((this.#mm[(i + 128) & 255] ?? 0n) + this.#aa)
      const y = u64((this.#mm[Number((x >> 3n) & 255n)] ?? 0n) + this.#aa + this.#bb)
      this.#mm[i] = y
      this.#bb = u64((this.#mm[Number((y >> 11n) & 255n)] ?? 0n) + x)
      this.#randrsl[i] = this.#bb
    }
  }

  /**
   * Return the next 64-bit output (reverse table order, like the reference).
   * @returns the next unsigned 64-bit value.
   */
  randU64(): bigint {
    if (this.#randcnt === 0) {
      this.#isaac64()
      this.#randcnt = 256
    }
    this.#randcnt -= 1
    return u64(this.#randrsl[this.#randcnt] ?? 0n)
  }

  /**
   * Serialize one 64-bit output to 8 bytes in a WeFlow word format.
   * @param raw - the 64-bit output.
   * @param wordFormat - byte layout (raw_le/raw_be/be_swap32/le_swap32).
   * @returns the 8-byte serialization.
   */
  static rawToBytes(raw: bigint, wordFormat: 'raw_le' | 'raw_be' | 'be_swap32' | 'le_swap32'): Buffer {
    const v = u64(raw)
    if (wordFormat === 'raw_le') return Buffer.from(v.toString(16).padStart(16, '0'), 'hex').reverse()
    if (wordFormat === 'raw_be') return Buffer.from(v.toString(16).padStart(16, '0'), 'hex')
    if (wordFormat === 'be_swap32') {
      const b = Buffer.from(v.toString(16).padStart(16, '0'), 'hex')
      return Buffer.concat([b.subarray(4, 8), b.subarray(0, 4)])
    }
    // le_swap32 (last remaining branch).
    const b = Buffer.from(v.toString(16).padStart(16, '0'), 'hex').reverse()
    return Buffer.concat([b.subarray(4, 8), b.subarray(0, 4)])
  }

  /**
   * Generate a keystream of the requested size.
   * @param size - number of bytes to produce.
   * @param wordFormat - WeFlow word byte layout (default be_swap32).
   * @returns the keystream bytes.
   */
  generateKeystream(size: number, wordFormat: 'raw_le' | 'raw_be' | 'be_swap32' | 'le_swap32' = 'be_swap32'): Buffer {
    const want = Math.max(0, Math.floor(size))
    if (want === 0) return Buffer.alloc(0)
    const blocks = Math.ceil(want / 8)
    const out: Buffer[] = []
    for (let i = 0; i < blocks; i += 1) out.push(Isaac64.rawToBytes(this.randU64(), wordFormat))
    return Buffer.concat(out).subarray(0, want)
  }
}
