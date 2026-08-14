/**
 * The scene contract.
 *
 * A scene is stateless with respect to the terminal: it is handed a Canvas and
 * a time, and draws pixels. Scenes that need persistent buffers (heat maps,
 * particle trails) allocate them lazily against `c.pw`/`c.ph` and reallocate
 * when those change — `sizedBuffer` below is the helper for that.
 */

import type { Canvas, RenderMode } from './canvas.ts';
import type { Palette } from './color.ts';

export type SceneEnv = {
  palette: Palette;
  /** Wall-clock seconds since this scene became visible. */
  t: number;
  /** Seconds since the previous frame, already scaled by the speed control. */
  dt: number;
};

export type Scene = {
  id: string;
  title: string;
  /** One-line blurb shown by --list. */
  blurb: string;
  /** Render mode this scene looks best in, unless the user overrides it. */
  mode: RenderMode;
  /** Character ramp override for ascii-mode scenes. */
  ramp?: string;
  /** Called whenever the scene starts a fresh run. */
  reset?(c: Canvas): void;
  render(c: Canvas, env: SceneEnv): void;
};

/**
 * Returns a Float32Array matching the canvas' pixel count, reusing `prev` when
 * it is already the right size. Returns [buffer, wasReallocated].
 */
export function sizedBuffer(
  prev: Float32Array | null,
  n: number,
): [Float32Array, boolean] {
  if (prev && prev.length === n) return [prev, false];
  return [new Float32Array(n), true];
}

/** Cheap smooth minimum, the workhorse of SDF blending. */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
