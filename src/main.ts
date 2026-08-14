#!/usr/bin/env node
/**
 * tui-saver — a terminal screensaver that refuses to let the host sleep.
 *
 * This file owns the outer loop: parse options, hold the sleep assertion, set up
 * the terminal, then repeatedly render the current scene, dissolve between
 * scenes, and hand finished frames to the diffing writer.
 */

import { Canvas, makeCells, RAMPS, RENDER_MODES, type CellBuffer, type RenderMode } from './core/canvas.ts';
import { PALETTES, paletteById } from './core/color.ts';
import { detectColorDepth, Screen, supportsBraille, type ColorDepth } from './core/screen.ts';
import type { Scene } from './core/scene.ts';
import { SCENES, sceneById } from './scenes/index.ts';
import { Awake, doctor } from './awake.ts';
import { dissolve, drawHelp, drawHud } from './ui.ts';

type Options = {
  fps: number;
  duration: number;
  transition: number;
  speed: number;
  mode: RenderMode | null;
  ramp: string | null;
  palette: string;
  color: ColorDepth | null;
  playlist: string[] | null;
  shuffle: boolean;
  hud: boolean;
  awake: boolean;
  defeatScreensaver: boolean;
  /** null = detect whether the terminal font is likely to have braille. */
  braille: boolean | null;
};

const DEFAULTS: Options = {
  fps: 32,
  duration: 22,
  transition: 0.9,
  speed: 1,
  mode: null,
  ramp: null,
  palette: 'ice',
  color: null,
  playlist: null,
  shuffle: false,
  hud: true,
  awake: true,
  defeatScreensaver: false,
  braille: null,
};

const USAGE = `tui-saver — geometric ASCII screensaver that keeps the host awake

usage: tui-saver [options]

playback
  --scene <id>            show only this scene
  --only <id,id,...>      restrict the playlist
  --duration <seconds>    seconds per scene (0 = never advance)  [${DEFAULTS.duration}]
  --transition <seconds>  dissolve length                        [${DEFAULTS.transition}]
  --fps <n>               target frame rate                      [${DEFAULTS.fps}]
  --speed <n>             time multiplier                        [${DEFAULTS.speed}]
  --shuffle               randomise the playlist order

look
  --mode <braille|half|ascii>   force a render mode for every scene
  --palette <id>                ${PALETTES.map((p) => p.id).join(', ')}
  --ramp <${Object.keys(RAMPS).join('|')}>   ascii character ramp
  --color <truecolor|256|mono>  override colour depth detection
  --braille / --no-braille      override the guess about whether this
                                terminal's font has braille glyphs
  --no-hud                      start with the status bar hidden

staying awake
  --no-awake              do not hold any power assertion
  --defeat-screensaver    also pulse synthetic user activity so the screen
                          saver and lock screen stay away
  --doctor                report what the kernel says about the assertions

other
  --list                  list scenes and exit
  -h, --help              this text
`;

