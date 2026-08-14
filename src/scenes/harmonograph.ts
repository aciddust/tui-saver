/**
 * Harmonograph.
 *
 * Four damped pendulums — two per axis — drawn as one continuous curve. The
 * frequency ratios decide the figure and the damping makes it spiral inward, so
 * each run draws itself, tightens to a point, and is replaced by a new random
 * set of parameters.
 *
 * The curve is traced into a persistent buffer rather than redrawn per frame:
 * that is what makes it feel like ink being laid down.
 */

import type { Canvas } from '../core/canvas.ts';
import { type Scene, type SceneEnv, sizedBuffer } from '../core/scene.ts';
import { Rng } from '../core/noise.ts';

const RUN = 26; // seconds per figure
/** Ink laid down per curve segment. */
const INK = 0.11;
const rgb = new Float32Array(3);

type Pendulum = { a: number; f: number; p: number; d: number };

let pend: Pendulum[] = [];
let run = -1;
let ink: Float32Array | null = null;
let age: Float32Array | null = null;
let lastX = 0;
let lastY = 0;
let havePrev = false;

function makeRun(index: number): void {
  const rng = new Rng(0x9e37 + index * 2654435761);
  // Near-integer ratios give closed, symmetric figures; the small detuning is
  // what makes the curve precess instead of retracing itself.
  const ratio = (): number => {
    const base = 1 + Math.floor(rng.next() * 5);
    return base + (rng.next() - 0.5) * 0.02;
  };
  pend = [
    { a: 0.62, f: ratio(), p: rng.next() * 6.28, d: 0.012 + rng.next() * 0.02 },
    { a: 0.34, f: ratio(), p: rng.next() * 6.28, d: 0.012 + rng.next() * 0.02 },
    { a: 0.62, f: ratio(), p: rng.next() * 6.28, d: 0.012 + rng.next() * 0.02 },
    { a: 0.34, f: ratio(), p: rng.next() * 6.28, d: 0.012 + rng.next() * 0.02 },
  ];
  havePrev = false;
}

function curve(tt: number, out: Float32Array): void {
  const w = 1.9;
  out[0] =
    pend[0].a * Math.sin(tt * pend[0].f * w + pend[0].p) * Math.exp(-pend[0].d * tt) +
    pend[1].a * Math.sin(tt * pend[1].f * w + pend[1].p) * Math.exp(-pend[1].d * tt);
  out[1] =
    pend[2].a * Math.sin(tt * pend[2].f * w + pend[2].p) * Math.exp(-pend[2].d * tt) +
    pend[3].a * Math.sin(tt * pend[3].f * w + pend[3].p) * Math.exp(-pend[3].d * tt);
}

const pt = new Float32Array(2);

export const harmonograph: Scene = {
  id: 'harmonograph',
  title: 'harmonograph',
  blurb: 'four damped pendulums drawing themselves out',
  mode: 'braille',

  reset(): void {
    run = -1;
    ink = null;
    age = null;
    havePrev = false;
  },

  render(c: Canvas, env: SceneEnv): void {
    const n = c.pw * c.ph;
    const [ib, freshI] = sizedBuffer(ink, n);
    const [ab, freshA] = sizedBuffer(age, n);
    ink = ib;
    age = ab;
    if (freshI) ib.fill(0);
    if (freshA) ab.fill(0);

    const idx = Math.floor(env.t / RUN);
    const phase = (env.t % RUN) / RUN;
    if (idx !== run) {
      run = idx;
      makeRun(idx);
      ib.fill(0);
    }

    // Hold the finished figure briefly, then wipe it before the next one.
    if (phase > 0.88) {
      const wipe = Math.pow(0.0006, env.dt);
      for (let i = 0; i < n; i++) ib[i] *= wipe;
    }

    const R = c.radius * 0.86;
    const cx = c.cx;
    const cy = c.cy;
    // Advance the pen along the curve. Enough substeps that the trace stays a
    // line rather than a dotted path even during the fast early sweeps.
    const tEnd = (env.t % RUN) * 3.4;
    const tStart = Math.max(0, tEnd - env.dt * 3.4);
    const steps = Math.max(2, Math.ceil((tEnd - tStart) * 420));

    for (let s = 1; s <= steps; s++) {
      const tt = tStart + ((tEnd - tStart) * s) / steps;
      curve(tt, pt);
      const px = cx + pt[0] * R;
      const py = cy + pt[1] * R * c.ys;
      if (havePrev) {
        // Straight bilinear deposits along the segment; short segments keep the
        // line continuous without needing a full line routine here.
        const dx = px - lastX;
        const dy = py - lastY;
        const sub = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
        for (let k = 1; k <= sub; k++) {
          const q = k / sub;
          // Ink per segment is constant regardless of how finely it is
          // subdivided, and small enough that only the heavily retraced core
          // reaches the clamp — that contrast is the whole look.
          deposit(ib, ab, c.pw, c.ph, lastX + dx * q, lastY + dy * q, INK / sub, tt);
        }
      }
      lastX = px;
      lastY = py;
      havePrev = true;
    }

    // Hue follows how long ago the ink was laid down, which reads as the pen
    // travelling through the palette.
    const now = tEnd || 1;
    for (let i = 0; i < n; i++) {
      const v = ib[i];
      if (v <= 0.01) {
        c.lum[i] = 0;
        continue;
      }
      env.palette.sample(0.2 + Math.min(1, ab[i] / now) * 0.75, rgb, 0);
      const j = i * 3;
      c.lum[i] = Math.min(1, Math.pow(v, 0.72));
      c.col[j] = rgb[0];
      c.col[j + 1] = rgb[1];
      c.col[j + 2] = rgb[2];
    }
  },
};

function deposit(
  ink: Float32Array,
  age: Float32Array,
  pw: number,
  ph: number,
  x: number,
  y: number,
  w: number,
  tt: number,
): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= pw || y0 + 1 >= ph) return;
  const fx = x - x0;
  const fy = y - y0;
  const i00 = y0 * pw + x0;
  const put = (off: number, k: number): void => {
    const add = w * k;
    if (add <= 0) return;
    const next = ink[off] + add;
    age[off] += (tt - age[off]) * (add / next);
    ink[off] = next > 1.3 ? 1.3 : next;
  };
  put(i00, (1 - fx) * (1 - fy));
  put(i00 + 1, fx * (1 - fy));
  put(i00 + pw, (1 - fx) * fy);
  put(i00 + pw + 1, fx * fy);
}
