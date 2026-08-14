/**
 * Strange attractors.
 *
 * A few thousand particles integrate the same ODE from different starting
 * points. Because the flow is chaotic they never converge, but they all stay on
 * the attractor, so the cloud traces out its shape. Light accumulates into a
 * persistent glow buffer that decays every frame — that exponential decay is
 * what produces the comet-tail look; drawing only the current positions gives a
 * flat dust cloud instead.
 *
 * Hue follows local speed, so the fast outer sweeps read differently from the
 * slow turns near the fixed points.
 */

import type { Canvas } from '../core/canvas.ts';
import { type Scene, type SceneEnv, sizedBuffer } from '../core/scene.ts';
import { Rng } from '../core/noise.ts';

export type AttractorSpec = {
  id: string;
  title: string;
  blurb: string;
  /** Integration step. Stiffer systems need smaller steps. */
  dt: number;
  /** World-space scale factor applied before projection. */
  scale: number;
  /** Centre offset subtracted before scaling. */
  center: readonly [number, number, number];
  /** Radius of the initial random cloud. */
  spread: number;
  seed: readonly [number, number, number];
  /** Speed value that maps to the top of the palette. */
  vmax: number;
  deriv(x: number, y: number, z: number, out: Float32Array): void;
};

const LORENZ: AttractorSpec = {
  id: 'lorenz',
  title: 'lorenz attractor',
  blurb: 'the butterfly — sigma 10, rho 28, beta 8/3',
  dt: 0.0035,
  scale: 0.042,
  center: [0, 0, 25],
  spread: 0.9,
  seed: [0.1, 0.0, 20],
  vmax: 260,
  deriv(x, y, z, out): void {
    out[0] = 10 * (y - x);
    out[1] = x * (28 - z) - y;
    out[2] = x * y - (8 / 3) * z;
  },
};

const AIZAWA: AttractorSpec = {
  id: 'aizawa',
  title: 'aizawa attractor',
  blurb: 'a spindle wound with a torus',
  dt: 0.006,
  scale: 0.62,
  center: [0, 0, 0.4],
  spread: 0.15,
  seed: [0.1, 0.0, 0.0],
  vmax: 3.2,
  deriv(x, y, z, out): void {
    const a = 0.95;
    const b = 0.7;
    const c = 0.6;
    const d = 3.5;
    const e = 0.25;
    const f = 0.1;
    out[0] = (z - b) * x - d * y;
    out[1] = d * x + (z - b) * y;
    out[2] = c + a * z - (z * z * z) / 3 - (x * x + y * y) * (1 + e * z) + f * z * x * x * x;
  },
};

const THOMAS: AttractorSpec = {
  id: 'thomas',
  title: 'thomas attractor',
  blurb: 'cyclically symmetric, three-fold and looping',
  dt: 0.02,
  scale: 0.26,
  center: [0, 0, 0],
  spread: 1.4,
  seed: [0.6, 0.2, 0.1],
  vmax: 3.0,
  deriv(x, y, z, out): void {
    const b = 0.19;
    out[0] = Math.sin(y) - b * x;
    out[1] = Math.sin(z) - b * y;
    out[2] = Math.sin(x) - b * z;
  },
};

const COUNT = 700;
const SUBSTEPS = 5;
/** Light added per particle per frame, spread over four bilinear corners. */
const DEPOSIT = 0.12;
/** Fraction of trail light surviving one second. */
const TRAIL_RETENTION = 0.15;
/**
 * Tone curve exponent applied to light normalised against the frame's own peak.
 *
 * Absolute brightness is the wrong thing to tune here: the settled value of a
 * pixel depends on particle count, frame rate and canvas size all at once, and
 * any fixed gain that looks right in one terminal fills in solid in another.
 * Normalising against the running peak makes the *relative* density of the sheet
 * the thing being drawn, which is where the structure actually lives.
 */
const GAMMA = 0.62;
/** Integration steps run at seed time so particles start on the attractor. */
const BURN_IN = 600;

/**
 * Builds a scene for one attractor. Each gets its own particle and glow state,
 * so switching between them mid-playlist does not smear one into the next.
 */
