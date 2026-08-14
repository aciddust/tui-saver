/**
 * The terminal writer.
 *
 * Repainting every cell of a 200x50 truecolour frame costs ~100 KB per frame;
 * at 45 fps that is more than most terminals will swallow without stuttering.
 * So this keeps the previously drawn frame and emits only the runs of cells
 * that actually changed, coalescing SGR sequences inside each run.
 */

import { type CellBuffer, makeCells } from './canvas.ts';
import { to256 } from './color.ts';

export type ColorDepth = 'truecolor' | '256' | 'mono';

export function detectColorDepth(): ColorDepth {
  const env = process.env;
  if (env.NO_COLOR) return 'mono';
  const ct = (env.COLORTERM ?? '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return 'truecolor';
  const term = (env.TERM ?? '').toLowerCase();
  if (term.includes('direct')) return 'truecolor';
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm') return 'truecolor';
  if (term.includes('256')) return '256';
  // Windows must be decided before the "no TERM means no colour" rule below:
  // nothing on Windows sets TERM, so that rule would sentence every Windows
  // terminal to monochrome. Both Windows Terminal and conhost have handled
  // 24-bit SGR since Windows 10 1703, and Node turns on virtual terminal
  // processing for us.
  if (process.platform === 'win32') return 'truecolor';
  if (term === '' || term === 'dumb') return 'mono';
  return '256';
}

/**
 * Whether the terminal can be expected to have glyphs for the Braille Patterns
 * block (U+2800-U+28FF).
 *
 * This is a font question, not a terminal-capability question, and there is no
 * escape sequence that asks it — so it has to be inferred. It only actually
 * bites on Windows: the legacy console's default font is Consolas, which has no
 * braille coverage at all, so the eight braille scenes would render as rows of
 * replacement boxes. Cascadia Mono, which Windows Terminal ships, does cover it.
 *
 * Everywhere else the common terminal fonts cover braille, and any font that
 * doesn't is a deliberate choice by the user, who has --mode to say so.
 */
export function supportsBraille(): boolean {
  if (process.platform !== 'win32') return true;
  const env = process.env;
  // Any of these means something other than bare conhost is drawing the text.
  return Boolean(
    env.WT_SESSION ?? // Windows Terminal
      env.TERM_PROGRAM ?? // VS Code, and others that announce themselves
      env.WEZTERM_EXECUTABLE ??
      env.ALACRITTY_WINDOW_ID ??
      env.ConEmuANSI ??
      env.TERM, // anything running under a POSIX-ish layer sets this
  );
}

const ESC = '\x1b';
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const RESET = `${ESC}[0m`;

export class Screen {
  depth: ColorDepth;
  private prev: CellBuffer;
  private out = process.stdout;
  private entered = false;
  /** False while stdout is backed up; frames are dropped rather than queued. */
  private drained = true;

  constructor(cols: number, rows: number, depth: ColorDepth) {
    this.prev = makeCells(cols, rows);
    this.depth = depth;
  }

  get ready(): boolean {
    return this.drained;
  }

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.out.write(ALT_ON + CURSOR_HIDE + RESET + `${ESC}[2J`);
  }

  leave(): void {
    if (!this.entered) return;
    this.entered = false;
    this.out.write(RESET + CURSOR_SHOW + ALT_OFF);
  }

  /** Drops the cached frame so the next flush repaints everything. */
  invalidate(cols: number, rows: number): void {
    this.prev = makeCells(cols, rows);
    this.out.write(RESET + `${ESC}[2J`);
  }

  /**
   * Emits only the halves of the colour state that actually changed.
   *
   * Braille and ascii cells never set a background, so pairing every foreground
   * change with a redundant `\e[49m` was costing a fifth of the byte budget for
   * nothing.
   */
  private sgr(fg: number, bg: number, curFg: number, curBg: number): string {
    if (this.depth === 'mono') return '';
    let s = '';
    const truecolor = this.depth === 'truecolor';
    if (fg !== curFg) {
      if (fg < 0) s += `${ESC}[39m`;
      else if (truecolor) {
        s += `${ESC}[38;2;${(fg >> 16) & 0xff};${(fg >> 8) & 0xff};${fg & 0xff}m`;
      } else s += `${ESC}[38;5;${to256(fg)}m`;
    }
    if (bg !== curBg) {
      if (bg < 0) s += `${ESC}[49m`;
      else if (truecolor) {
        s += `${ESC}[48;2;${(bg >> 16) & 0xff};${(bg >> 8) & 0xff};${bg & 0xff}m`;
      } else s += `${ESC}[48;5;${to256(bg)}m`;
    }
    return s;
  }

  flush(next: CellBuffer): void {
    if (!this.drained) return;
    const prev = this.prev;
    if (prev.cols !== next.cols || prev.rows !== next.rows) {
      this.invalidate(next.cols, next.rows);
      return this.flush(next);
    }

    const parts: string[] = [];
    let curFg = Number.NaN;
    let curBg = Number.NaN;

    for (let y = 0; y < next.rows; y++) {
      const base = y * next.cols;
      let x = 0;
      while (x < next.cols) {
        const i = base + x;
        if (next.ch[i] === prev.ch[i] && next.fg[i] === prev.fg[i] && next.bg[i] === prev.bg[i]) {
          x++;
          continue;
        }
        // Start a run at the first mismatch and keep going while cells differ.
        // A single matching cell inside a dirty stretch is cheaper to redraw
        // than to pay for another cursor-positioning sequence, so tolerate
        // short clean gaps.
        parts.push(`${ESC}[${y + 1};${x + 1}H`);
        let clean = 0;
        while (x < next.cols && clean < 4) {
          const k = base + x;
          const same =
            next.ch[k] === prev.ch[k] && next.fg[k] === prev.fg[k] && next.bg[k] === prev.bg[k];
          clean = same ? clean + 1 : 0;
          const fg = next.fg[k];
          const bg = next.bg[k];
          if (fg !== curFg || bg !== curBg) {
            parts.push(this.sgr(fg, bg, curFg, curBg));
            curFg = fg;
            curBg = bg;
          }
          parts.push(String.fromCodePoint(next.ch[k]));
          prev.ch[k] = next.ch[k];
          prev.fg[k] = fg;
          prev.bg[k] = bg;
          x++;
        }
      }
    }

    if (parts.length === 0) return;
    // RESET drops the terminal's colour state, which is why curFg/curBg start
    // as NaN each flush rather than persisting across frames.
    parts.push(RESET);
    const payload = parts.join('');
    this.drained = this.out.write(payload);
    if (!this.drained) {
      this.out.once('drain', () => {
        this.drained = true;
      });
    }
  }
}
