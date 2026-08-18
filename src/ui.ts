/**
 * Chrome drawn on top of the finished frame: the status bar, the help overlay,
 * and the cross-scene dissolve.
 *
 * All of it operates on CellBuffers rather than pixels, which means the
 * dissolve works between scenes rendered in different modes — a braille frame
 * can melt into a half-block one without either knowing about the other.
 */

import type { CellBuffer } from './core/canvas.ts';
import type { Battery } from './battery.ts';
import { formatSpan } from './session.ts';
import { hash2 } from './core/noise.ts';
import { pack } from './core/color.ts';

const DIM = pack(0.42, 0.46, 0.52);
const BRIGHT = pack(0.85, 0.9, 0.95);
const ACCENT = pack(0.4, 0.78, 0.92);
const WARN = pack(0.95, 0.55, 0.35);
const PANEL = pack(0.05, 0.06, 0.09);
const ALARM = pack(0.45, 0.11, 0.05);

/**
 * Everything drawn into the cell grid has to be one column wide.
 *
 * The canvas maps one character to one cell, so a wide or ambiguous-width
 * character shifts everything after it and corrupts the row — seen in tmux as
 * `awak✓ ff:unpin ?:elp q:q` after a bolt and a tick went into the status bar.
 * Em dashes are ambiguous too, hence the plain hyphens in the messages here.
 */
export function drawText(
  cb: CellBuffer,
  x: number,
  y: number,
  text: string,
  fg: number,
  bg: number,
): number {
  if (y < 0 || y >= cb.rows) return x;
  let cx = x;
  for (const chr of text) {
    if (cx >= cb.cols) break;
    if (cx >= 0) {
      const i = y * cb.cols + cx;
      cb.ch[i] = chr.codePointAt(0)!;
      cb.fg[i] = fg;
      cb.bg[i] = bg;
    }
    cx++;
  }
  return cx;
}

function clearRow(cb: CellBuffer, y: number, bg: number): void {
  if (y < 0 || y >= cb.rows) return;
  for (let x = 0; x < cb.cols; x++) {
    const i = y * cb.cols + x;
    cb.ch[i] = 32;
    cb.fg[i] = DIM;
    cb.bg[i] = bg;
  }
}

/**
 * A warning across the top row, drawn whether or not the status bar is showing.
 *
 * The status bar can be hidden with `h` or never shown at all with --no-hud, and
 * the one thing this program promises is the one thing that must not be hideable:
 * an animation running while the machine sleeps under it looks exactly like an
 * animation running while it does not. The top row is used because the status bar
 * owns the bottom one.
 */
export function drawBanner(cb: CellBuffer, text: string): void {
  clearRow(cb, 0, ALARM);
  drawText(cb, 1, 0, text, BRIGHT, ALARM);
}

export type HudInfo = {
  index: number;
  count: number;
  title: string;
  mode: string;
  palette: string;
  fps: number;
  speed: number;
  paused: boolean;
  /** Seconds left before the playlist advances, or null when pinned. */
  sceneRemaining: number | null;
  /** Wall-clock seconds this run has been on screen, and holding the lock. */
  elapsed: number;
  /** Seconds left of the whole run, or null when it runs until quit. */
  sessionRemaining: number | null;
  /** The battery, or null on a machine that has none to report. */
  battery: Battery | null;
  /** The host being kept awake, when it is not the one being typed at. */
  remote: string | null;
  awake: string;
  awakeOk: boolean;
};

