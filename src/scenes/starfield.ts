/**
 * Warp starfield.
 *
 * Stars fly past the camera; each is drawn as a streak from where it was last
 * frame to where it is now, so speed shows up as trail length rather than as
 * motion blur we would have to fake. Every so often the field builds into a
 * warp burst and then settles again.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';
import { Rng } from '../core/noise.ts';
import { camera, lineAA, project } from '../core/raster.ts';

const COUNT = 1500;
const FAR = 9;
const NEAR = 0.12;
const cam = camera(0, 1.5, 1.0);

const xs = new Float32Array(COUNT);
const ys = new Float32Array(COUNT);
const zs = new Float32Array(COUNT);
const mag = new Float32Array(COUNT);
const hue = new Float32Array(COUNT);

const a = new Float32Array(3);
const b = new Float32Array(3);
const rgb = new Float32Array(3);
let seeded = false;

function spawn(rng: Rng, i: number, z: number): void {
  // Uniform in a disc so density stays even as stars approach.
  const ang = rng.next() * Math.PI * 2;
  const rad = Math.sqrt(rng.next()) * 3.4 + 0.06;
  xs[i] = Math.cos(ang) * rad;
  ys[i] = Math.sin(ang) * rad;
  zs[i] = z;
  mag[i] = 0.35 + rng.next() * 0.65;
  hue[i] = rng.next();
}

const rng = new Rng(0x5eed1234);

export const starfield: Scene = {
  id: 'starfield',
  title: 'warp starfield',
  blurb: 'stars streaking past, with periodic warp bursts',
  mode: 'braille',

  reset(): void {
    for (let i = 0; i < COUNT; i++) spawn(rng, i, NEAR + rng.next() * (FAR - NEAR));
    seeded = true;
  },

  render(c: Canvas, env: SceneEnv): void {
    if (!seeded) this.reset!(c);
    c.clear();
    const t = env.t;
    // Cruise speed with an occasional hard acceleration.
    const burst = Math.max(0, Math.sin(t * 0.21 - 1.2));
    const speed = 0.9 + Math.pow(burst, 3) * 11;
    const step = speed * env.dt;

    for (let i = 0; i < COUNT; i++) {
      const z0 = zs[i];
      let z1 = z0 - step;
      if (z1 < NEAR) {
        spawn(rng, i, FAR);
        continue;
      }
      zs[i] = z1;

      // Both endpoints of the streak, projected.
      if (!project(c, cam, xs[i], ys[i], z1, a)) continue;
      if (!project(c, cam, xs[i], ys[i], z0, b)) continue;

      // Nearer stars are brighter; the 1/z falloff alone is too aggressive.
      const near = 1 - (z1 - NEAR) / (FAR - NEAR);
      const l = Math.min(1, mag[i] * (0.18 + near * near * 1.5));
      if (l < 0.02) continue;
      env.palette.sample(0.35 + hue[i] * 0.6, rgb, 0);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      if (Math.abs(dx) < 0.8 && Math.abs(dy) < 0.8) {
        c.splat(a[0], a[1], l, rgb[0], rgb[1], rgb[2]);
      } else {
        // Spread the star's light along the streak instead of piling it up.
        lineAA(c, a[0], a[1], b[0], b[1], l * 0.55, rgb[0], rgb[1], rgb[2]);
        c.splat(a[0], a[1], l, rgb[0], rgb[1], rgb[2]);
      }
    }
  },
};
