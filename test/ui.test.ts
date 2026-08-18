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

import { drawHud, type HudInfo } from '../src/ui.ts';

function hud(over: Partial<HudInfo> = {}): string {
  const cb = makeCells(120, 12);
  drawHud(cb, {
    index: 0,
    count: 3,
    title: 'torus',
    mode: 'ascii',
    palette: 'ice',
    fps: 32,
    speed: 1,
    paused: false,
    sceneRemaining: 10,
    awake: 'awake✓',
    awakeOk: true,
    elapsed: 0,
    sessionRemaining: null,
    battery: null,
    remote: null,
    ...over,
  });
  return rowText(cb, 11);
}

test('with no session limit the status bar says how long this has been running', () => {
  // The lock is held for exactly as long as this is on screen, so how long that
  // has been is the number that matters when there is no limit to count down.
  assert.match(hud({ elapsed: 13320 }), /3h42m/);
});

test('a session limit is counted down instead of counting up', () => {
  const row = hud({ elapsed: 60, sessionRemaining: 605 });
  assert.match(row, /10m05s/);
  assert.doesNotMatch(row, /1m00s/, 'the elapsed time should give way to the countdown');
});

test('the scene countdown and the session countdown are not confused for each other', () => {
  const row = hud({ sceneRemaining: 7, elapsed: 30, sessionRemaining: 3600 });
  assert.match(row, /1h00m/);
});

test('the status bar shows the charge, and marks a battery that is not draining', () => {
  assert.match(hud({ battery: { percent: 100, discharging: false } }), /bat 100%⚡/);
});

test('a draining battery is shown without the charging mark', () => {
  const row = hud({ battery: { percent: 31, discharging: true } });
  assert.match(row, /bat 31%/);
  assert.doesNotMatch(row, /⚡/);
});

test('a machine with no battery says nothing about one', () => {
  assert.doesNotMatch(hud({ battery: null }), /bat/);
});

test('the status bar names the host when the lock is not on this machine', () => {
  assert.match(hud({ remote: 'build-box' }), /ssh:build-box/);
});

test('a local run has no host segment at all', () => {
  assert.doesNotMatch(hud({ remote: null }), /ssh:/);
});
