/**
 * Raymarched SDF scene — the expensive one.
 *
 * Three primitives orbit a common centre and are combined with a smooth minimum
 * so they melt into and out of each other, sitting on a checkered plane. Normals
 * come from a 4-tap gradient, and there is one hard shadow ray plus a cheap
 * ambient-occlusion estimate per hit.
 *
 * Cost is the whole story here, so the scene renders into an internal buffer
 * that it scales down until the frame time fits the budget, then upsamples. On a
 * fast machine in a small terminal that settles at 1:1; on a 4K-wide terminal it
 * drops to half resolution rather than dropping frames.
 */

import type { Canvas } from '../core/canvas.ts';
import { type Scene, type SceneEnv, smin } from '../core/scene.ts';

const rgb = new Float32Array(3);

const MAX_STEPS = 72;
const TMAX = 16;
const K = 0.55; // smooth-union radius

// Internal render target, kept separate from the canvas so its resolution can
// float independently.
let buf: Float32Array | null = null; // lum, r, g, b per internal pixel
let iw = 0;
let ih = 0;
let quality = 0.85; // fraction of canvas resolution
let smoothMs = 20;

/** Signed distance to the orbiting cluster. */
function objects(x: number, y: number, z: number, t: number): number {
  const a = t * 0.45;
  const orbit = 0.92;

  // Sphere.
  let dx = x - Math.cos(a) * orbit;
  let dy = y - 0.22 * Math.sin(t * 0.9);
  let dz = z - Math.sin(a) * orbit;
  let d = Math.sqrt(dx * dx + dy * dy + dz * dz) - 0.52;

  // Rounded box, spinning about its own vertical axis.
  const a2 = a + 2.0944;
  dx = x - Math.cos(a2) * orbit;
  dy = y - 0.26 * Math.sin(t * 0.7 + 1);
  dz = z - Math.sin(a2) * orbit;
  const s = Math.sin(-t * 0.8);
  const cs = Math.cos(-t * 0.8);
  const rx = dx * cs - dz * s;
  const rz = dx * s + dz * cs;
  const qx = Math.abs(rx) - 0.34;
  const qy = Math.abs(dy) - 0.34;
  const qz = Math.abs(rz) - 0.34;
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  const oz = qz > 0 ? qz : 0;
  const inner = Math.min(0, Math.max(qx, Math.max(qy, qz)));
  d = smin(d, Math.sqrt(ox * ox + oy * oy + oz * oz) + inner - 0.09, K);

  // Torus, tipped so it does not read as a flat ring.
  const a3 = a + 4.1888;
  dx = x - Math.cos(a3) * orbit;
  dy = y - 0.26 * Math.sin(t * 1.1 + 2);
  dz = z - Math.sin(a3) * orbit;
  const ts = Math.sin(t * 0.6);
  const tc = Math.cos(t * 0.6);
  const ty = dy * tc - dz * ts;
  const tz = dy * ts + dz * tc;
  const ring = Math.sqrt(dx * dx + tz * tz) - 0.4;
  d = smin(d, Math.sqrt(ring * ring + ty * ty) - 0.15, K);

  return d;
}

const FLOOR_Y = -1.05;

function map(x: number, y: number, z: number, t: number): number {
  const dObj = objects(x, y, z, t);
  const dFloor = y - FLOOR_Y;
  return dObj < dFloor ? dObj : dFloor;
}

/** Gradient by forward differences; 4 evaluations instead of 6. */
function normal(x: number, y: number, z: number, t: number, out: Float32Array): void {
  const e = 0.0015;
  const d0 = map(x, y, z, t);
  let nx = map(x + e, y, z, t) - d0;
  let ny = map(x, y + e, z, t) - d0;
  let nz = map(x, y, z + e, t) - d0;
  const len = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / len;
  out[1] = ny / len;
  out[2] = nz / len;
}

const nrm = new Float32Array(3);

