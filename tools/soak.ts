/**
 * Dev tool: render every scene in every mode at several terminal sizes and
 * report anything that throws, produces NaN, or draws nothing at all.
 *
 *   node tools/soak.ts
 *
 * The blank check matters more than it sounds: a scene whose camera or scale is
 * wrong for an unusual aspect ratio fails silently, and a screensaver showing an
 * empty screen for 22 seconds looks exactly like a hang.
 */

import { Canvas, makeCells, RAMPS, RENDER_MODES } from '../src/core/canvas.ts';
import { PALETTES } from '../src/core/color.ts';
import { dissolve, drawHelp, drawHud } from '../src/ui.ts';
import { SCENES } from '../src/scenes/index.ts';

const SIZES: readonly (readonly [number, number])[] = [
  [20, 8], // the enforced minimum
  [60, 18],
  [100, 30],
  [200, 55],
  [240, 12], // extreme wide-and-short
  [40, 60], // extreme tall-and-narrow
];

let failures = 0;
const note = (s: string): void => {
  failures++;
  process.stdout.write(`  FAIL ${s}\n`);
};

for (const scene of SCENES) {
  for (const [cols, rows] of SIZES) {
    for (const mode of RENDER_MODES) {
      const canvas = new Canvas(cols, rows, mode);
      canvas.ramp = scene.ramp ?? RAMPS.classic;
      const cells = makeCells(cols, rows);
      const dt = 1 / 32;
      const where = `${scene.id} ${mode} ${cols}x${rows}`;
      try {
        scene.reset?.(canvas);
        let anyLit = false;
        // Sample across a long stretch of time, not just the opening seconds:
        // several scenes cycle their own state (mandelbrot's dive, hilbert's
        // order, the harmonograph's runs) on a much slower clock than a frame.
        for (let f = 0; f < 40; f++) {
          const t = f * 1.7;
          scene.render(canvas, { palette: PALETTES[f % PALETTES.length], t, dt });
          canvas.rasterize(cells);
          for (let i = 0; i < canvas.lum.length; i++) {
            const v = canvas.lum[i];
            if (Number.isNaN(v)) throw new Error(`NaN luminance at pixel ${i}, t=${t}`);
            if (v > 0.02) anyLit = true;
          }
          for (let i = 0; i < canvas.col.length; i++) {
            if (Number.isNaN(canvas.col[i])) throw new Error(`NaN colour at ${i}, t=${t}`);
          }
        }
        if (!anyLit) note(`${where}: drew nothing across 40 frames`);
      } catch (err) {
        note(`${where}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

// The chrome and the transition run over every frame too, so they get the same
// treatment at the awkward sizes.
for (const [cols, rows] of SIZES) {
  try {
    const a = makeCells(cols, rows);
    const b = makeCells(cols, rows);
    const out = makeCells(cols, rows);
    for (const p of [0, 0.5, 1]) dissolve(a, b, out, p);
    drawHud(out, {
      index: 0,
      count: SCENES.length,
      title: 'a very long scene title that will not fit',
      mode: 'braille',
      palette: 'ice',
      fps: 31.7,
      speed: 1.25,
      paused: true,
      remaining: 4,
      awake: 'awake',
      awakeOk: true,
    });
    drawHelp(out);
  } catch (err) {
    note(`chrome ${cols}x${rows}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

process.stdout.write(
  failures === 0
    ? `ok: ${SCENES.length} scenes x ${RENDER_MODES.length} modes x ${SIZES.length} sizes clean\n`
    : `${failures} failure(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
