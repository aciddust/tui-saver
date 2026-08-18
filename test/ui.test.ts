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
    whilePid: null,
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
  assert.match(hud({ battery: { percent: 100, discharging: false } }), /bat 100% ac/);
});

test('a draining battery is shown without the mains marker', () => {
  const row = hud({ battery: { percent: 31, discharging: true } });
  assert.match(row, /bat 31%/);
  assert.doesNotMatch(row, /ac/);
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

import { drawBanner as banner, drawHelp } from '../src/ui.ts';

test('the chrome writes nothing that occupies more than one column', () => {
  // The canvas is built on one character per cell. U+26A1 ⚡ is East Asian Wide and
  // always two columns; ✓, … and — are Ambiguous and two columns in a
  // CJK-configured terminal. Either way everything after them shifts and the row
  // corrupts — observed in tmux as "awak✓ ff:unpin ?:elp q:q".
  const cb = makeCells(120, 14);
  drawHud(cb, {
    index: 0,
    count: 3,
    title: 'torus',
    mode: 'ascii',
    palette: 'ice',
    fps: 32,
    speed: 1.5,
    paused: true,
    sceneRemaining: 10,
    awake: 'awake',
    awakeOk: true,
    elapsed: 3600,
    sessionRemaining: 605,
    battery: { percent: 100, discharging: false },
    remote: 'build-box',
    whilePid: 4242,
  });
  banner(cb, 'a warning of some kind');
  drawHelp(cb);

  // The help panel's frame predates all of this and is what the panel looks like.
  // Box drawing is Ambiguous too, so a terminal configured to render Ambiguous as
  // double would corrupt that panel as well — a real but separate problem, and not
  // one to fix by quietly changing the design. A bolt is different in kind: Wide is
  // two columns everywhere, with no configuration involved.
  const frame = new Set([...'╭╮╰╯─│']);
  const offenders = new Set<string>();
  for (let i = 0; i < cb.ch.length; i++) {
    const code = cb.ch[i];
    if (code <= 127) continue;
    const ch = String.fromCodePoint(code);
    if (!frame.has(ch)) offenders.add(ch);
  }
  assert.deepEqual([...offenders], [], 'chrome must stay in ASCII outside the help frame');
});

test('the awake indicator survives a terminal too narrow for anything else', () => {
  // It is the one thing on this bar that cannot be recovered by pressing a key, so
  // it is the last thing to go. Adding segments to the left pushed it off a 46-column
  // pane entirely, which is how this was found.
  for (const cols of [20, 30, 46, 60]) {
    const cb = makeCells(cols, 6);
    drawHud(cb, {
      index: 0,
      count: 9,
      title: 'harmonograph',
      mode: 'braille',
      palette: 'viridis',
      fps: 32,
      speed: 1.5,
      paused: true,
      sceneRemaining: 10,
      awake: 'awake:FAIL',
      awakeOk: false,
      elapsed: 13_320,
      sessionRemaining: 605,
      battery: { percent: 100, discharging: false },
      remote: 'build-box',
      whilePid: 4242,
    });
    assert.match(rowText(cb, 5), /awake:FAIL/, `at ${cols} columns`);
  }
});

test('what the bar drops first is decoration, not the things that matter', () => {
  // 62 columns: wide enough that something has to go, narrow enough that not
  // everything fits. At 52 even the battery cannot be squeezed in, which is
  // arithmetic rather than a policy.
  const cb = makeCells(62, 6);
  drawHud(cb, {
    index: 0,
    count: 9,
    title: 'torus',
    mode: 'braille',
    palette: 'viridis',
    fps: 32,
    speed: 1,
    paused: false,
    sceneRemaining: 10,
    awake: 'awake:os',
    awakeOk: true,
    elapsed: 60,
    sessionRemaining: 605,
    battery: { percent: 9, discharging: true },
    remote: 'build-box',
    whilePid: null,
  });
  const row = rowText(cb, 5);
  assert.match(row, /awake:os/);
  assert.match(row, /ssh:build-box/, 'which machine is being kept awake');
  assert.match(row, /bat 9%/, 'a battery about to run out');
  assert.doesNotMatch(row, /viridis/, 'the palette is decoration');
});

test('the status bar names the pid the run is waiting for', () => {
  assert.match(hud({ whilePid: 4242 }), /while:4242/);
});

test('a run waiting for nothing says nothing about it', () => {
  assert.doesNotMatch(hud({ whilePid: null }), /while:/);
});
