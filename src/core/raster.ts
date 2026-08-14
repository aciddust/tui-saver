/**
 * Shared 3D helpers: rotation, perspective projection, antialiased lines and
 * a z-buffered flat-shaded triangle filler. Every solid scene goes through
 * `fillTri` so shading and occlusion behave identically across them.
 */

import type { Canvas } from './canvas.ts';

export type Camera = {
  /** Distance from the eye to the origin along +z. */
  dist: number;
  /** Focal length in world units. Larger is a longer lens (less perspective). */
  fov: number;
  /** Fraction of the canvas radius the projection fills. */
  scale: number;
};

export function camera(dist = 4, fov = 3, scale = 0.92): Camera {
  return { dist, fov, scale };
}

/**
 * Rotation with the sines and cosines supplied by the caller.
 *
 * Scenes that transform tens of thousands of points per frame use this: the
 * rotation angles are constant across a frame, so the six trig calls belong
 * outside the inner loop. `sincos` fills a 6-element scratch array.
 */
export function sincos(out: Float32Array, ax: number, ay: number, az: number): void {
  out[0] = Math.sin(ax);
  out[1] = Math.cos(ax);
  out[2] = Math.sin(ay);
  out[3] = Math.cos(ay);
  out[4] = Math.sin(az);
  out[5] = Math.cos(az);
}

export function rot3sc(
  out: Float32Array,
  x: number,
  y: number,
  z: number,
  sc: Float32Array,
): void {
  const y1 = y * sc[1] - z * sc[0];
  const z1 = y * sc[0] + z * sc[1];
  const x2 = x * sc[3] + z1 * sc[2];
  const z2 = -x * sc[2] + z1 * sc[3];
  out[0] = x2 * sc[5] - y1 * sc[4];
  out[1] = x2 * sc[4] + y1 * sc[5];
  out[2] = z2;
}

/**
 * Projects a world point to pixel coordinates.
 * Writes [px, py, depth] into `out` and returns false if the point is behind
 * the near plane.
 */
export function project(
  c: Canvas,
  cam: Camera,
  x: number,
  y: number,
  z: number,
  out: Float32Array,
): boolean {
  const zc = z + cam.dist;
  if (zc < 0.05) return false;
  const k = (cam.fov / zc) * c.radius * cam.scale;
  out[0] = c.cx + x * k;
  out[1] = c.cy + y * k * c.ys;
  out[2] = zc;
  return true;
}

/** Antialiased additive line in pixel space. */
export function lineAA(
  c: Canvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  l: number,
  r: number,
  g: number,
  b: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))) + 1;
  if (steps > 4096) return;
  const ix = dx / steps;
  const iy = dy / steps;
  // Samples are spaced 1..1.41 px apart depending on the line's slope. Scaling
  // the deposit by that spacing keeps a diagonal line as bright as an axis-
  // aligned one.
  const w = l * Math.max(1, Math.hypot(ix, iy));
  let x = x0;
  let y = y0;
  for (let i = 0; i <= steps; i++) {
    c.splat(x, y, w, r, g, b);
    x += ix;
    y += iy;
  }
}

/** Same as lineAA but interpolates depth and respects the z-buffer. */
export function lineZ(
  c: Canvas,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  l: number,
  r: number,
  g: number,
  b: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))) + 1;
  if (steps > 4096) return;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + dx * t);
    const y = Math.round(y0 + dy * t);
    const z = z0 + (z1 - z0) * t;
    if (c.zTest(x, y, z)) c.set(x, y, l, r, g, b);
  }
}

/**
 * Z-buffered flat-shaded triangle. Vertices are pixel-space [x, y, depth].
 *
 * By default backfaces are culled by screen-space winding, which is what lets a
 * solid cube read as solid without any lighting trickery. Open surfaces such as
 * the Moebius strip pass cull=false so both sides rasterise.
 */
export function fillTri(
  c: Canvas,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  l: number,
  r: number,
  g: number,
  b: number,
  cull = true,
): void {
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0 || (cull && area < 0)) return;
  const inv = 1 / area;

  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(c.pw - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(c.ph - 1, Math.ceil(Math.max(ay, by, cy)));
  if (minX > maxX || minY > maxY) return;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * inv;
      const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) * inv;
      if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
      const z = az + (bz - az) * w1 + (cz - az) * w0;
      if (c.zTest(x, y, z)) c.set(x, y, l, r, g, b);
    }
  }
}

/** Lambert term for a light coming over the viewer's left shoulder. */
export function lambert(nx: number, ny: number, nz: number): number {
  const lx = -0.42;
  const ly = -0.62;
  const lz = -0.66;
  const d = nx * lx + ny * ly + nz * lz;
  return d < 0 ? 0 : d;
}