function parseArgs(argv: string[]): { opts: Options; exit?: () => Promise<number> } {
  const opts: Options = { ...DEFAULTS };
  const need = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined) {
      process.stderr.write(`${name} needs a value\n`);
      process.exit(2);
    }
    return v;
  };
  const num = (raw: string, name: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      process.stderr.write(`${name}: not a number: ${raw}\n`);
      process.exit(2);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        return { opts, exit: async () => (process.stdout.write(USAGE), 0) };
      case '--list':
        return {
          opts,
          exit: async () => {
            const w = Math.max(...SCENES.map((s) => s.id.length));
            for (const s of SCENES) {
              process.stdout.write(`  ${s.id.padEnd(w)}  ${s.mode.padEnd(7)}  ${s.blurb}\n`);
            }
            return 0;
          },
        };
      case '--doctor':
        return { opts, exit: doctor };
      case '--scene':
        opts.playlist = [need(i, a)];
        i++;
        break;
      case '--only':
        opts.playlist = need(i, a).split(',').map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case '--duration':
        opts.duration = Math.max(0, num(need(i, a), a));
        i++;
        break;
      case '--transition':
        opts.transition = Math.max(0, num(need(i, a), a));
        i++;
        break;
      case '--fps':
        opts.fps = Math.min(120, Math.max(4, num(need(i, a), a)));
        i++;
        break;
      case '--speed':
        opts.speed = Math.min(8, Math.max(0.05, num(need(i, a), a)));
        i++;
        break;
      case '--shuffle':
        opts.shuffle = true;
        break;
      case '--mode': {
        const v = need(i, a) as RenderMode;
        if (!RENDER_MODES.includes(v)) {
          process.stderr.write(`--mode: expected one of ${RENDER_MODES.join(', ')}\n`);
          process.exit(2);
        }
        opts.mode = v;
        i++;
        break;
      }
      case '--palette': {
        const v = need(i, a);
        if (!paletteById(v)) {
          process.stderr.write(`--palette: unknown '${v}'. try: ${PALETTES.map((p) => p.id).join(', ')}\n`);
          process.exit(2);
        }
        opts.palette = v;
        i++;
        break;
      }
      case '--ramp': {
        const v = need(i, a);
        if (!RAMPS[v]) {
          process.stderr.write(`--ramp: unknown '${v}'. try: ${Object.keys(RAMPS).join(', ')}\n`);
          process.exit(2);
        }
        opts.ramp = v;
        i++;
        break;
      }
      case '--color': {
        const v = need(i, a) as ColorDepth;
        if (v !== 'truecolor' && v !== '256' && v !== 'mono') {
          process.stderr.write('--color: expected truecolor, 256 or mono\n');
          process.exit(2);
        }
        opts.color = v;
        i++;
        break;
      }
      case '--braille':
        opts.braille = true;
        break;
      case '--no-braille':
        opts.braille = false;
        break;
      case '--no-hud':
        opts.hud = false;
        break;
      case '--no-awake':
        opts.awake = false;
        break;
      case '--defeat-screensaver':
        opts.defeatScreensaver = true;
        break;
      default:
        process.stderr.write(`unknown option: ${a}\n\n${USAGE}`);
        process.exit(2);
    }
  }
  return { opts };
}

function resolvePlaylist(opts: Options): Scene[] {
  let list: Scene[];
  if (opts.playlist) {
    list = [];
    for (const id of opts.playlist) {
      const s = sceneById(id);
      if (!s) {
        process.stderr.write(`unknown scene: ${id}\nrun --list to see them all\n`);
        process.exit(2);
      }
      list.push(s);
    }
  } else {
    list = [...SCENES];
  }
  if (opts.shuffle) shuffle(list);
  return list;
}

function shuffle<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

