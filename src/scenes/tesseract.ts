/**
 * Rotating tesseract — the 4-cube.
 *
 * 16 vertices at every combination of +/-1, and an edge wherever two vertices
 * differ in exactly one coordinate (32 of them). Rotation in 4D happens in
 * planes, not about axes; spinning the xy and zw planes at different rates is
 * what produces the characteristic "inner cube turning inside out" motion.
 * Then w-perspective collapses 4D to 3D and the usual camera finishes the job.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';
import { lineAA } from '../core/raster.ts';

/**
 * Distance of the 4D eye along w. Smaller exaggerates the nesting; it must stay
 * clear of the largest |w| a rotated vertex can reach (2, for a vertex whose
 * four unit coordinates rotate into a single axis) or the divide blows up.
 */
const WDIST = 3.1;

/**
 * Largest post-divide |x| any vertex can reach. A rotated vertex satisfies
 * x^2 + w^2 <= 4, so maximising x * WDIST/(WDIST - w) over that circle gives
 * ~2.6 at w ~ 1.4 — worth deriving rather than guessing, since guessing low
 * crops the figure and guessing high shrinks it.
 */
const MAX_EXTENT = 2.6;

const VERTS = new Float32Array(16 * 4);
for (let i = 0; i < 16; i++) {
  for (let k = 0; k < 4; k++) VERTS[i * 4 + k] = i & (1 << k) ? 1 : -1;
}

const EDGES: number[][] = [];
for (let i = 0; i < 16; i++) {
  for (let k = 0; k < 4; k++) {
    const j = i ^ (1 << k);
    if (j > i) EDGES.push([i, j]);
  }
}

const proj = new Float32Array(16 * 3); // px, py, w-weight
const rgb = new Float32Array(3);

/** Rotates a 4-vector in the (a,b) coordinate plane by `ang`, in place. */
function planeRot(v: Float32Array, a: number, b: number, ang: number): void {
  const s = Math.sin(ang);
  const c = Math.cos(ang);
  const va = v[a];
  const vb = v[b];
  v[a] = va * c - vb * s;
  v[b] = va * s + vb * c;
}

const v = new Float32Array(4);

export const tesseract: Scene = {
  id: 'tesseract',
  title: 'tesseract',
  blurb: '4D hypercube, rotated in the xy/zw/xw planes',
  mode: 'braille',

  render(c: Canvas, env: SceneEnv): void {
    c.clear();
    const t = env.t;
    const a1 = t * 0.43;
    const a2 = t * 0.31;
    const a3 = t * 0.19;

    for (let i = 0; i < 16; i++) {
      v[0] = VERTS[i * 4];
      v[1] = VERTS[i * 4 + 1];
      v[2] = VERTS[i * 4 + 2];
      v[3] = VERTS[i * 4 + 3];
      planeRot(v, 0, 1, a1); // xy
      planeRot(v, 2, 3, a2); // zw
      planeRot(v, 0, 3, a3); // xw
      planeRot(v, 1, 2, a3 * 0.7); // yz

      // 4D -> 3D perspective divide. The w term does all the depth work here,
      // so the 3D step is orthographic: stacking a second perspective divide on
      // top only fights the first one for a shape this symmetric.
      const k = WDIST / (WDIST - v[3]);
      proj[i * 3] = v[0] * k;
      proj[i * 3 + 1] = v[1] * k;
      // How far "out" in w the vertex sits, for colour and brightness.
      proj[i * 3 + 2] = (v[3] + 2) * 0.25;
    }

    // Fixed fit rather than per-frame auto-fit: the extent only swings between
    // 2.0 and MAX_EXTENT over a full rotation, and scaling to each frame would
    // make the whole figure breathe distractingly.
    const S = (c.radius * 0.94) / MAX_EXTENT;
    for (let i = 0; i < 16; i++) {
      proj[i * 3] = c.cx + proj[i * 3] * S;
      proj[i * 3 + 1] = c.cy + proj[i * 3 + 1] * S * c.ys;
    }

    for (const [a, b] of EDGES) {
      const w = (proj[a * 3 + 2] + proj[b * 3 + 2]) * 0.5;
      env.palette.sample(0.2 + w * 0.8, rgb, 0);
      // Nearer-in-w edges are drawn brighter so the nesting reads clearly.
      const l = 0.35 + w * 0.65;
      lineAA(c, proj[a * 3], proj[a * 3 + 1], proj[b * 3], proj[b * 3 + 1], l, rgb[0], rgb[1], rgb[2]);
    }
  },
};
