/**
 * Mandelbrot zoom.
 *
 * Dives towards a point on the boundary, resets, and dives again. Two details
 * do the heavy lifting:
 *
 *  - Smooth (continuous) escape colouring, mu = n + 1 - log2(log|z|), which
 *    removes the banding that integer iteration counts produce.
 *  - The iteration budget grows with the zoom depth, because near the boundary
 *    a fixed budget starts reporting "inside" for points that do escape, and
 *    the picture turns into a black blob.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';

/** Seahorse valley: deep, detailed, and stable to dive into. */
const TX = -0.7436438870371587;
const TY = 0.1318259042053119;

const CYCLE = 34; // seconds per dive
const rgb = new Float32Array(3);
const LOG2 = Math.log(2);

export const mandelbrot: Scene = {
  id: 'mandelbrot',
  title: 'mandelbrot',
  blurb: 'endless dive into the seahorse valley',
  mode: 'half',

  render(c: Canvas, env: SceneEnv): void {
    const phase = (env.t % CYCLE) / CYCLE;
    // Exponential zoom: linear in the exponent means constant apparent speed.
    const zoom = Math.exp(phase * 12) * 1.3;
    const span = 3.2 / zoom;
    // Capped: interior pixels always burn the full budget, and past ~420 the
    // frame time starts showing in a terminal.
    const maxIter = Math.min(420, 90 + Math.floor(Math.log2(zoom) * 30));
    const drift = env.t * 0.06;

    const pw = c.pw;
    const ph = c.ph;
    const aspect = pw / (ph / c.ys);
    const halfW = span * 0.5;
    const halfH = halfW / aspect;
    // Fade in from a wide view at the start of each dive so the reset does not
    // read as a jump cut.
    const intro = Math.min(1, phase * 22);
    const outro = Math.min(1, (1 - phase) * 14);
    const vignette = Math.min(intro, outro);

    for (let y = 0; y < ph; y++) {
      const ci = TY + ((y + 0.5) / ph - 0.5) * 2 * halfH;
      for (let x = 0; x < pw; x++) {
        const cr = TX + ((x + 0.5) / pw - 0.5) * 2 * halfW;

        let zr = 0;
        let zi = 0;
        let zr2 = 0;
        let zi2 = 0;
        let n = 0;
        // Escape radius 2 is enough for correctness, but a larger bailout makes
        // the smooth-iteration estimate noticeably cleaner.
        while (n < maxIter && zr2 + zi2 < 256) {
          zi = 2 * zr * zi + ci;
          zr = zr2 - zi2 + cr;
          zr2 = zr * zr;
          zi2 = zi * zi;
          n++;
        }

        if (n >= maxIter) {
          c.set(x, y, 0, 0, 0, 0);
          continue;
        }
        const mag2 = zr2 + zi2;
        const mu = n + 1 - Math.log(0.5 * Math.log(mag2)) / LOG2;
        env.palette.sample((mu * 0.018 + drift) % 1, rgb, 0);
        // Brightness bands on the smooth iteration count, not a ramp that
        // saturates. A ramp puts every deep-exterior pixel at full brightness,
        // which leaves the structure visible only through hue — and therefore
        // invisible in ascii or mono mode. Drifting the phase makes the bands
        // flow outward as the zoom proceeds.
        const band = 0.5 + 0.5 * Math.cos(mu * 0.5 - env.t * 1.1);
        const l = (0.22 + 0.78 * band) * vignette;
        c.set(x, y, l, rgb[0], rgb[1], rgb[2]);
      }
    }
  },
};
