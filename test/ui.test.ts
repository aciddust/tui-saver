import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCells, type CellBuffer } from '../src/core/canvas.ts';
import { drawBanner } from '../src/ui.ts';

function rowText(cb: CellBuffer, y: number): string {
  let s = '';
  for (let x = 0; x < cb.cols; x++) s += String.fromCodePoint(cb.ch[y * cb.cols + x] || 32);
  return s;
}

test('the banner draws on the top row, which the status bar does not own', () => {
  const cb = makeCells(60, 10);
  drawBanner(cb, 'NOT holding the sleep lock');
  assert.match(rowText(cb, 0), /NOT holding the sleep lock/);
});

test('a banner wider than the terminal is truncated rather than spilling', () => {
  const cb = makeCells(12, 5);
  drawBanner(cb, 'a warning far too long for twelve columns');
  assert.equal(rowText(cb, 1).trim(), '', 'nothing may land on the second row');
});

test('the banner fills its whole row, so the animation cannot show through it', () => {
  const cb = makeCells(30, 6);
  drawBanner(cb, 'short');
  assert.equal(rowText(cb, 0).length, 30);
  assert.match(rowText(cb, 0), /^ ?short */);
});
