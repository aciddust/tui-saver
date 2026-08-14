/**
 * Metaballs.
 *
 * Each blob contributes r^2/d^2 to a scalar field; summing them makes nearby
 * blobs merge into one smooth mass. Rather than drawing a single hard contour
 * we band the field, which turns the merge into visible level curves — much
 * more legible in a character grid than a flat silhouette would be.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';

const N = 7;
const rgb = new Float32Array(3);

// Each blob rides its own Lissajous path so the group never settles into a loop
// short enough to notice.
const PATHS = [
  { ax: 0.62, ay: 0.44, fx: 0.31, fy: 0.43, px: 0.0, py: 1.1, r: 0.30 },
  { ax: 0.52, ay: 0.58, fx: 0.47, fy: 0.29, px: 2.1, py: 0.3, r: 0.26 },
  { ax: 0.70, ay: 0.36, fx: 0.23, fy: 0.53, px: 4.2, py: 2.7, r: 0.22 },
  { ax: 0.40, ay: 0.62, fx: 0.59, fy: 0.37, px: 1.3, py: 5.0, r: 0.24 },
  { ax: 0.66, ay: 0.50, fx: 0.19, fy: 0.61, px: 5.6, py: 3.4, r: 0.19 },
  { ax: 0.30, ay: 0.30, fx: 0.71, fy: 0.67, px: 3.0, py: 4.4, r: 0.16 },
  { ax: 0.74, ay: 0.22, fx: 0.37, fy: 0.83, px: 0.7, py: 2.0, r: 0.14 },
];

const bx = new Float32Array(N);
const by = new Float32Array(N);
const br = new Float32Array(N);

export const metaballs: Scene = {
  id: 'metaballs',
  title: 'metaballs',
  blurb: 'blobby implicit surfaces merging and splitting',
  mode: 'half',

  render(c: Canvas, env: SceneEnv): void {
    const t = env.t;
    const R = c.radius;
    for (let i = 0; i < N; i++) {
      const p = PATHS[i];
      bx[i] = c.cx + Math.sin(t * p.fx + p.px) * p.ax * R;
      by[i] = c.cy + Math.sin(t * p.fy + p.py) * p.ay * R * c.ys;
      // Gentle breathing so blobs pop in and out of merging range.
      br[i] = p.r * R * (0.85 + 0.15 * Math.sin(t * 0.7 + i));
    }

    for (let y = 0; y < c.ph; y++) {
      for (let x = 0; x < c.pw; x++) {
        let f = 0;
        for (let i = 0; i < N; i++) {
          const dx = x - bx[i];
          const dy = (y - by[i]) / c.ys;
          const d2 = dx * dx + dy * dy + 1;
          f += (br[i] * br[i]) / d2;
        }
        // Cutoff, not a true isosurface: the 1/d^2 tail reaches everywhere, and
        // letting it render leaves a washed-out halo over the whole frame.
        if (f < 0.6) {
          c.set(x, y, 0, 0, 0, 0);
          continue;
        }
        // log keeps the bands evenly spaced despite the 1/d^2 falloff.
        const g = Math.log(f) * 0.9 + 0.5;
        const band = g % 1;
        const l = Math.min(1, 0.2 + Math.min(1, g * 0.5) * (0.35 + band * 0.65));
        env.palette.sample(0.15 + Math.min(1, g * 0.42) * 0.85, rgb, 0);
        c.set(x, y, l, rgb[0], rgb[1], rgb[2]);
      }
    }
  },
};
