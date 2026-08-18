#!/usr/bin/env node
/**
 * tui-saver — a terminal screensaver that refuses to let the host sleep.
 *
 * This file owns the outer loop: parse options, hold the sleep assertion, set up
 * the terminal, then repeatedly render the current scene, dissolve between
 * scenes, and hand finished frames to the diffing writer.
 */

import { hostname } from 'node:os';

import { Awake } from './awake.ts';
import { readBattery, type Battery } from './battery.ts';
import { CliError, parseArgs, resolvePlaylist, shuffle, USAGE, type Options } from './cli.ts';
import { Canvas, makeCells, RAMPS, RENDER_MODES, type CellBuffer, type RenderMode } from './core/canvas.ts';
import { PALETTES } from './core/color.ts';
import type { Scene } from './core/scene.ts';
import { detectColorDepth, Screen, supportsBraille } from './core/screen.ts';
import { batteryGuard, extendLimit, remoteHost, sessionView } from './session.ts';
import { dissolve, drawBanner, drawHelp, drawHud } from './ui.ts';

/**
 * Turns a bad invocation into a message and an exit code. Parsing throws rather
 * than exiting so that it stays testable; this is where that choice is cashed in.
 */
function die(err: unknown): never {
  if (err instanceof CliError) {
    process.stderr.write(`${err.message}\n${err.showUsage ? `\n${USAGE}` : ''}`);
    process.exit(err.code);
  }
  throw err;
}

async function main(): Promise<void> {
  let opts: Options;
  let exit: (() => Promise<number>) | undefined;
  let playlist: Scene[];
  try {
    ({ opts, exit } = parseArgs(process.argv.slice(2)));
    if (exit) process.exit(await exit());
    playlist = resolvePlaylist(opts);
  } catch (err) {
    die(err);
  }
  const awake = new Awake({ enabled: opts.awake, defeatScreensaver: opts.defeatScreensaver });
  awake.start();

  // Asked to guarantee the lock, wait for something better than "the spawn
  // returned" before drawing anything. A watcher that will fail has usually
  // failed by now, and on Windows the shim it compiles first makes a working
  // watcher indistinguishable from a broken one for the first second or two.
  if (opts.requireAwake) {
    const evidence = await awake.confirm();
    if (evidence !== 'os' && evidence !== 'self-report') {
      awake.stop();
      process.stderr.write(
        `--require-awake: could not confirm the sleep lock — ${awake.detail || `only ${evidence}`}\n`,
      );
      process.exit(1);
    }
  }

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

  // One bell per transition into failure, not one per frame.
  let alarmed = false;
  // Read once: neither the hostname nor whether this is an ssh session changes
  // under a running process.
  const remote = remoteHost(process.env, hostname());
  let battery: Battery | null = null;
  let batteryLowSince: number | null = null;
  // Polled regardless of --battery-floor: the charge is worth showing even when
  // nothing will act on it, since the lock is the reason it is going down. One
  // reading a minute — a file read on Linux, one short process elsewhere.
  const pollBattery = (): void => {
    void readBattery().then((b) => {
      battery = b;
    });
  };
  pollBattery();
  const batteryTimer = setInterval(pollBattery, 60_000);
  batteryTimer.unref();

  // Wall clock, not scene time: --speed and pausing change how fast the
  // animation moves, not how long the machine has been kept awake.
  const startedAt = Date.now();
  // Mutable because '+' extends it.
  let sessionLimit = opts.sessionSeconds;
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

  const quit = (code = 0, reason = ''): void => {
    cleanup();
    if (reason) process.stderr.write(`tui-saver: ${reason}\n`);
    if (awake.everFailed) {
      // Said after leaving the alternate screen, where it survives being read.
      process.stderr.write(
        `tui-saver: the sleep lock was not held for part of this run — ${awake.detail}\n`,
      );
      process.exit(1);
    }
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
      case '+':
      case '=':
        // Nothing to extend when the run has no end; silently doing nothing is
        // better than inventing a limit the user never asked for.
        sessionLimit = extendLimit(sessionLimit, 15 * 60);
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

    const elapsed = (Date.now() - startedAt) / 1000;
    const session = sessionView(elapsed, sessionLimit);
    if (session.expired) {
      quit(0);
      return;
    }

    const guard = batteryGuard(battery, opts.batteryFloor, batteryLowSince, Date.now());
    batteryLowSince = guard.lowSince;
    if (guard.stop) {
      quit(0, `battery at ${battery?.percent}% and falling — released the sleep lock`);
      return;
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
        sceneRemaining: pinned || opts.duration === 0 ? null : Math.max(0, opts.duration - curT),
        elapsed,
        sessionRemaining: session.remaining,
        battery,
        remote,
        awake: awake.label,
        awakeOk: awake.state === 'holding' || awake.state === 'off',
      });
    }
    if (awake.state === 'failed') {
      if (!alarmed) {
        alarmed = true;
        process.stdout.write('\x07');
      }
      drawBanner(out, `NOT holding the sleep lock — ${awake.detail}`);
    } else {
      alarmed = false;
      if (guard.secondsLeft !== null) {
        drawBanner(
          out,
          `battery ${battery?.percent}% — releasing the sleep lock in ${guard.secondsLeft}s`,
        );
      }
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
    // A watcher that cannot be launched at all reports it on the next tick, and
    // this path is otherwise short enough to finish before hearing about it.
    await new Promise((resolve) => setImmediate(resolve));
    quit(0);
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
