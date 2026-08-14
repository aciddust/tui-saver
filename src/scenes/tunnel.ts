/**
 * Infinite tunnel.
 *
 * The classic mapping: polar angle becomes the texture's u, and 1/radius
 * becomes v, so texels bunch up towards the vanishing point exactly the way
 * perspective demands. Move v over time and you fly down the tube forever.
 * The centre wanders on a Lissajous path so the tunnel appears to bend.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';

const rgb = new Float32Array(3);

export const tunnel: Scene = {
  id: 'tunnel',
  title: 'tunnel',
  blurb: 'perspective-correct polar tunnel with a wandering centre',
  mode: 'half',

  render(c: Canvas, env: SceneEnv): void {
    const t = env.t;
    const R = c.radius;
    // Where the tunnel's vanishing point sits this frame.
    const cx = c.cx + Math.sin(t * 0.37) * R * 0.3;
    const cy = c.cy + Math.cos(t * 0.29) * R * 0.3 * c.ys;
    const twist = Math.sin(t * 0.19) * 1.4;
    const depth = t * 0.85;
    const RINGS = 7;
    const SLICES = 14;

    for (let y = 0; y < c.ph; y++) {
      const dy = (y + 0.5 - cy) / c.ys;
      for (let x = 0; x < c.pw; x++) {
        const dx = x + 0.5 - cx;
        const r = Math.hypot(dx, dy) / R;
        const a = Math.atan2(dy, dx) / (Math.PI * 2);

        // Guard the singularity at the exact centre.
        const v = r < 0.004 ? 250 : 0.28 / r;
        const u = a + twist * v * 0.05;

        const ring = v + depth;
        // Smooth product of two sinusoids rather than a floor-based
        // checkerboard. atan2 has a branch cut along the negative x axis where
        // the angle jumps by a full turn; a floor() of that jumps a cell index
        // and lays a visible seam across the whole tunnel. sin(2*pi*SLICES*u)
        // with an integer SLICES is unchanged by a whole-turn shift, so the
        // pattern closes on itself exactly.
        const checker =
          Math.sin(ring * RINGS * Math.PI * 2) * Math.sin(u * SLICES * Math.PI * 2);
        // Bright hoops at the ring boundaries, for a sense of passing structure.
        const hoop = Math.pow(Math.abs(Math.sin(ring * RINGS * Math.PI)), 14);
        const shade = 0.5 + 0.3 * checker + 0.35 * hoop;

        // Fog towards the vanishing point, plus a lit mouth at the near end.
        const fog = Math.min(1, r * 2.4);
        const l = Math.min(1, shade * (0.12 + 0.88 * fog));
        env.palette.sample(0.12 + (ring % 1) * 0.55 + fog * 0.3, rgb, 0);
        c.set(x, y, l, rgb[0], rgb[1], rgb[2]);
      }
    }
  },
};
