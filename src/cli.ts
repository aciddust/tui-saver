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
  /** Refuse to run at all unless the lock is confirmed held. */
  requireAwake: boolean;
  defeatScreensaver: boolean;
  /** null = detect whether the terminal font is likely to have braille. */
  braille: boolean | null;
  /**
   * Seconds after which the whole run ends by itself, or null to run until
   * quit. Resolved here so that --for and --until are the same thing by the time
   * anything downstream sees them.
   */
  sessionSeconds: number | null;
  /**
   * Release the lock and end the run below this charge, while on battery.
   * 0 disables it. On by default because the cost of getting this wrong is a
   * flat laptop in a bag, and machines with no battery are unaffected.
   */
  batteryFloor: number;
  /**
   * A pid to hold the lock for. The run ends when it exits, which is the reason
   * anybody turns a keep-awake on in the first place.
   */
  whilePid: number | null;
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
  requireAwake: false,
  defeatScreensaver: false,
  braille: null,
  sessionSeconds: null,
  batteryFloor: 15,
  whilePid: null,
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

/**
 * A span written the way people say it: 90s, 90m, 2h, 1h30m. A bare number is
 * seconds, matching --duration and --transition rather than inventing a second
 * convention for the same kind of value.
 */
export function parseDuration(raw: string): number {
  const text = raw.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const m = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) {
    throw new CliError(`not a duration: '${raw}'. try 90s, 45m, 2h or 1h30m`);
  }
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * Seconds from now until the next occurrence of a wall-clock time. A time that
 * has already passed today means that time tomorrow — as does the current
 * minute, since asking to stop at 14:00 at 14:00 is a request for a whole day,
 * not for nothing at all.
 */
export function parseUntil(raw: string, now: Date = new Date()): number {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  const hours = m ? Number(m[1]) : NaN;
  const minutes = m ? Number(m[2]) : NaN;
  if (!m || hours > 23 || minutes > 59) {
    throw new CliError(`not a time of day: '${raw}'. try 18:00`);
  }
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  const seconds = Math.round((target.getTime() - now.getTime()) / 1000);
  return seconds > 0 ? seconds : seconds + 24 * 3600;
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
  --for <90m|2h|1h30m>    end the whole run after this long
  --until <HH:MM>         end the whole run at this time of day
  --while <pid>           end the whole run when that process exits

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
  --require-awake         exit rather than run without a confirmed lock
  --battery-floor <pct>   end the run below this charge on battery
                          (0 disables)                          [${DEFAULTS.batteryFloor}]
  --defeat-screensaver    also pulse synthetic user activity so the screen
                          saver and lock screen stay away
  --doctor                report what the kernel says about the assertions

other
  --list                  list scenes and exit
  -h, --help              this text
`;

export function parseArgs(argv: string[]): { opts: Options; exit?: () => Promise<number> } {
  const opts: Options = { ...DEFAULTS };
  // Which flag set the session limit, so that repeating one flag is last-wins
  // while asking for two different limits is an error.
  let limitFrom: string | null = null;
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
      case '--for':
      case '--until': {
        if (limitFrom !== null && limitFrom !== a) {
          throw new CliError(`${limitFrom} and ${a} both set the session limit; pick one`);
        }
        limitFrom = a;
        const v = need(i, a);
        opts.sessionSeconds = a === '--for' ? parseDuration(v) : parseUntil(v);
        if (opts.sessionSeconds === 0) {
          throw new CliError('--for 0 would end the run immediately; omit it to run until quit');
        }
        i++;
        break;
      }
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
      case '--require-awake':
        opts.requireAwake = true;
        break;
      case '--while': {
        const v = num(need(i, a), a);
        if (!Number.isInteger(v) || v < 1) {
          throw new CliError(`${a}: expected a pid, got ${need(i, a)}`);
        }
        opts.whilePid = v;
        i++;
        break;
      }
      case '--battery-floor': {
        const v = num(need(i, a), a);
        // Not clamped: clamping turns a typo into a policy without saying so.
        if (!Number.isInteger(v) || v < 0 || v > 100) {
          throw new CliError(`${a}: expected a whole percentage from 0 to 100, got ${v}`);
        }
        opts.batteryFloor = v;
        i++;
        break;
      }
      case '--defeat-screensaver':
        opts.defeatScreensaver = true;
        break;
      default:
        throw new CliError(`unknown option: ${a}`, 2, true);
    }
  }
  if (opts.requireAwake && !opts.awake) {
    throw new CliError('--require-awake and --no-awake contradict each other; pick one');
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
