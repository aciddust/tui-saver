/**
 * Hilbert curve.
 *
 * Draws the space-filling curve one segment at a time, then steps up an order
 * and starts again — so you watch the same shape refine itself from 4 cells to
 * 4096 while never crossing itself. The index-to-coordinate mapping is the
 * standard bit-twiddling one, which means no recursion and no stored point list.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';
import { lineAA } from '../core/raster.ts';

const MIN_ORDER = 2;
const ORDER_CEILING = 6;
const PERIOD = 10; // seconds per order
/**
 * Pixels a grid cell needs before neighbouring passes of the curve stop fusing
 * into a solid block. Braille packs four rows into a character, so anything
 * tighter than this reads as fill rather than as a line.
 */
const MIN_CELL_PX = 3.2;
const rgb = new Float32Array(3);
const pt = new Int32Array(2);

/** Hilbert index -> (x, y) on an n x n grid, n a power of two. */
function d2xy(n: number, d: number, out: Int32Array): void {
  let t = d;
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & (t >> 1);
    const ry = 1 & (t ^ rx);
    // Rotate the quadrant so the sub-curves join end to end.
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const swap = x;
      x = y;
      y = swap;
    }
    x += s * rx;
    y += s * ry;
    t >>= 2;
  }
  out[0] = x;
  out[1] = y;
}

export const hilbert: Scene = {
  id: 'hilbert',
  title: 'hilbert curve',
  blurb: 'space-filling curve drawing itself, refining order by order',
  mode: 'braille',

  render(c: Canvas, env: SceneEnv): void {
    c.clear();
    // How deep we can usefully go depends on the terminal: a small window tops
    // out at order 4, a large one reaches 6.
    const maxOrder = Math.max(
      MIN_ORDER + 1,
      Math.min(ORDER_CEILING, Math.floor(Math.log2((c.radius * 1.8) / MIN_CELL_PX))),
    );
    const orders = maxOrder - MIN_ORDER + 1;
    const slot = Math.floor(env.t / PERIOD) % orders;
    const order = MIN_ORDER + slot;
    const phase = (env.t % PERIOD) / PERIOD;

    const n = 1 << order;
    const total = n * n;
    // Three quarters of the slot draws, the rest holds the finished curve.
    const drawn = Math.min(total, Math.floor((phase / 0.75) * total) + 1);

    const R = c.radius * 0.9;
    const cell = (R * 2) / n;
    const ox = c.cx - R + cell * 0.5;
    const oy = c.cy - R * c.ys + cell * c.ys * 0.5;

    let px = 0;
    let py = 0;
    for (let i = 0; i < drawn; i++) {
      d2xy(n, i, pt);
      const x = ox + pt[0] * cell;
      const y = oy + pt[1] * cell * c.ys;
      if (i > 0) {
        const u = i / total;
        env.palette.sample(0.15 + u * 0.8, rgb, 0);
        // The freshly drawn tip is brighter, fading back along the tail.
        const recency = 1 - Math.min(1, (drawn - i) / Math.max(24, total * 0.12));
        const l = 0.42 + recency * 0.58;
        lineAA(c, px, py, x, y, l, rgb[0], rgb[1], rgb[2]);
      }
      px = x;
      py = y;
    }
  },
};
