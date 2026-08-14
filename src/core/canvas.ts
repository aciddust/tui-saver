/**
 * The pixel layer.
 *
 * Scenes never touch characters. They draw into a sub-character pixel grid and
 * the Canvas turns that into cells according to the active render mode:
 *
 *   braille  2x4 pixels per cell, 1-bit coverage, one colour per cell
 *   half     1x2 pixels per cell, full colour (fg = top, bg = bottom via U+2580)
 *   ascii    1x1 pixel per cell, luminance mapped onto a character ramp
 *
 * Because a terminal cell is roughly twice as tall as it is wide, braille and
 * half-block pixels come out square while ascii pixels do not — `ys` carries
 * that correction so a scene can draw a circle that actually looks round.
 */

import { clamp01, pack } from './color.ts';

export type RenderMode = 'braille' | 'half' | 'ascii';
export const RENDER_MODES: RenderMode[] = ['braille', 'half', 'ascii'];

export const RAMPS: Record<string, string> = {
  classic: ' .,-~:;=!*#$@',
  soft: ' .:-=+*#%@',
  blocks: ' ░▒▓█',
  dense:
    ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
};

const HALF_BLOCK = 0x2580; // U+2580 UPPER HALF BLOCK
const BRAILLE_BASE = 0x2800;

/**
 * Braille dot bit layout, indexed [row][col]. The Unicode block numbers dots
 * 1-6 down the two columns first and only then adds 7/8 at the bottom, which is
 * why the last row's bits are 0x40/0x80 rather than continuing the pattern.
 */
const BRAILLE_BITS: readonly (readonly number[])[] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export type CellBuffer = {
  cols: number;
  rows: number;
  /** UTF-32 code point per cell. */
  ch: Uint32Array;
  /** Packed 0xRRGGBB, or -1 for the terminal default. */
  fg: Int32Array;
  bg: Int32Array;
};

export function makeCells(cols: number, rows: number): CellBuffer {
  const n = cols * rows;
  const cb: CellBuffer = {
    cols,
    rows,
    ch: new Uint32Array(n),
    fg: new Int32Array(n),
    bg: new Int32Array(n),
  };
  cb.ch.fill(32);
  cb.fg.fill(-1);
  cb.bg.fill(-1);
  return cb;
}

export class Canvas {
  cols = 0;
  rows = 0;
  mode: RenderMode = 'braille';

  /** Pixel-grid dimensions. */
  pw = 0;
  ph = 0;
  /** Pixels per cell. */
  sx = 1;
  sy = 1;
  /**
   * Multiply y by this when converting from "square world units" to pixels.
   * 1 where pixels are square, 0.5 in ascii mode where they are twice as tall.
   */
  ys = 1;

  lum!: Float32Array;
  col!: Float32Array;
  depth!: Float32Array;

  /** Coverage cutoff for braille dots. */
  dotThreshold = 0.32;
  ramp = RAMPS.classic;

  constructor(cols: number, rows: number, mode: RenderMode) {
    this.configure(cols, rows, mode);
  }

  configure(cols: number, rows: number, mode: RenderMode): void {
    const sx = mode === 'braille' ? 2 : 1;
    const sy = mode === 'braille' ? 4 : mode === 'half' ? 2 : 1;
    const pw = cols * sx;
    const ph = rows * sy;
    const changed = pw !== this.pw || ph !== this.ph;
    this.cols = cols;
    this.rows = rows;
    this.mode = mode;
    this.sx = sx;
    this.sy = sy;
    this.pw = pw;
    this.ph = ph;
    // A cell is ~1 wide by ~2 tall, so one pixel measures (1/sx) by (2/sy).
    // Converting world units to pixels therefore costs sx in x and sy/2 in y;
    // ys is that ratio, so pixelY = cy + worldY * radius * ys.
    this.ys = sy / (2 * sx);
    if (changed) {
      this.lum = new Float32Array(pw * ph);
      this.col = new Float32Array(pw * ph * 3);
      this.depth = new Float32Array(pw * ph);
    }
  }

  get cx(): number {
    return this.pw / 2;
  }

  get cy(): number {
    return this.ph / 2;
  }

  /** Shortest half-extent, the natural unit for "fit the shape on screen". */
  get radius(): number {
    return Math.min(this.pw, this.ph / this.ys) / 2;
  }

  clear(): void {
    this.lum.fill(0);
    this.col.fill(0);
    this.depth.fill(Infinity);
  }

  /**
   * Overwrites a pixel unconditionally.
   *
   * This is also the correct write after a passing `zTest`: the depth buffer has
   * already decided this pixel belongs to the caller, so a blend that could
   * reject the write on brightness would leave the nearer surface showing the
   * farther one's colour.
   */
  set(x: number, y: number, l: number, r: number, g: number, b: number): void {
    if (x < 0 || y < 0 || x >= this.pw || y >= this.ph) return;
    const i = y * this.pw + x;
    this.lum[i] = l;
    const j = i * 3;
    this.col[j] = r;
    this.col[j + 1] = g;
    this.col[j + 2] = b;
  }

