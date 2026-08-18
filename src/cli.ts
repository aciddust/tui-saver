/**
 * Command line surface: the option table, the usage text, and the parser.
 *
 * Split out of main.ts so that parsing is reachable without starting a
 * screensaver. Parse failures throw CliError rather than calling process.exit,
 * which is what makes them testable — and keeps the decision about how to die in
 * the one place that owns the terminal.
 */

import { RAMPS, RENDER_MODES, type RenderMode } from './core/canvas.ts';
import { PALETTES, paletteById } from './core/color.ts';
import type { ColorDepth } from './core/screen.ts';
import type { Scene } from './core/scene.ts';
import { SCENES, sceneById } from './scenes/index.ts';
import { doctor } from './awake.ts';

export type Options = {
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

export const DEFAULTS: Options = {
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

/** A bad invocation. Carries the exit code so the caller need not invent one. */
export class CliError extends Error {
  readonly code: number;
  /** Whether the usage text belongs after the message. */
  readonly showUsage: boolean;

  constructor(message: string, code = 2, showUsage = false) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.showUsage = showUsage;
  }
}

export const USAGE = `tui-saver — geometric ASCII screensaver that keeps the host awake

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

export function parseArgs(argv: string[]): { opts: Options; exit?: () => Promise<number> } {
  const opts: Options = { ...DEFAULTS };
  const need = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new CliError(`${name} needs a value`);
    return v;
  };
  const num = (raw: string, name: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new CliError(`${name}: not a number: ${raw}`);
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
          throw new CliError(`--mode: expected one of ${RENDER_MODES.join(', ')}`);
        }
        opts.mode = v;
        i++;
        break;
      }
      case '--palette': {
        const v = need(i, a);
        if (!paletteById(v)) {
          throw new CliError(
            `--palette: unknown '${v}'. try: ${PALETTES.map((p) => p.id).join(', ')}`,
          );
        }
        opts.palette = v;
        i++;
        break;
      }
      case '--ramp': {
        const v = need(i, a);
        if (!RAMPS[v]) {
          throw new CliError(`--ramp: unknown '${v}'. try: ${Object.keys(RAMPS).join(', ')}`);
        }
        opts.ramp = v;
        i++;
        break;
      }
      case '--color': {
        const v = need(i, a) as ColorDepth;
        if (v !== 'truecolor' && v !== '256' && v !== 'mono') {
          throw new CliError('--color: expected truecolor, 256 or mono');
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
        throw new CliError(`unknown option: ${a}`, 2, true);
    }
  }
  return { opts };
}

export function resolvePlaylist(opts: Options): Scene[] {
  let list: Scene[];
  if (opts.playlist) {
    list = [];
    for (const id of opts.playlist) {
      const s = sceneById(id);
      if (!s) throw new CliError(`unknown scene: ${id}\nrun --list to see them all`);
      list.push(s);
    }
  } else {
    list = [...SCENES];
  }
  if (opts.shuffle) shuffle(list);
  return list;
}

export function shuffle<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}
