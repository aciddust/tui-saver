/**
 * The scene registry. Order here is the default playlist order.
 */

import type { Scene } from '../core/scene.ts';

import { torus } from './torus.ts';
import { cube } from './cube.ts';
import { tesseract } from './tesseract.ts';
import { mobius } from './mobius.ts';
import { globe } from './globe.ts';
import { waves } from './waves.ts';
import { plasma } from './plasma.ts';
import { tunnel } from './tunnel.ts';
import { starfield } from './starfield.ts';
import { metaballs } from './metaballs.ts';
import { fire } from './fire.ts';
import { lorenz, aizawa, thomas } from './attractor.ts';
import { mandelbrot } from './mandelbrot.ts';
import { harmonograph } from './harmonograph.ts';
import { hilbert } from './hilbert.ts';
import { raymarch } from './raymarch.ts';

// Sequenced so neighbouring scenes contrast: a solid shaded shape next to a
// full-colour field next to a sparse line drawing.
export const SCENES: readonly Scene[] = [
  torus,
  plasma,
  cube,
  starfield,
  raymarch,
  lorenz,
  tunnel,
  tesseract,
  fire,
  waves,
  globe,
  harmonograph,
  metaballs,
  mobius,
  mandelbrot,
  aizawa,
  hilbert,
  thomas,
];

export function sceneById(id: string): Scene | undefined {
  return SCENES.find((s) => s.id === id);
}