function makeAttractor(spec: AttractorSpec): Scene {
  const xs = new Float32Array(COUNT);
  const ys = new Float32Array(COUNT);
  const zs = new Float32Array(COUNT);
  const d = new Float32Array(3);
  const rgb = new Float32Array(3);
  let glow: Float32Array | null = null;
  let hueBuf: Float32Array | null = null;
  let seeded = false;
  let peak = 0.2;

  const seedParticles = (): void => {
    const rng = new Rng(0x1234567 ^ spec.id.length * 7919);
    for (let i = 0; i < COUNT; i++) {
      xs[i] = spec.seed[0] + rng.range(-spec.spread, spec.spread);
      ys[i] = spec.seed[1] + rng.range(-spec.spread, spec.spread);
      zs[i] = spec.seed[2] + rng.range(-spec.spread, spec.spread);
    }
    // Burn in before the first frame. Starting from a random blob and drawing
    // immediately shows the transient — particles falling onto the attractor —
    // rather than the attractor itself, and for the slower systems that
    // transient outlasts the scene's whole turn in the playlist.
    for (let i = 0; i < COUNT; i++) {
      let x = xs[i];
      let y = ys[i];
      let z = zs[i];
      // Stagger the burn-in length so particles end up spread along the flow
      // instead of bunched at the same phase.
      const steps = BURN_IN + ((i * 7919) % BURN_IN);
      for (let s = 0; s < steps; s++) {
        spec.deriv(x, y, z, d);
        x += d[0] * spec.dt;
        y += d[1] * spec.dt;
        z += d[2] * spec.dt;
      }
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        xs[i] = x;
        ys[i] = y;
        zs[i] = z;
      }
    }
    seeded = true;
  };

  return {
    id: spec.id,
    title: spec.title,
    blurb: spec.blurb,
    // Half-block, not braille. Braille has four times the resolution but only
    // one bit of coverage per dot, so a dense cloud like this either clears the
    // threshold and fills solid or falls under it and vanishes. Half-blocks
    // carry a full colour per pixel, which is what lets the density gradient
    // across the sheet actually show.
    mode: 'half',

    reset(): void {
      seeded = false;
      glow = null;
      hueBuf = null;
      peak = 0.2;
    },

    render(c: Canvas, env: SceneEnv): void {
      if (!seeded) seedParticles();
      const n = c.pw * c.ph;
      const [g, freshG] = sizedBuffer(glow, n);
      const [h, freshH] = sizedBuffer(hueBuf, n);
      glow = g;
      hueBuf = h;
      if (freshG) g.fill(0);
      if (freshH) h.fill(0);

      // Frame-rate independent decay: the trail should last the same wall-clock
      // time whether we are running at 20 or 60 fps.
      const keep = Math.pow(TRAIL_RETENTION, env.dt);
      for (let i = 0; i < n; i++) g[i] *= keep;

      const t = env.t;
      const yaw = t * 0.24;
      const sy = Math.sin(yaw);
      const cy = Math.cos(yaw);
      const pitch = 0.25 + Math.sin(t * 0.13) * 0.3;
      const sp = Math.sin(pitch);
      const cp = Math.cos(pitch);
      const R = c.radius;
      const cx = c.cx;
      const cyp = c.cy;
      const pw = c.pw;
      const ph = c.ph;
      const ys2 = c.ys;

      // Deposits one bilinear corner and blends its hue in proportion to the
      // light it contributed. Declared here so it closes over this frame's
      // buffers rather than allocating tuples in the particle loop.
      const deposit = (off: number, w: number, speed: number): void => {
        const add = DEPOSIT * w;
        if (add <= 0) return;
        const next = g[off] + add;
        h[off] += (speed - h[off]) * (add / next);
        g[off] = next > 2 ? 2 : next;
      };

      for (let i = 0; i < COUNT; i++) {
        let x = xs[i];
        let y = ys[i];
        let z = zs[i];
        let vx = 0;
        let vy = 0;
        let vz = 0;
        for (let s = 0; s < SUBSTEPS; s++) {
          spec.deriv(x, y, z, d);
          vx = d[0];
          vy = d[1];
          vz = d[2];
          x += vx * spec.dt;
          y += vy * spec.dt;
          z += vz * spec.dt;
        }
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          x = spec.seed[0];
          y = spec.seed[1];
          z = spec.seed[2];
        }
        xs[i] = x;
        ys[i] = y;
        zs[i] = z;

        const wx = (x - spec.center[0]) * spec.scale;
        const wy = (y - spec.center[1]) * spec.scale;
        const wz = (z - spec.center[2]) * spec.scale;
        // Orbit the camera around the attractor's vertical axis.
        const rx = wx * cy + wz * sy;
        const rz = -wx * sy + wz * cy;
        const ry = wy * cp - rz * sp;
        const px = cx + rx * R * 0.82;
        const py = cyp + ry * R * 0.82 * ys2;
        const speed = Math.min(1, Math.hypot(vx, vy, vz) / spec.vmax);

        // Bilinear additive deposit, straight into the glow buffers.
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        if (x0 < 0 || y0 < 0 || x0 + 1 >= pw || y0 + 1 >= ph) continue;
        const fx = px - x0;
        const fy = py - y0;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const i00 = y0 * pw + x0;
        deposit(i00, w00, speed);
        deposit(i00 + 1, w10, speed);
        deposit(i00 + pw, w01, speed);
        deposit(i00 + pw + 1, w11, speed);
      }

      // Normalise against a smoothed peak so the tone curve tracks whatever
      // density this system, terminal and frame rate happen to produce.
      let frameMax = 0;
      for (let i = 0; i < n; i++) if (g[i] > frameMax) frameMax = g[i];
      peak += (frameMax - peak) * 0.1;
      const norm = 1 / Math.max(0.02, peak);

      for (let i = 0; i < n; i++) {
        const v = g[i];
        if (v <= 0.006) {
          c.lum[i] = 0;
          continue;
        }
        const l = Math.min(1, Math.pow(v * norm, GAMMA));
        env.palette.sample(0.18 + h[i] * 0.8, rgb, 0);
        const j = i * 3;
        c.lum[i] = l;
        c.col[j] = rgb[0];
        c.col[j + 1] = rgb[1];
        c.col[j + 2] = rgb[2];
      }
    },
  };
}

export const lorenz = makeAttractor(LORENZ);
export const aizawa = makeAttractor(AIZAWA);
export const thomas = makeAttractor(THOMAS);
