/**
 * DOOM fire.
 *
 * The 1993 algorithm, unchanged: seed the bottom row white-hot, then for every
 * cell above copy the heat from below minus a random decay, with a random
 * horizontal shift. That single random shift is what makes the flames lick
 * sideways instead of rising in columns.
 *
 * The heat buffer persists across frames, so it is reallocated whenever the
 * terminal is resized.
 */

import type { Canvas } from '../core/canvas.ts';
import { type Scene, type SceneEnv, sizedBuffer } from '../core/scene.ts';
import { hash1 } from '../core/noise.ts';

let heat: Float32Array | null = null;
let step = 0;
const rgb = new Float32Array(3);

export const fire: Scene = {
  id: 'fire',
  title: 'fire',
  blurb: 'the DOOM fire algorithm, in colour',
  mode: 'half',

  reset(): void {
    heat = null;
    step = 0;
  },

  render(c: Canvas, env: SceneEnv): void {
    const n = c.pw * c.ph;
    const [buf, fresh] = sizedBuffer(heat, n);
    heat = buf;
    if (fresh) heat.fill(0);
    const pw = c.pw;
    const ph = c.ph;
    const t = env.t;

    // Bottom row: a moving hot band rather than uniform heat, so the fire has
    // a wandering base the eye can follow.
    const base = (ph - 1) * pw;
    for (let x = 0; x < pw; x++) {
      const u = x / pw;
      const gust =
        0.62 +
        0.2 * Math.sin(u * 7.1 + t * 0.9) +
        0.18 * Math.sin(u * 17.3 - t * 1.7);
      heat[base + x] = Math.max(0, Math.min(1, gust * (0.65 + hash1(step * 7919 + x) * 0.55)));
    }

    step++;
    for (let y = ph - 2; y >= 0; y--) {
      const row = y * pw;
      const below = row + pw;
      for (let x = 0; x < pw; x++) {
        const r = hash1(step * 2654435761 + y * 65537 + x);
        const shift = ((r * 3) | 0) - 1;
        let sx = x + shift;
        if (sx < 0) sx += pw;
        else if (sx >= pw) sx -= pw;
        // Decay is stronger higher up, which shortens the flames' reach.
        const decay = (0.012 + r * 0.055) * (1 + (ph - y) / ph);
        const v = heat[below + sx] - decay;
        heat[row + x] = v > 0 ? v : 0;
      }
    }

    for (let i = 0; i < n; i++) {
      const h = heat[i];
      if (h <= 0.01) {
        c.lum[i] = 0;
        continue;
      }
      env.palette.sample(Math.pow(h, 0.75), rgb, 0);
      const j = i * 3;
      c.lum[i] = Math.min(1, 0.25 + h * 0.9);
      c.col[j] = rgb[0];
      c.col[j + 1] = rgb[1];
      c.col[j + 2] = rgb[2];
    }
  },
};
