/**
 * The donut. Point-sampled parametric torus with a z-buffer and Lambert
 * shading — the same idea as the famous donut.c, but writing into the shared
 * canvas so it inherits colour and every render mode.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';
import { camera, lambert, project, rot3sc, sincos } from '../core/raster.ts';

const R = 1.55;
const r = 0.62;
// Tube reaches R + r = 2.17 from the origin; the lens is chosen so that
// extent * (fov/dist) * scale stays under 1, which is where the canvas edge is.
const cam = camera(4.6, 1.85, 0.9);

// Sample grids are fixed: dense enough to cover every pixel at a typical
// terminal size without the inner loop turning into a trig benchmark.
const NTHETA = 160;
const NPHI = 400;
const sinT = new Float32Array(NTHETA);
const cosT = new Float32Array(NTHETA);
const sinP = new Float32Array(NPHI);
const cosP = new Float32Array(NPHI);
for (let i = 0; i < NTHETA; i++) {
  const a = (i / NTHETA) * Math.PI * 2;
  sinT[i] = Math.sin(a);
  cosT[i] = Math.cos(a);
}
for (let i = 0; i < NPHI; i++) {
  const a = (i / NPHI) * Math.PI * 2;
  sinP[i] = Math.sin(a);
  cosP[i] = Math.cos(a);
}

const sc = new Float32Array(6);
const p = new Float32Array(3);
const n = new Float32Array(3);
const s = new Float32Array(3);
const rgb = new Float32Array(3);

export const torus: Scene = {
  id: 'torus',
  title: 'torus',
  blurb: 'the donut — shaded parametric torus, z-buffered',
  mode: 'ascii',
  ramp: ' .,-~:;=!*#$@',

  render(c: Canvas, env: SceneEnv): void {
    c.clear();
    const t = env.t;
    sincos(sc, t * 0.62, t * 0.41, t * 0.17);

    for (let i = 0; i < NTHETA; i++) {
      const ct = cosT[i];
      const st = sinT[i];
      const ring = R + r * ct;
      for (let j = 0; j < NPHI; j++) {
        const cp = cosP[j];
        const sp = sinP[j];
        rot3sc(p, ring * cp, r * st, ring * sp, sc);
        if (!project(c, cam, p[0], p[1], p[2], s)) continue;
        const px = s[0] | 0;
        const py = s[1] | 0;
        if (!c.zTest(px, py, s[2])) continue;
        rot3sc(n, ct * cp, st, ct * sp, sc);
        // A dim ambient floor keeps the unlit side present rather than a hole.
        const shade = 0.1 + 0.9 * lambert(n[0], n[1], n[2]);
        env.palette.sample(0.15 + shade * 0.85, rgb, 0);
        c.set(px, py, shade, rgb[0], rgb[1], rgb[2]);
      }
    }
  },
};