export function drawHud(cb: CellBuffer, info: HudInfo): void {
  const y = cb.rows - 1;
  clearRow(cb, y, PANEL);

  // Ordered by what a narrow terminal should keep. The bar outgrew the naive
  // left-to-right approach: three segments were added, a 46-column pane overflowed,
  // and the awake indicator — the one thing here that cannot be recovered by
  // pressing a key — was the first casualty. So the segments say how much they
  // matter, the indicator's space is reserved before any of them are drawn, and
  // what falls off the end is decoration.
  const segments: { text: string; fg: number }[] = [
    { text: `${info.index + 1}/${info.count}`, fg: DIM },
    { text: `  ${info.title}`, fg: BRIGHT },
  ];
  if (info.paused) segments.push({ text: '  PAUSED', fg: WARN });
  // With a limit, the countdown; without one, how long this has been up. The
  // second is the more important of the two: a lock held for four hours is worth
  // seeing even when nothing asked for it to stop.
  if (info.sessionRemaining !== null) {
    const soon = info.sessionRemaining <= 60;
    segments.push({ text: `  ${formatSpan(info.sessionRemaining)} left`, fg: soon ? WARN : ACCENT });
  } else {
    segments.push({ text: `  ${formatSpan(info.elapsed)}`, fg: DIM });
  }
  // Ahead of the battery and the clock, because it changes what those mean: they
  // describe the far machine, not this one.
  if (info.remote) segments.push({ text: `  ssh:${info.remote}`, fg: WARN });
  if (info.battery) {
    // The charge earns its place here because the lock is the reason it is going
    // down: nothing else on this bar explains why the machine is not resting.
    // 'ac' rather than a bolt: U+26A1 is East Asian Wide, always two columns, and
    // one character per cell is the assumption the whole canvas rests on.
    const bat = info.battery;
    segments.push({
      text: `  bat ${bat.percent}%${bat.discharging ? '' : ' ac'}`,
      fg: bat.discharging ? ACCENT : DIM,
    });
  }
  if (info.sceneRemaining === null) segments.push({ text: '  pinned', fg: ACCENT });
  // Everything from here down is decoration and goes first.
  segments.push({ text: `  ${info.mode}`, fg: ACCENT });
  if (info.speed !== 1) segments.push({ text: `  x${info.speed.toFixed(2)}`, fg: ACCENT });
  segments.push({ text: `  ${info.palette}`, fg: DIM });
  segments.push({ text: `  ${info.fps.toFixed(0)}fps`, fg: DIM });

  // Reserved first, drawn last.
  const reserved = info.awake.length + 2;
  let x = 1;
  for (const segment of segments) {
    if (x + segment.text.length > cb.cols - reserved) break;
    x = drawText(cb, x, y, segment.text, segment.fg, PANEL);
  }

  const pinHint = info.sceneRemaining === null ? 'f:unpin' : 'f:pin';
  // Widest hint set that still clears the text on the left; a narrow terminal
  // drops to the shorter ones rather than overwriting the scene name.
  // The last entry is empty: the awake indicator keeps its place after every hint
  // has been dropped.
  const candidates = [
    `   ${pinHint}  n:next  ?:help  q:quit`,
    `   ${pinHint}  ?:help  q:quit`,
    `   ${pinHint}  ?:help`,
    `   ?:help`,
    '',
  ];
  const hint = candidates.find((h) => cb.cols - (info.awake.length + h.length) - 1 > x) ?? '';
  const rx = Math.max(x, cb.cols - (info.awake.length + hint.length) - 1);
  drawText(cb, rx, y, info.awake, info.awakeOk ? ACCENT : WARN, PANEL);
  if (hint) drawText(cb, rx + info.awake.length, y, hint, DIM, PANEL);
}

const HELP: readonly string[] = [
  'keys',
  '',
  '  n / right    next scene',
  '  p / left     previous scene',
  '  1-9          jump to scene',
  '  space        pause / resume',
  '  m            cycle render mode (braille / half / ascii)',
  '  c            cycle palette',
  '  r            cycle ascii ramp',
  '  [ ]          slower / faster',
  '  0            reset speed',
  '  f            pin the current scene (stop auto-advance)',
  '  s            shuffle the playlist',
  '  h            hide / show this status bar',
  '  ?            toggle this help',
  '  q / ctrl-c   quit',
  '',
  'the host is held awake by a caffeinate child process that',
  'watches this pid, so the assertion drops even on SIGKILL.',
  'run with --doctor to see what the kernel actually reports.',
];

export function drawHelp(cb: CellBuffer): void {
  const w = Math.min(cb.cols - 4, 62);
  const h = Math.min(cb.rows - 2, HELP.length + 2);
  const x0 = Math.floor((cb.cols - w) / 2);
  const y0 = Math.floor((cb.rows - h) / 2);
  const bg = PANEL;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y0 + y) * cb.cols + (x0 + x);
      if (i < 0 || i >= cb.ch.length) continue;
      cb.ch[i] = 32;
      cb.fg[i] = DIM;
      cb.bg[i] = bg;
    }
  }
  // Border.
  const top = `╭${'─'.repeat(w - 2)}╮`;
  const bot = `╰${'─'.repeat(w - 2)}╯`;
  drawText(cb, x0, y0, top, ACCENT, bg);
  drawText(cb, x0, y0 + h - 1, bot, ACCENT, bg);
  for (let y = 1; y < h - 1; y++) {
    drawText(cb, x0, y0 + y, '│', ACCENT, bg);
    drawText(cb, x0 + w - 1, y0 + y, '│', ACCENT, bg);
  }
  for (let i = 0; i < HELP.length && i + 1 < h - 1; i++) {
    const line = HELP[i];
    const fg = i === 0 ? BRIGHT : DIM;
    drawText(cb, x0 + 2, y0 + 1 + i, line.slice(0, w - 4), fg, bg);
  }
}

/**
 * Per-cell dissolve from `a` to `b`. Each cell has a fixed random threshold, so
 * cells flip over at staggered moments and the changeover reads as a grain wipe
 * rather than a fade.
 */
export function dissolve(a: CellBuffer, b: CellBuffer, out: CellBuffer, progress: number): void {
  const n = out.cols * out.rows;
  for (let i = 0; i < n; i++) {
    const y = (i / out.cols) | 0;
    const x = i - y * out.cols;
    const src = hash2(x * 3 + 11, y * 7 + 5) < progress ? b : a;
    out.ch[i] = src.ch[i];
    out.fg[i] = src.fg[i];
    out.bg[i] = src.bg[i];
  }
}