  /** Accumulates light, for trails and additive particles. */
  add(x: number, y: number, l: number, r: number, g: number, b: number): void {
    if (x < 0 || y < 0 || x >= this.pw || y >= this.ph) return;
    const i = y * this.pw + x;
    const prev = this.lum[i];
    const next = prev + l;
    if (next <= 0) return;
    this.lum[i] = next > 1 ? 1 : next;
    // Weight the incoming colour by how much light it contributed.
    const w = l / next;
    const j = i * 3;
    this.col[j] += (r - this.col[j]) * w;
    this.col[j + 1] += (g - this.col[j + 1]) * w;
    this.col[j + 2] += (b - this.col[j + 2]) * w;
  }

  /**
   * Antialiased additive deposit at fractional coordinates. Curve-tracing
   * scenes (attractors, harmonographs) live or die on this.
   */
  splat(x: number, y: number, l: number, r: number, g: number, b: number): void {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    this.add(x0, y0, l * (1 - fx) * (1 - fy), r, g, b);
    this.add(x0 + 1, y0, l * fx * (1 - fy), r, g, b);
    this.add(x0, y0 + 1, l * (1 - fx) * fy, r, g, b);
    this.add(x0 + 1, y0 + 1, l * fx * fy, r, g, b);
  }

  /** Depth test against the z-buffer; records the hit when it passes. */
  zTest(x: number, y: number, z: number): boolean {
    if (x < 0 || y < 0 || x >= this.pw || y >= this.ph) return false;
    const i = y * this.pw + x;
    if (z >= this.depth[i]) return false;
    this.depth[i] = z;
    return true;
  }

  /** Converts the pixel grid into characters. */
  rasterize(out: CellBuffer): void {
    switch (this.mode) {
      case 'braille':
        this.rasterizeBraille(out);
        break;
      case 'half':
        this.rasterizeHalf(out);
        break;
      default:
        this.rasterizeAscii(out);
    }
  }

  private rasterizeAscii(out: CellBuffer): void {
    const { pw, lum, col, ramp } = this;
    const last = ramp.length - 1;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = y * pw + x;
        const o = y * out.cols + x;
        const l = lum[i];
        if (l <= 0.004) {
          out.ch[o] = 32;
          out.fg[o] = -1;
          out.bg[o] = -1;
          continue;
        }
        const step = Math.min(last, Math.max(1, Math.round(clamp01(l) * last)));
        out.ch[o] = ramp.codePointAt(step)!;
        const j = i * 3;
        out.fg[o] = pack(col[j], col[j + 1], col[j + 2]);
        out.bg[o] = -1;
      }
    }
  }

  private rasterizeHalf(out: CellBuffer): void {
    const { pw, lum, col } = this;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const top = (y * 2) * pw + x;
        const bot = (y * 2 + 1) * pw + x;
        const o = y * out.cols + x;
        const lt = lum[top];
        const lb = lum[bot];
        if (lt <= 0.004 && lb <= 0.004) {
          out.ch[o] = 32;
          out.fg[o] = -1;
          out.bg[o] = -1;
          continue;
        }
        const jt = top * 3;
        const jb = bot * 3;
        out.ch[o] = HALF_BLOCK;
        out.fg[o] = pack(col[jt] * lt, col[jt + 1] * lt, col[jt + 2] * lt);
        out.bg[o] = pack(col[jb] * lb, col[jb + 1] * lb, col[jb + 2] * lb);
      }
    }
  }

  private rasterizeBraille(out: CellBuffer): void {
    const { pw, lum, col, dotThreshold } = this;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        let bits = 0;
        let wsum = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = 0; dy < 4; dy++) {
          const row = (y * 4 + dy) * pw + x * 2;
          for (let dx = 0; dx < 2; dx++) {
            const i = row + dx;
            const l = lum[i];
            if (l < dotThreshold) continue;
            bits |= BRAILLE_BITS[dy][dx];
            const j = i * 3;
            r += col[j] * l;
            g += col[j + 1] * l;
            b += col[j + 2] * l;
            wsum += l;
          }
        }
        const o = y * out.cols + x;
        if (bits === 0) {
          out.ch[o] = 32;
          out.fg[o] = -1;
          out.bg[o] = -1;
          continue;
        }
        out.ch[o] = BRAILLE_BASE | bits;
        out.fg[o] = pack(r / wsum, g / wsum, b / wsum);
        out.bg[o] = -1;
      }
    }
  }
}
