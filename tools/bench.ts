/**
 * Dev tool: measure per-frame render + rasterise cost for every scene.
 *
 *   node tools/bench.ts [--cols n] [--rows n] [--frames n]
 *
 * Reports the median and 95th percentile in milliseconds. The budget is one
 * frame at the target rate (~31 ms at 32 fps); anything at or above that will
 * visibly drag.
 */

import { Canvas, makeCells, RAMPS } from '../src/core/canvas.ts';
import { PALETTES } from '../src/core/color.ts';
import { SCENES } from '../src/scenes/index.ts';

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};

const cols = arg('cols', 140);
const rows = arg('rows', 40);
const frames = arg('frames', 60);
const budget = arg('budget', 31);

const palette = PALETTES.find((p) => p.id === 'ice')!;
const cells = makeCells(cols, rows);

process.stdout.write(`${cols}x${rows}, ${frames} frames, budget ${budget}ms\n\n`);
process.stdout.write(`  ${'scene'.padEnd(14)} ${'mode'.padEnd(8)} ${'median'.padStart(8)} ${'p95'.padStart(8)}\n`);

const rowsOut: string[] = [];
for (const scene of SCENES) {
  const canvas = new Canvas(cols, rows, scene.mode);
  canvas.ramp = scene.ramp ?? RAMPS.classic;
  scene.reset?.(canvas);
  const times: number[] = [];
  const dt = 1 / 32;
  // A few untimed frames first: the JIT needs to see the inner loops before the
  // numbers mean anything, and stateful scenes need their buffers warm.
  for (let f = 0; f < 12; f++) scene.render(canvas, { palette, t: f * dt, dt });
  for (let f = 0; f < frames; f++) {
    const t0 = process.hrtime.bigint();
    scene.render(canvas, { palette, t: (12 + f) * dt, dt });
    canvas.rasterize(cells);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1];
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
  const flag = p95 >= budget ? '  <-- over budget' : '';
  rowsOut.push(
    `  ${scene.id.padEnd(14)} ${scene.mode.padEnd(8)} ${median.toFixed(2).padStart(8)} ${p95.toFixed(2).padStart(8)}${flag}`,
  );
}
process.stdout.write(`${rowsOut.join('\n')}\n`);
