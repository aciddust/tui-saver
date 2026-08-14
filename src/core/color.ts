/**
 * Colour utilities.
 *
 * Palettes write into a caller-supplied array rather than returning a fresh
 * tuple: at braille resolution a single frame can ask for ~40k colours, and
 * allocating a 3-element array per sample turns the GC into the bottleneck.
 */

export type RGBOut = Float32Array | number[];

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export type Palette = {
  id: string;
  title: string;
  /** Samples the gradient at `t` (wrapped into 0..1) into out[off..off+2]. */
  sample(t: number, out: RGBOut, off?: number): void;
};

const TAU = Math.PI * 2;

/**
 * Inigo Quilez style cosine gradient: colour = a + b * cos(TAU * (c*t + d)).
 * Four vec3 knobs describe a smooth, always-in-gamut cyclic palette.
 */
function cosine(
  id: string,
  title: string,
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
): Palette {
  return {
    id,
    title,
    sample(t: number, out: RGBOut, off = 0): void {
      for (let i = 0; i < 3; i++) {
        out[off + i] = clamp01(a[i] + b[i] * Math.cos(TAU * (c[i] * t + d[i])));
      }
    },
  };
}

/** Piecewise-linear gradient through a list of stops, for non-cyclic looks. */
function ramp(id: string, title: string, stops: readonly (readonly number[])[]): Palette {
  const n = stops.length;
  return {
    id,
    title,
    sample(t: number, out: RGBOut, off = 0): void {
      const x = clamp01(t) * (n - 1);
      const i = Math.min(n - 2, Math.floor(x));
      const f = x - i;
      const lo = stops[i];
      const hi = stops[i + 1];
      out[off] = mix(lo[0], hi[0], f);
      out[off + 1] = mix(lo[1], hi[1], f);
      out[off + 2] = mix(lo[2], hi[2], f);
    },
  };
}

export const PALETTES: Palette[] = [
  ramp('mono', 'monochrome', [
    [0.02, 0.02, 0.03],
    [1, 1, 1],
  ]),
  ramp('amber', 'amber phosphor', [
    [0.05, 0.02, 0.0],
    [0.55, 0.22, 0.0],
    [1.0, 0.66, 0.16],
    [1.0, 0.95, 0.78],
  ]),
  ramp('green', 'green phosphor', [
    [0.0, 0.04, 0.02],
    [0.0, 0.42, 0.16],
    [0.24, 0.95, 0.42],
    [0.82, 1.0, 0.86],
  ]),
  ramp('ice', 'glacier', [
    [0.02, 0.04, 0.1],
    [0.06, 0.28, 0.55],
    [0.3, 0.72, 0.92],
    [0.86, 0.97, 1.0],
  ]),
  ramp('ember', 'ember', [
    [0.03, 0.0, 0.02],
    [0.42, 0.04, 0.06],
    [0.9, 0.32, 0.04],
    [1.0, 0.78, 0.28],
    [1.0, 0.98, 0.88],
  ]),
  ramp('magma', 'magma', [
    [0.0, 0.0, 0.02],
    [0.28, 0.06, 0.4],
    [0.72, 0.2, 0.4],
    [0.99, 0.55, 0.28],
    [0.99, 0.95, 0.72],
  ]),
  ramp('viridis', 'viridis', [
    [0.27, 0.0, 0.33],
    [0.23, 0.32, 0.55],
    [0.13, 0.57, 0.55],
    [0.37, 0.79, 0.38],
    [0.99, 0.91, 0.15],
  ]),
  cosine('cyber', 'cyberpunk', [0.55, 0.35, 0.6], [0.45, 0.3, 0.4], [1, 1, 1], [0.0, 0.28, 0.55]),
  cosine('rainbow', 'rainbow', [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 1], [0.0, 0.33, 0.67]),
];

export function paletteById(id: string): Palette | undefined {
  return PALETTES.find((p) => p.id === id);
}

/**
 * Channel quantisation step applied when packing.
 *
 * This is a bandwidth control, not an aesthetic one. A full-screen pixel shader
 * gives every cell a colour a shade different from its neighbour, so the writer
 * has to emit a fresh SGR sequence per cell — 130 KB a frame at a normal
 * terminal size. Snapping channels to a coarser grid makes runs of neighbouring
 * cells byte-identical, which the run coalescing then collapses, and makes a
 * slowly drifting cell compare equal to its previous frame so the diff skips it
 * entirely.
 *
 * 4 keeps 6 bits per channel (262k colours). The banding that costs is not
 * visible in a character grid, where the glyph carries most of the structure.
 */
const QUANT = 4;

function q(v: number): number {
  const i = (clamp01(v) * 255 + 0.5) | 0;
  // Round to the nearest step, then clamp so the top of the range stays 255
  // rather than wrapping past it.
  const snapped = Math.round(i / QUANT) * QUANT;
  return snapped > 255 ? 255 : snapped;
}

/** Packs 0..1 floats into 0xRRGGBB. -1 is reserved for "terminal default". */
export function pack(r: number, g: number, b: number): number {
  return (q(r) << 16) | (q(g) << 8) | q(b);
}

/** Maps 0xRRGGBB onto the xterm-256 palette (6x6x6 cube plus greyscale ramp). */
export function to256(packed: number): number {
  const r = (packed >> 16) & 0xff;
  const g = (packed >> 8) & 0xff;
  const b = packed & 0xff;
  // Near-grey colours land on the 24-step ramp, which is much finer than the
  // cube's 6 levels per channel.
  if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && Math.abs(r - b) < 12) {
    const lvl = Math.round((((r + g + b) / 3) - 8) / 10);
    if (lvl <= 0) return 16;
    if (lvl >= 23) return 231;
    return 232 + lvl;
  }
  const q = (v: number): number => {
    if (v < 48) return 0;
    if (v < 115) return 1;
    return Math.min(5, Math.round((v - 35) / 40));
  };
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}
