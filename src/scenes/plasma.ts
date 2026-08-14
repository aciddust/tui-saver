/**
 * Plasma — the oldest trick in the demo book: sum a handful of sine fields with
 * incommensurate frequencies and read the result through a cyclic palette.
 * Cheap per pixel, and in half-block mode every pixel gets its own colour.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';

const rgb = new Float32Array(3);

export const plasma: Scene = {
  id: 'plasma',
  title: 'plasma',
  blurb: 'interfering sine fields through a cyclic palette',
  mode: 'half',

  render(c: Canvas, env: SceneEnv): void {
    const t = env.t;
    // Scale the field to the shorter axis so the pattern keeps its proportions
    // whatever the terminal size.
    const k = 6.0 / Math.min(c.pw, c.ph);
    const cx = c.cx;
    const cy = c.cy;
    const wx = Math.sin(t * 0.21) * 2.2;
    const wy = Math.cos(t * 0.17) * 2.2;

    for (let y = 0; y < c.ph; y++) {
      const fy = (y - cy) * k / c.ys;
      for (let x = 0; x < c.pw; x++) {
        const fx = (x - cx) * k;
        let v = Math.sin(fx * 1.7 + t * 1.1);
        v += Math.sin(fy * 1.3 - t * 0.9);
        v += Math.sin((fx + fy) * 0.9 + t * 0.7);
        v += Math.sin(Math.hypot(fx - wx, fy - wy) * 2.1 - t * 1.6);
        v += Math.sin(Math.hypot(fx + wy, fy + wx) * 1.4 + t * 1.2);
        // Five unit sines land in -5..5; fold to 0..1 and let the palette wrap.
        const u = v * 0.1 + 0.5;
        env.palette.sample(u, rgb, 0);
        // Slight luminance modulation keeps ascii mode readable too.
        const l = 0.55 + 0.45 * Math.sin(v * 1.3);
        c.set(x, y, l, rgb[0], rgb[1], rgb[2]);
      }
    }
  },
};
