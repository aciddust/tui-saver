/**
 * Rotating Earth.
 *
 * Ray-cast rather than projected: for every pixel inside the disc we solve for
 * the point on the unit sphere, rotate it back into globe space to recover
 * lat/lon, and look that up in a coarse land mask. That gives a correct limb,
 * correct foreshortening near the edges, and a day/night terminator for free.
 *
 * The land mask is a hand-authored 72x36 grid (5 degrees per cell) stored as
 * row spans, which is far easier to eyeball and correct than a packed bitmap.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';
import { hash2 } from '../core/noise.ts';

const MAP_W = 72;
const MAP_H = 36;

/** [row, colStart, colEnd] inclusive; row 0 is 85-90N, col 0 starts at 180W. */
const LAND: readonly (readonly number[])[] = [
  // Greenland
  [1, 24, 30], [2, 22, 31], [3, 21, 32], [4, 22, 31], [5, 24, 29],
  // Iceland
  [5, 32, 33],
  // North America
  [2, 10, 20], [3, 6, 20], [4, 4, 21], [5, 3, 22], [6, 2, 23], [7, 5, 23],
  [8, 6, 24], [9, 7, 24], [10, 8, 24], [11, 9, 24], [12, 11, 23],
  [13, 13, 20], [14, 15, 21], [15, 17, 22], [16, 19, 23],
  // South America
  [16, 21, 27], [17, 20, 28], [18, 20, 29], [19, 20, 29], [20, 21, 29],
  [21, 21, 29], [22, 22, 29], [23, 23, 28], [24, 23, 27], [25, 24, 26],
  [26, 24, 26], [27, 24, 25], [28, 24, 25],
  // Africa
  [11, 33, 46], [12, 32, 47], [13, 32, 47], [14, 31, 46], [15, 32, 45],
  [16, 33, 46], [17, 34, 46], [18, 35, 44], [19, 35, 44], [20, 35, 43],
  [21, 35, 43], [22, 35, 42], [23, 36, 42], [24, 37, 41],
  // Madagascar
  [20, 45, 46], [21, 45, 46], [22, 45, 46], [23, 45, 46],
  // Eurasia
  [4, 38, 70], [5, 37, 70], [6, 35, 70], [7, 34, 69], [8, 34, 68],
  [9, 34, 66], [10, 35, 64], [11, 36, 63], [12, 43, 62], [13, 44, 61],
  [14, 48, 58], [15, 50, 58], [16, 51, 58], [17, 55, 58],
  // Indonesia
  [18, 55, 64], [19, 57, 64], [20, 60, 64],
  // Australia
  [20, 59, 66], [21, 58, 67], [22, 58, 67], [23, 58, 67], [24, 59, 66],
  [25, 61, 65],
  // New Zealand
  [25, 70, 71], [26, 70, 71], [27, 69, 70],
  // Antarctica
  [31, 0, 71], [32, 0, 71], [33, 0, 71], [34, 0, 71], [35, 0, 71],
];

const MASK = new Uint8Array(MAP_W * MAP_H);
for (const [row, c0, c1] of LAND) {
  for (let c = c0; c <= c1; c++) MASK[row * MAP_W + c] = 1;
}

const TILT = 0.41; // ~23.4 degrees
const rgb = new Float32Array(3);

export const globe: Scene = {
  id: 'globe',
  title: 'globe',
  blurb: 'ray-cast Earth with terminator and city lights',
  mode: 'half',

  render(c: Canvas, env: SceneEnv): void {
    c.clear();
    const t = env.t;
    const spin = t * 0.22;
    const sinSpin = Math.sin(spin);
    const cosSpin = Math.cos(spin);
    const sinTilt = Math.sin(TILT);
    const cosTilt = Math.cos(TILT);

    // Sun swings slowly around so the terminator sweeps across the disc.
    const sa = t * 0.09 + 0.9;
    const sx = Math.cos(sa);
    const sy = 0.22;
    const sz = Math.sin(sa);
    const slen = Math.hypot(sx, sy, sz);

    const R = c.radius * 0.74;
    const cx = c.cx;
    const cy = c.cy;
    const glow = R * 1.16;

    for (let y = 0; y < c.ph; y++) {
      const wy = (y + 0.5 - cy) / (R * c.ys);
      for (let x = 0; x < c.pw; x++) {
        const wx = (x + 0.5 - cx) / R;
        const q = wx * wx + wy * wy;

        if (q > 1) {
          // Outside the sphere: atmospheric halo close in, starfield beyond.
          const d = Math.sqrt(q);
          if (d < glow / R) {
            const a = 1 - (d - 1) / (glow / R - 1);
            env.palette.sample(0.62, rgb, 0);
            const l = a * a * 0.3;
            if (l > 0.01) c.set(x, y, l, rgb[0], rgb[1], rgb[2]);
          } else if (hash2(x, y) > 0.9975) {
            const tw = 0.45 + 0.55 * hash2(x + 991, y + 137);
            c.set(x, y, tw, 0.85, 0.88, 1);
          }
          continue;
        }

        // Point on the front of the unit sphere, in view space.
        const vz = Math.sqrt(1 - q);
        // Undo the tilt (about x), then the spin (about y), to reach globe space.
        const ty = wy * cosTilt + vz * sinTilt;
        const tz = -wy * sinTilt + vz * cosTilt;
        const gx = wx * cosSpin - tz * sinSpin;
        const gz = wx * sinSpin + tz * cosSpin;

        const lat = Math.asin(Math.max(-1, Math.min(1, ty)));
        const lon = Math.atan2(gx, gz);
        let mc = Math.floor(((lon / Math.PI + 1) * 0.5) * MAP_W);
        let mr = Math.floor((0.5 - lat / Math.PI) * MAP_H);
        if (mc < 0) mc = 0;
        if (mc >= MAP_W) mc = MAP_W - 1;
        if (mr < 0) mr = 0;
        if (mr >= MAP_H) mr = MAP_H - 1;
        const land = MASK[mr * MAP_W + mc] === 1;

        // Lambert against the sun, in view space.
        const dot = (wx * sx + wy * sy + vz * sz) / slen;
        const day = dot > 0 ? dot : 0;

        if (day > 0.015) {
          // Land sits high on the palette, ocean low; the limb darkens.
          const base = land ? 0.78 : 0.3;
          const relief = land ? hash2(mc * 7 + mr, mr * 13) * 0.12 : 0;
          env.palette.sample(base + relief, rgb, 0);
          const lit = 0.1 + 0.9 * Math.pow(day, 0.7);
          // Specular sheen on water only, which reads as ocean glint.
          const spec = land ? 0 : Math.pow(day, 26) * 0.6;
          c.set(x, y, Math.min(1, lit * (land ? 0.95 : 0.8) + spec), rgb[0], rgb[1], rgb[2]);
        } else {
          // Night side: near-black, with sparse city lights over land.
          const lit = 0.05;
          env.palette.sample(0.08, rgb, 0);
          c.set(x, y, lit, rgb[0], rgb[1], rgb[2]);
          if (land && hash2(mc * 31 + x, mr * 17 + y) > 0.93) {
            c.set(x, y, 0.5 + hash2(x, y * 3) * 0.5, 1.0, 0.82, 0.42);
          }
        }
      }
    }
  },
};
