/**
 * Moebius strip.
 *
 * Point-sampled rather than triangulated. At terminal resolution the whole strip
 * spans maybe 40 pixels across, so a mesh fine enough to look smooth has quads
 * narrower than a pixel — and a scanline filler only lights pixels whose centre
 * falls inside a triangle, so most of them vanish. Sampling the surface densely
 * and letting the z-buffer sort it out has no such gap.
 *
 * Normals are analytic (the cross product of the two partial derivatives) with
 * the per-ring trigonometry hoisted out of the inner loop. Shading is
 * two-sided, because the surface has only one side to shade: follow the bright
 * band around once and it returns on what looks like the opposite face.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';
import { camera, lambert, project, rot3sc, sincos } from '../core/raster.ts';

// Outer radius is 1 + HALFW = 1.42.
const cam = camera(4.0, 2.4, 0.9);
const NU = 900;
const NV = 34;
const HALFW = 0.42;

const sc = new Float32Array(6);
const p = new Float32Array(3);
const n = new Float32Array(3);
const s = new Float32Array(3);
const rgb = new Float32Array(3);

export const mobius: Scene = {
  id: 'mobius',
  title: 'mobius strip',
  blurb: 'one-sided surface, double-sided shading',
  mode: 'ascii',
  ramp: ' .,-~:;=!*#$@',

  render(c: Canvas, env: SceneEnv): void {
    c.clear();
    const t = env.t;
    sincos(sc, 1.02 + Math.sin(t * 0.19) * 0.33, t * 0.45, t * 0.12);
    // A bright band travels along the strip. One lap brings it back on the
    // apparent other face, which is the whole point of the shape.
    const band = (t * 0.11) % 1;

    for (let iu = 0; iu < NU; iu++) {
      const frac = iu / NU;
      const u = frac * Math.PI * 2;
      const cu = Math.cos(u);
      const su = Math.sin(u);
      const ch = Math.cos(u * 0.5);
      const sh = Math.sin(u * 0.5);

      // Distance from the band's centre, measured cyclically.
      const bd = Math.abs(((frac - band + 1.5) % 1) - 0.5);
      const boost = bd > 0.455 ? (bd - 0.455) * 11 : 0;

      for (let iv = 0; iv <= NV; iv++) {
        const v = (iv / NV - 0.5) * 2 * HALFW;
        const r = 1 + v * ch;
        const rp = -0.5 * v * sh; // dr/du

        // Surface point.
        rot3sc(p, r * cu, r * su, v * sh, sc);
        if (!project(c, cam, p[0], p[1], p[2], s)) continue;
        const px = s[0] | 0;
        const py = s[1] | 0;
        if (!c.zTest(px, py, s[2])) continue;

        // Partials, then normal = dS/du x dS/dv.
        const ux = rp * cu - r * su;
        const uy = rp * su + r * cu;
        const uz = 0.5 * v * ch;
        const vx = ch * cu;
        const vy = ch * su;
        const vz = sh;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        rot3sc(n, nx / len, ny / len, nz / len, sc);

        // Two-sided: whichever face is turned towards the light gets lit, the
        // other retains a dimmer sheen so the strip never disappears.
        const front = lambert(n[0], n[1], n[2]);
        const back = lambert(-n[0], -n[1], -n[2]) * 0.5;
        let shade = 0.12 + 0.88 * Math.max(front, back);
        if (boost > 0) shade = Math.min(1, shade + boost);

        env.palette.sample(0.1 + shade * 0.9, rgb, 0);
        c.set(px, py, shade, rgb[0], rgb[1], rgb[2]);
      }
    }
  },
};
