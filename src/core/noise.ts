/**
 * Deterministic hashing and value noise.
 *
 * Everything here is a pure function of its inputs — no seeded RNG state — so
 * a scene can ask for "the noise at this pixel" every frame without keeping
 * per-pixel storage, and the dissolve transition can pick a stable random
 * threshold per cell without allocating a mask.
 */

/** Integer hash -> 0..1. */
export function hash1(n: number): number {
  let x = n | 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = x + (x << 3);
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return (x >>> 0) / 4294967296;
}

/** 2D integer hash -> 0..1. */
export function hash2(x: number, y: number): number {
  return hash1((x | 0) * 374761393 + (y | 0) * 668265263);
}

/** Small xorshift generator for scenes that want reproducible particle setups. */
export class Rng {
  private s: number;

  constructor(seed = 0x9e3779b9) {
    this.s = seed | 0 || 1;
  }

  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x;
    return (x >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
}
