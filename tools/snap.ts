/**
 * Dev tool: render a single frame of one scene as plain text, no ANSI.
 *
 * Used to eyeball geometry without a TTY. Colour is dropped and half-block
 * cells are re-mapped onto a luminance ramp so the shape is still visible.
 *
 *   node tools/snap.ts torus --t 3.5 --cols 100 --rows 30 [--mode ascii]
 */

import { Canvas, makeCells, RAMPS, type RenderMode } from '../src/core/canvas.ts';
import { PALETTES } from '../src/core/color.ts';
import { sceneById } from '../src/scenes/index.ts';

const argv = process.argv.slice(2);
const id = argv[0];
const flag = (name: string, def: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : def;
};
const sflag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

const scene = sceneById(id ?? '');
if (!scene) {
  process.stderr.write(`usage: node tools/snap.ts <sceneId> [--t s] [--cols n] [--rows n] [--mode m] [--frames n]\n`);
  process.exit(2);
}

const cols = flag('cols', 100);
const rows = flag('rows', 30);
const t = flag('t', 3);
const frames = flag('frames', 1);
const mode = (sflag('mode') as RenderMode | null) ?? scene.mode;
const paletteId = sflag('palette') ?? 'ice';

const canvas = new Canvas(cols, rows, mode);
canvas.ramp = scene.ramp ?? RAMPS.classic;
const cells = makeCells(cols, rows);
const palette = PALETTES.find((p) => p.id === paletteId) ?? PALETTES[0];

scene.reset?.(canvas);

// Warm up over `frames` steps so scenes with persistent state (fire, trails)
// have something to show by the time we sample.
const dt = frames > 1 ? t / frames : 1 / 30;
for (let f = 1; f <= frames; f++) {
  scene.render(canvas, { palette, t: frames > 1 ? dt * f : t, dt });
}
canvas.rasterize(cells);

// Half-block cells carry two pixels in one character; re-render them through a
// ramp so a text dump still shows the image.
const RAMP = ' .:-=+*#%@';
const lines: string[] = [];
for (let y = 0; y < rows; y++) {
  let line = '';
  for (let x = 0; x < cols; x++) {
    const i = y * cols + x;
    if (mode === 'half') {
      const top = canvas.lum[y * 2 * canvas.pw + x];
      const bot = canvas.lum[(y * 2 + 1) * canvas.pw + x];
      const l = (top + bot) * 0.5;
      line += RAMP[Math.min(RAMP.length - 1, Math.round(l * (RAMP.length - 1)))];
    } else {
      line += String.fromCodePoint(cells.ch[i]);
    }
  }
  lines.push(line.replace(/\s+$/, ''));
}
process.stdout.write(`${lines.join('\n')}\n`);
