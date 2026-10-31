// SPDX-License-Identifier: AGPL-3.0-or-later
// Bit-exact port of the random number generation Anki's scheduler relies on:
// `StdRng::seed_from_u64` (rand_core 0.10.1, PCG32 seed expansion),
// `StdRng` = ChaCha12 (chacha20 crate, as used by rand 0.10.1), and the
// float/int/weighted sampling algorithms from rand 0.10.1.
// rand, rand_core and chacha20 are MIT OR Apache-2.0 (see NOTICE.md).

const f32buf = new DataView(new ArrayBuffer(4));

/** Reinterpret the low 32 bits of `bits` as an IEEE-754 single. */
export function f32FromBits(bits: number): number {
  f32buf.setUint32(0, bits >>> 0, true);
  return f32buf.getFloat32(0, true);
}

export function f32ToBits(value: number): number {
  f32buf.setFloat32(0, value, true);
  return f32buf.getUint32(0, true);
}

export const f32 = Math.fround;

const MASK64 = (1n << 64n) - 1n;

/** PCG32 output function as used by rand_core's `seed_from_u64`. */
function pcg32(state: { s: bigint }): number {
  const MUL = 0x5851f42d4c957f2dn;
  const INC = 0xa17654e46fbe17f3n;
  state.s = (state.s * MUL + INC) & MASK64;
  const s = state.s;
  const xorshifted = Number((((s >> 18n) ^ s) >> 27n) & 0xffffffffn) >>> 0;
  const rot = Number(s >> 59n);
  return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
}

function rotl(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

/** ChaCha with 12 rounds, 64-bit block counter and 64-bit stream id 0. */
export class ChaCha12Rng {
  private readonly key: Uint32Array;
  private counter = 0;
  private readonly block = new Uint32Array(16);
  private index = 16;

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error("ChaCha seed must be 32 bytes");
    const view = new DataView(seed.buffer, seed.byteOffset, 32);
    this.key = new Uint32Array(8);
    for (let i = 0; i < 8; i++) this.key[i] = view.getUint32(i * 4, true);
  }

  /** Equivalent of `SeedableRng::seed_from_u64`. */
  static seedFromU64(seed: bigint | number): ChaCha12Rng {
    const state = { s: BigInt.asUintN(64, BigInt(seed)) };
    const bytes = new Uint8Array(32);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 32; i += 4) view.setUint32(i, pcg32(state), true);
    return new ChaCha12Rng(bytes);
  }

  private refill(): void {
    const k = this.key;
    const input = new Uint32Array([
      0x61707865, 0x3320646e, 0x79622d32, 0x6b206574,
      k[0]!, k[1]!, k[2]!, k[3]!, k[4]!, k[5]!, k[6]!, k[7]!,
      this.counter >>> 0, Math.floor(this.counter / 0x100000000) >>> 0, 0, 0,
    ]);
    const x = new Uint32Array(input);
    const qr = (a: number, b: number, c: number, d: number) => {
      x[a] = (x[a]! + x[b]!) >>> 0; x[d] = rotl(x[d]! ^ x[a]!, 16);
      x[c] = (x[c]! + x[d]!) >>> 0; x[b] = rotl(x[b]! ^ x[c]!, 12);
      x[a] = (x[a]! + x[b]!) >>> 0; x[d] = rotl(x[d]! ^ x[a]!, 8);
      x[c] = (x[c]! + x[d]!) >>> 0; x[b] = rotl(x[b]! ^ x[c]!, 7);
    };
    for (let i = 0; i < 6; i++) {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) this.block[i] = (x[i]! + input[i]!) >>> 0;
    this.counter++;
    this.index = 0;
  }

  nextU32(): number {
    if (this.index >= 16) this.refill();
    return this.block[this.index++]!;
  }

  nextU64(): bigint {
    const lo = BigInt(this.nextU32());
    const hi = BigInt(this.nextU32());
    return (hi << 32n) | lo;
  }
}

/** One f32 in [0, 1) the way `UniformFloat<f32>` draws it (23 random bits). */
function value0To1(rng: ChaCha12Rng): number {
  return f32(f32FromBits((rng.nextU32() >>> 9) | 0x3f800000) - 1);
}

/** `rng.random_range(low..high)` for f32 (sample_single → sample_single_inclusive). */
export function randomRangeF32(rng: ChaCha12Rng, low: number, high: number): number {
  const scale = f32(high - low);
  return f32(f32(value0To1(rng) * scale) + low);
}

/** `rng.random_range(low..high)` for u32 (Canon's method, rand without `unbiased`). */
export function randomRangeU32(rng: ChaCha12Rng, low: number, highExclusive: number): number {
  if (!(low < highExclusive)) throw new Error("empty range");
  const high = highExclusive - 1;
  const range = BigInt.asUintN(32, BigInt(high - low + 1));
  if (range === 0n) return rng.nextU32();
  const product = BigInt(rng.nextU32()) * range;
  let result = product >> 32n;
  const loOrder = product & 0xffffffffn;
  if (loOrder > BigInt.asUintN(32, -range)) {
    const newHi = (BigInt(rng.nextU32()) * range) >> 32n;
    if (loOrder + newHi > 0xffffffffn) result += 1n;
  }
  return (low + Number(result)) >>> 0;
}

function prevF32(value: number): number {
  return f32FromBits(f32ToBits(value) - 1);
}

/**
 * `WeightedIndex::<f32>::new(weights).sample(rng)`. Returns null where rand
 * returns an error (no weights, a negative weight, or all zero).
 */
export function weightedIndexSampleF32(rng: ChaCha12Rng, weights: readonly number[]): number | null {
  if (weights.length === 0) return null;
  let total = f32(weights[0]!);
  if (!(total >= 0)) return null;
  const cumulative: number[] = [];
  for (let i = 1; i < weights.length; i++) {
    const w = f32(weights[i]!);
    if (!(w >= 0)) return null;
    cumulative.push(total);
    total = f32(total + w);
  }
  if (total === 0) return null;
  // UniformFloat::new(0, total) → new_bounded
  const maxRand = f32(1 - 2 ** -23);
  let scale = total;
  while (f32(f32(scale * maxRand) + 0) > total) scale = prevF32(scale);
  const chosen = f32(f32(value0To1(rng) * scale) + 0);
  let idx = 0;
  while (idx < cumulative.length && cumulative[idx]! <= chosen) idx++;
  return idx;
}

/** 64-bit FNV-1a over little-endian i64 words, as Anki's `fnvhash()` SQL function. */
export function fnvHashI64(...values: Array<number | bigint>): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const value of values) {
    let v = BigInt.asUintN(64, BigInt(value));
    for (let i = 0; i < 8; i++) {
      hash ^= v & 0xffn;
      hash = (hash * 0x100000001b3n) & MASK64;
      v >>= 8n;
    }
  }
  return BigInt.asIntN(64, hash);
}