async function main(): Promise<void> {
  const { opts, exit } = parseArgs(process.argv.slice(2));
  if (exit) {
    process.exit(await exit());
  }

  const playlist = resolvePlaylist(opts);
  const awake = new Awake({ enabled: opts.awake, defeatScreensaver: opts.defeatScreensaver });
  awake.start();

  const isTty = process.stdout.isTTY === true;
  let cols = Math.max(20, process.stdout.columns ?? 100);
  let rows = Math.max(8, process.stdout.rows ?? 30);

  const depth = opts.color ?? detectColorDepth();
  const screen = new Screen(cols, rows, depth);
  const canvasCur = new Canvas(cols, rows, playlist[0].mode);
  const canvasPrev = new Canvas(cols, rows, playlist[0].mode);
  let cellsCur = makeCells(cols, rows);
  let cellsPrev = makeCells(cols, rows);
  let cellsOut = makeCells(cols, rows);
  // The two canvases swap on every scene change so a scene keeps the same
  // persistent buffers across a transition instead of restarting mid-dissolve.
  const canvases = [canvasCur, canvasPrev];

  let paletteIndex = Math.max(0, PALETTES.findIndex((p) => p.id === opts.palette));
  // Without colour, half-block mode has nothing to say: it encodes the lower of
  // its two pixels entirely as a background colour, so stripping colour turns
  // every non-empty cell into the same solid block. Fall back to the character
  // ramp, which carries its information in the glyph.
  let modeOverride: RenderMode | null =
    opts.mode ?? (depth === 'mono' ? 'ascii' : null);
  // Braille scenes are substituted rather than forced globally: a terminal whose
  // font lacks the block can still show everything else at full fidelity, so
  // only the eight braille scenes get redirected — to half-blocks, which keep
  // sub-character vertical resolution using a glyph every font has.
  const brailleOk = opts.braille ?? supportsBraille();
  const brailleSub: RenderMode | null = brailleOk ? null : 'half';
  let rampOverride: string | null = opts.ramp;
  let speed = opts.speed;
  let paused = false;
  let pinned = opts.duration === 0 || playlist.length === 1;
  let showHud = opts.hud;
  let showHelp = false;

  let index = 0;
  let curT = 0;
  let outgoing: Scene | null = null;
  let outgoingT = 0;
  let transition = 1; // 1 means "done"
  let fps = opts.fps;
  let running = true;

  const effectiveMode = (s: Scene): RenderMode => {
    if (modeOverride) return modeOverride;
    if (s.mode === 'braille' && brailleSub) return brailleSub;
    return s.mode;
  };
  const effectiveRamp = (s: Scene): string =>
    rampOverride ? RAMPS[rampOverride] : (s.ramp ?? RAMPS.classic);

  playlist[0].reset?.(canvasCur);

  const switchTo = (next: number, resetTime = true): void => {
    if (next === index && resetTime) return;
    outgoing = playlist[index];
    outgoingT = curT;
    // Swap which Canvas belongs to the incoming scene.
    const tmp = canvases[0];
    canvases[0] = canvases[1];
    canvases[1] = tmp;
    const tmpCells = cellsCur;
    cellsCur = cellsPrev;
    cellsPrev = tmpCells;
    index = ((next % playlist.length) + playlist.length) % playlist.length;
    curT = 0;
    transition = opts.transition > 0 ? 0 : 1;
    playlist[index].reset?.(canvases[0]);
  };

  const resize = (): void => {
    const nc = Math.max(20, process.stdout.columns ?? cols);
    const nr = Math.max(8, process.stdout.rows ?? rows);
    if (nc === cols && nr === rows) return;
    cols = nc;
    rows = nr;
    cellsCur = makeCells(cols, rows);
    cellsPrev = makeCells(cols, rows);
    cellsOut = makeCells(cols, rows);
    screen.invalidate(cols, rows);
  };

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    running = false;
    if (isTty && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      process.stdin.pause();
    }
    screen.leave();
    awake.stop();
  };

  const quit = (code = 0): void => {
    cleanup();
    process.exit(code);
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0));
  process.on('uncaughtException', (err) => {
    cleanup();
    process.stderr.write(`\n${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });

  if (isTty) {
    process.stdout.on('resize', resize);
    screen.enter();
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (raw: string) => {
      for (const key of splitKeys(raw)) onKey(key);
    });
  }

  function onKey(key: string): void {
    switch (key) {
      case 'q':
      case '\x03': // ctrl-c
      case '\x1b': // bare escape
        quit(0);
        return;
      case 'n':
      case 'RIGHT':
        switchTo(index + 1);
        return;
      case 'p':
      case 'LEFT':
        switchTo(index - 1);
        return;
      case ' ':
        paused = !paused;
        return;
      case 'm': {
        const cur = effectiveMode(playlist[index]);
        modeOverride = RENDER_MODES[(RENDER_MODES.indexOf(cur) + 1) % RENDER_MODES.length];
        return;
      }
      case 'c':
        paletteIndex = (paletteIndex + 1) % PALETTES.length;
        return;
      case 'r': {
        const names = Object.keys(RAMPS);
        const at = rampOverride ? names.indexOf(rampOverride) : -1;
        rampOverride = names[(at + 1) % names.length];
        return;
      }
      case '[':
        speed = Math.max(0.05, speed / 1.25);
        return;
      case ']':
        speed = Math.min(8, speed * 1.25);
        return;
      case '0':
        speed = opts.speed;
        return;
      case 'f':
        pinned = !pinned;
        return;
      case 's':
        shuffle(playlist);
        switchTo(0, false);
        return;
      case 'h':
        showHud = !showHud;
        screen.invalidate(cols, rows);
        return;
      case '?':
      case '/':
        showHelp = !showHelp;
        if (!showHelp) screen.invalidate(cols, rows);
        return;
      default:
        if (key >= '1' && key <= '9') {
          const want = Number(key) - 1;
          if (want < playlist.length) switchTo(want);
        }
    }
  }

  const targetMs = 1000 / opts.fps;
  let last = process.hrtime.bigint();

  const renderScene = (scene: Scene, canvas: Canvas, t: number, dt: number, cells: CellBuffer): void => {
    canvas.configure(cols, rows, effectiveMode(scene));
    canvas.ramp = effectiveRamp(scene);
    scene.render(canvas, { palette: PALETTES[paletteIndex], t, dt });
    canvas.rasterize(cells);
  };

  const frame = (): void => {
    if (!running) return;
    const now = process.hrtime.bigint();
    const realDt = Math.min(0.25, Number(now - last) / 1e9);
    last = now;
    fps += (1 / Math.max(0.001, realDt) - fps) * 0.12;

    const dt = paused ? 0 : realDt * speed;
    curT += dt;
    if (transition < 1 && opts.transition > 0) {
      transition = Math.min(1, transition + realDt / opts.transition);
      if (transition >= 1) outgoing = null;
    }
    if (!pinned && !paused && opts.duration > 0 && curT >= opts.duration) {
      switchTo(index + 1);
    }

    const scene = playlist[index];
    renderScene(scene, canvases[0], curT, dt, cellsCur);

    let out = cellsCur;
    if (outgoing && transition < 1) {
      outgoingT += dt;
      renderScene(outgoing, canvases[1], outgoingT, dt, cellsPrev);
      dissolve(cellsPrev, cellsCur, cellsOut, transition);
      out = cellsOut;
    }

    if (showHud) {
      drawHud(out, {
        index,
        count: playlist.length,
        title: scene.title,
        mode: effectiveMode(scene),
        palette: PALETTES[paletteIndex].id,
        fps,
        speed,
        paused,
        remaining: pinned || opts.duration === 0 ? null : Math.max(0, opts.duration - curT),
        awake: awake.label,
        awakeOk: awake.state === 'holding' || awake.state === 'off',
      });
    }
    if (showHelp) drawHelp(out);

    screen.flush(out);

    const spent = Number(process.hrtime.bigint() - now) / 1e6;
    setTimeout(frame, Math.max(0, targetMs - spent));
  };

  if (!isTty) {
    process.stderr.write('stdout is not a terminal; rendering one frame and exiting.\n');
    renderScene(playlist[0], canvases[0], 0, 1 / opts.fps, cellsCur);
    screen.flush(cellsCur);
    process.stdout.write('\n');
    cleanup();
    return;
  }

  frame();
}

/**
 * Splits a raw stdin chunk into logical keys, folding the arrow-key escape
 * sequences into names. A chunk can hold several keypresses if they arrived
 * faster than the event loop turned over.
 */
function splitKeys(raw: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '\x1b' && raw[i + 1] === '[') {
      const code = raw[i + 2];
      if (code === 'C' || code === 'B') keys.push('RIGHT'); // right / down: next
      else if (code === 'D' || code === 'A') keys.push('LEFT'); // left / up: previous
      i += 3;
      continue;
    }
    keys.push(raw[i]);
    i++;
  }
  return keys;
}

await main();