export const raymarch: Scene = {
  id: 'raymarch',
  title: 'raymarched sdf',
  blurb: 'smooth-union primitives with shadow and ambient occlusion',
  mode: 'half',

  reset(): void {
    buf = null;
    quality = 0.85;
    smoothMs = 20;
  },

  render(c: Canvas, env: SceneEnv): void {
    const started = process.hrtime.bigint();
    const t = env.t;

    const wantW = Math.max(24, Math.round(c.pw * quality));
    const wantH = Math.max(12, Math.round(c.ph * quality));
    if (!buf || wantW !== iw || wantH !== ih) {
      iw = wantW;
      ih = wantH;
      buf = new Float32Array(iw * ih * 4);
    }

    // Camera: slow orbit, looking slightly down at the cluster.
    const ca = t * 0.16;
    const ex = Math.sin(ca) * 3.05;
    const ez = -Math.cos(ca) * 3.05;
    const ey = 1.15 + Math.sin(t * 0.11) * 0.4;
    const tx = 0;
    const ty = 0.05;
    const tz = 0;
    let fx = tx - ex;
    let fy = ty - ey;
    let fz = tz - ez;
    const flen = Math.hypot(fx, fy, fz) || 1;
    fx /= flen;
    fy /= flen;
    fz /= flen;
    // right = normalize(cross(worldUp, forward)) with worldUp = (0,1,0).
    let rx = fz;
    let rz = -fx;
    const rlen = Math.hypot(rx, rz) || 1;
    rx /= rlen;
    rz /= rlen;
    // up = cross(forward, right); right has no y component, so this reduces to:
    const ux = fy * rz;
    const uy = fz * rx - fx * rz;
    const uz = -fy * rx;

    const lx = 0.48;
    const ly = 0.78;
    const lz = -0.4;
    const llen = Math.hypot(lx, ly, lz);
    const Lx = lx / llen;
    const Ly = ly / llen;
    const Lz = lz / llen;

    const aspect = iw / (ih / c.ys);
    const focal = 2.05;

    for (let py = 0; py < ih; py++) {
      const sv = -((py + 0.5) / ih * 2 - 1);
      for (let px = 0; px < iw; px++) {
        const su = ((px + 0.5) / iw * 2 - 1) * aspect;
        let dx = fx * focal + rx * su + ux * sv;
        let dy = fy * focal + uy * sv;
        let dz = fz * focal + rz * su + uz * sv;
        const dl = Math.hypot(dx, dy, dz) || 1;
        dx /= dl;
        dy /= dl;
        dz /= dl;

        // March.
        let dist = 0.02;
        let hit = false;
        for (let i = 0; i < MAX_STEPS; i++) {
          const d = map(ex + dx * dist, ey + dy * dist, ez + dz * dist, t);
          if (d < 0.0016 * dist + 0.0008) {
            hit = true;
            break;
          }
          dist += d * 0.92;
          if (dist > TMAX) break;
        }

        const o = (py * iw + px) * 4;
        if (!hit) {
          // Sky: a soft vertical gradient, dark at the horizon.
          const up = Math.max(0, dy);
          env.palette.sample(0.05 + up * 0.12, rgb, 0);
          buf[o] = 0.05 + up * 0.16;
          buf[o + 1] = rgb[0];
          buf[o + 2] = rgb[1];
          buf[o + 3] = rgb[2];
          continue;
        }

        const hx = ex + dx * dist;
        const hy = ey + dy * dist;
        const hz = ez + dz * dist;
        normal(hx, hy, hz, t, nrm);
        const nx = nrm[0];
        const ny = nrm[1];
        const nz = nrm[2];

        const diff = Math.max(0, nx * Lx + ny * Ly + nz * Lz);

        // One hard shadow ray, coarse on purpose.
        let shadow = 1;
        if (diff > 0.001) {
          let sd = 0.03;
          for (let i = 0; i < 24; i++) {
            const d = map(hx + Lx * sd, hy + Ly * sd, hz + Lz * sd, t);
            if (d < 0.004) {
              shadow = 0.18;
              break;
            }
            sd += d;
            if (sd > 7) break;
          }
        }

        // Ambient occlusion: how much closer the surface is than free space at
        // increasing offsets along the normal.
        let ao = 0;
        let sca = 1;
        for (let i = 1; i <= 5; i++) {
          const h = 0.02 + 0.11 * i;
          const d = map(hx + nx * h, hy + ny * h, hz + nz * h, t);
          ao += (h - d) * sca;
          sca *= 0.72;
        }
        ao = Math.max(0, Math.min(1, 1 - 2.4 * ao));

        // Specular, Blinn-style with the view direction.
        const hxv = Lx - dx;
        const hyv = Ly - dy;
        const hzv = Lz - dz;
        const hl = Math.hypot(hxv, hyv, hzv) || 1;
        const spec = Math.pow(Math.max(0, (nx * hxv + ny * hyv + nz * hzv) / hl), 24) * shadow;

        const onFloor = hy < FLOOR_Y + 0.02 && ny > 0.7;
        let tone: number;
        // Albedo, applied to luminance as well as palette position: a
        // checkerboard that only differs in hue disappears entirely in ascii or
        // mono mode.
        let albedo = 1;
        if (onFloor) {
          const check = ((Math.floor(hx * 1.1) + Math.floor(hz * 1.1)) & 1) === 0;
          tone = check ? 0.26 : 0.1;
          albedo = check ? 1 : 0.55;
        } else {
          // Colour by facing direction so the melted cluster still reads as
          // three distinct volumes.
          tone = 0.5 + nx * 0.16 + nz * 0.16 + ny * 0.1;
        }
        env.palette.sample(tone, rgb, 0);

        const ambient = 0.14 * ao * (0.5 + 0.5 * ny);
        let l = (ambient + diff * shadow * 0.9) * albedo + spec * 0.5;
        // Distance fog towards the sky value.
        const fog = Math.min(1, Math.max(0, (dist - 3.4) / 9));
        l = l * (1 - fog) + 0.07 * fog;

        buf[o] = Math.min(1, l);
        buf[o + 1] = rgb[0];
        buf[o + 2] = rgb[1];
        buf[o + 3] = rgb[2];
      }
    }

    // Upsample (nearest) onto the canvas.
    const sxr = iw / c.pw;
    const syr = ih / c.ph;
    for (let y = 0; y < c.ph; y++) {
      const iy = Math.min(ih - 1, (y * syr) | 0);
      for (let x = 0; x < c.pw; x++) {
        const ix = Math.min(iw - 1, (x * sxr) | 0);
        const o = (iy * iw + ix) * 4;
        c.set(x, y, buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
      }
    }

    // Adapt resolution, smoothed so it does not hunt between two levels.
    //
    // The band is deliberately well under the frame budget: this measures only
    // the march, and the frame still has to rasterise the canvas and diff it
    // against the last one before anything reaches the terminal.
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    smoothMs += (ms - smoothMs) * 0.25;
    if (smoothMs > 19 && quality > 0.35) quality = Math.max(0.35, quality - 0.05);
    else if (smoothMs < 11 && quality < 1) quality = Math.min(1, quality + 0.03);
  },
};
