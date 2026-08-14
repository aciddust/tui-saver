/**
 * Wireframe height field — the demoscene "rotating mesh".
 *
 * Height is a sum of a few travelling radial waves from moving sources, so the
 * interference pattern never repeats visibly. Drawn as a grid of lines with
 * brightness falling off by depth, which is what gives it the sense of a plane
 * receding into fog.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';
import { camera, lineAA, project } from '../core/raster.ts';

// Grid resolution per axis. Kept coarse on purpose: braille packs 4 rows into
// a cell, so a denser grid fuses its own lines into a solid mass instead of
// reading as a wireframe.
const N = 20;
const EXTENT = 2.0;
/**
 * Camera elevation. A shallow angle looks more dramatic but squeezes all 20 grid
 * rows into ~1.4 pixels of vertical separation each, which braille cannot
 * resolve; looking further down the plate spreads them to ~4 pixels.
 */
const PITCH_BASE = 1.0;
/**
 * How far the tilted plate reaches towards and away from the camera. Corners
 * sit at EXTENT*sqrt(2) from the centre, and the pitch foreshortens that.
 */
const REACH = EXTENT * Math.SQRT2 * Math.cos(PITCH_BASE);
/**
 * A long lens, deliberately. Placing the camera close enough to feel the
 * perspective also places it inside the plate's near edge, which magnifies the
 * near rows off screen and compresses the far ones into a solid mass.
 */
const cam = camera(9, 3.6, 0.95);

const px = new Float32Array((N + 1) * (N + 1));
const py = new Float32Array((N + 1) * (N + 1));
const pz = new Float32Array((N + 1) * (N + 1));
const vis = new Uint8Array((N + 1) * (N + 1));
const hgt = new Float32Array((N + 1) * (N + 1));
const out = new Float32Array(3);
const rgb = new Float32Array(3);

function height(x: number, z: number, t: number): number {
  let h = 0;
  // Amplitudes are generous because the camera looks well down on the plate,
  // which foreshortens height by cos(pitch).
  h += Math.sin(Math.hypot(x - Math.sin(t * 0.31) * 1.6, z - Math.cos(t * 0.23) * 1.6) * 3.1 - t * 2.4) * 0.52;
  h += Math.sin(Math.hypot(x + 1.4, z - Math.sin(t * 0.41) * 1.9) * 2.3 + t * 1.7) * 0.38;
  h += Math.sin((x + z) * 1.1 + t * 0.9) * 0.18;
  return h;
}

export const waves: Scene = {
  id: 'waves',
  title: 'wave mesh',
  blurb: 'wireframe height field of interfering ripples',
  mode: 'braille',

  render(c: Canvas, env: SceneEnv): void {
    c.clear();
    const t = env.t;
    // Slow orbit plus a gentle bob in elevation.
    const yaw = t * 0.22;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const pitch = PITCH_BASE + Math.sin(t * 0.17) * 0.14;
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);

    let hmin = Infinity;
    let hmax = -Infinity;
    for (let iz = 0; iz <= N; iz++) {
      const z0 = (iz / N - 0.5) * 2 * EXTENT;
      for (let ix = 0; ix <= N; ix++) {
        const x0 = (ix / N - 0.5) * 2 * EXTENT;
        const h = height(x0, z0, t);
        const i = iz * (N + 1) + ix;
        hgt[i] = h;
        if (h < hmin) hmin = h;
        if (h > hmax) hmax = h;
        // Yaw about y, then tilt the whole plane towards the viewer.
        const rx = x0 * cy + z0 * sy;
        const rz = -x0 * sy + z0 * cy;
        const ry = h * cp - rz * sp;
        const rz2 = h * sp + rz * cp;
        vis[i] = project(c, cam, rx, ry, rz2, out) ? 1 : 0;
        px[i] = out[0];
        py[i] = out[1];
        pz[i] = out[2];
      }
    }
    const span = Math.max(0.001, hmax - hmin);

    const link = (a: number, b: number): void => {
      if (!vis[a] || !vis[b]) return;
      const depth = (pz[a] + pz[b]) * 0.5;
      // Fade with distance, normalised to the plate's own depth extent so the
      // far edge always dissolves and the near edge is always full strength.
      const fog = Math.max(0, Math.min(1, (cam.dist + REACH - depth) / (2 * REACH)));
      const hn = ((hgt[a] + hgt[b]) * 0.5 - hmin) / span;
      env.palette.sample(0.15 + hn * 0.85, rgb, 0);
      const l = 0.34 + 0.66 * fog;
      lineAA(c, px[a], py[a], px[b], py[b], l, rgb[0], rgb[1], rgb[2]);
    };

    for (let iz = 0; iz <= N; iz++) {
      for (let ix = 0; ix <= N; ix++) {
        const i = iz * (N + 1) + ix;
        if (ix < N) link(i, i + 1);
        if (iz < N) link(i, i + N + 1);
      }
    }
  },
};
