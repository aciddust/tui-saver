/**
 * Keeping the host awake.
 *
 * One idea, three operating systems. Every platform here has some way to say
 * "don't idle out while I'm running", and on all three we express it the same
 * way: launch a small helper process that takes the lock and then *watches our
 * pid*, so it releases on its own when we go away.
 *
 * That indirection is the whole design. A lock held by us leaks if we are killed
 * with SIGKILL or TerminateProcess, because no cleanup handler runs. A lock held
 * by a watcher cannot leak, because the watcher notices the pid is gone — and if
 * the watcher itself is killed, the OS drops the lock with the process. There is
 * no path that leaves a machine permanently unable to sleep.
 *
 *   macOS    caffeinate -dis -w <pid>
 *   Windows  powershell -> SetThreadExecutionState, then Wait-Process <pid>
 *   Linux    systemd-inhibit --what=idle:sleep -- tail --pid=<pid> -f /dev/null
 *
 * What none of them do is stop the screen saver or lock screen, which run off a
 * separate idle timer and would cover the animation. `--defeat-screensaver`
 * mitigates that per platform by declaring synthetic user activity; it is
 * best-effort and cannot override a security policy that locks the screen, nor
 * should it.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';

export type AwakeState = 'off' | 'holding' | 'unsupported' | 'failed';

export type AwakeOptions = {
  /** Hold the sleep lock at all. */
  enabled: boolean;
  /** Also declare synthetic user activity to hold off the screen saver. */
  defeatScreensaver: boolean;
};

/** How to verify the lock from outside this program. */
export type VerifyCommand = {
  cmd: string;
  args: string[];
  /** Substrings that indicate the lock is genuinely held. */
  expect: string[];
  /** Shown to the user as the command to run themselves. */
  display: string;
  needsElevation?: boolean;
};

/** A command to run, with no side effects from describing it. */
export type WatcherCommand = {
  cmd: string;
  args: string[];
  opts: { stdio: 'ignore'; windowsHide?: boolean };
};

type Backend = {
  platform: string;
  /** Short description of the mechanism, for --doctor. */
  mechanism: string;
  /**
   * The watcher command. Deliberately pure: returning the command rather than
   * spawning it means the Windows script — which cannot be executed on a
   * development machine that has no PowerShell — is still inspectable and
   * testable as data.
   *
   * `pulse` asks the watcher to also declare user activity. On Windows that
   * folds into the same child; elsewhere it needs a separate timer, hence
   * `startPulse` below.
   */
  command(pid: number, pulse: boolean): WatcherCommand;
  /**
   * Starts platform-specific synthetic-activity pulses that cannot live inside
   * the watcher process. Returns a stop function.
   */
  startPulse?(): () => void;
  verify: VerifyCommand | null;
  /** Platform-specific caveats printed by --doctor. */
  notes: readonly string[];
};

/**
 * Fires `run` immediately and then every 45 seconds, ignoring failures — a
 * dropped pulse is not worth interrupting the animation for.
 */
function repeatEvery45s(run: () => void): () => void {
  const tick = (): void => {
    try {
      run();
    } catch {
      /* best effort */
    }
  };
  tick();
  const timer = setInterval(tick, 45_000);
  timer.unref();
  return () => clearInterval(timer);
}

function fireAndForget(cmd: string, args: string[]): void {
  const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
  p.on('error', () => {});
  p.unref();
}

// ---------------------------------------------------------------------------
// macOS

const darwin: Backend = {
  platform: 'darwin',
  mechanism: 'caffeinate -dis -w <pid>',
  command(pid) {
    // -d display sleep, -i idle system sleep, -s system sleep on AC power.
    return { cmd: 'caffeinate', args: ['-dis', '-w', String(pid)], opts: { stdio: 'ignore' } };
  },
  startPulse() {
    // A short-lived assertion per pulse; caffeinate -u needs -t and exits by
    // itself, so there is nothing to track.
    return repeatEvery45s(() => fireAndForget('caffeinate', ['-u', '-t', '2']));
  },
  verify: {
    cmd: 'pmset',
    args: ['-g', 'assertions'],
    expect: ['PreventUserIdleDisplaySleep', 'PreventUserIdleSystemSleep'],
    display: 'pmset -g assertions',
  },
  notes: [
    'The screen saver and lock screen use a separate idle timer. Run with',
    '--defeat-screensaver to also pulse synthetic user activity.',
    'Closing a laptop lid sleeps the machine regardless, unless it is on AC',
    'power with an external display attached.',
  ],
};

// ---------------------------------------------------------------------------
// Windows

/**
 * Builds the PowerShell the watcher runs.
 *
 * `SetThreadExecutionState` is the Win32 call that suppresses idle timeouts, and
 * the request belongs to the calling thread — so the process holding it has to
 * stay alive, and the request goes away when it exits. That makes a PowerShell
 * child sitting on `Wait-Process` an exact analogue of `caffeinate -w`.
 *
 * The pulse uses `SendKeys('{F15}')` rather than P/Invoking `SendInput`: F15 is
 * a key virtually nothing binds, and it avoids hand-marshalling the INPUT union,
 * where a wrong `cbSize` makes the call fail silently.
 */
function windowsScript(pid: number, pulse: boolean): string {
  // ES_CONTINUOUS 0x80000000 | ES_SYSTEM_REQUIRED 0x1 | ES_DISPLAY_REQUIRED 0x2
  const HOLD = 2147483651;
  // ES_CONTINUOUS on its own clears the request.
  const RELEASE = 2147483648;
  return [
    // Stop, not Continue: if Add-Type cannot compile the shim we want the
    // watcher to die immediately so the parent notices and the status bar reads
    // awake:FAIL, rather than limping on holding nothing.
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -TypeDefinition @'`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public static class Awake {`,
    `  [DllImport("kernel32.dll", SetLastError = true)]`,
    `  public static extern uint SetThreadExecutionState(uint esFlags);`,
    `}`,
    `'@`,
    `[void][Awake]::SetThreadExecutionState([uint32]${HOLD})`,
    // The keystroke line is omitted entirely rather than guarded at runtime.
    // This program gets distributed, and someone reading the script — or a
    // security tool scanning it — should find no input-injection code at all
    // unless --defeat-screensaver actually asked for it.
    ...(pulse ? [`$shell = New-Object -ComObject WScript.Shell`] : []),
    `try {`,
    `  while ($true) {`,
    // Returns as soon as the pid exits, or after 45s — so release is prompt and
    // the pulse cadence comes for free from the same wait.
    `    Wait-Process -Id ${pid} -Timeout 45 -ErrorAction SilentlyContinue`,
    `    if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { break }`,
    ...(pulse ? [`    $shell.SendKeys('{F15}')`] : []),
    `  }`,
    `} finally {`,
    `  [void][Awake]::SetThreadExecutionState([uint32]${RELEASE})`,
    `}`,
  ].join('\n');
}

const win32: Backend = {
  platform: 'win32',
  mechanism: 'powershell SetThreadExecutionState + Wait-Process <pid>',
  command(pid, pulse) {
    // -EncodedCommand takes base64 UTF-16LE, which sidesteps every layer of
    // quoting between here and PowerShell's parser.
    const encoded = Buffer.from(windowsScript(pid, pulse), 'utf16le').toString('base64');
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      // windowsHide keeps a console window from flashing up over the animation.
      opts: { stdio: 'ignore', windowsHide: true },
    };
  },
  verify: {
    cmd: 'powercfg',
    args: ['/requests'],
    expect: ['DISPLAY', 'SYSTEM'],
    display: 'powercfg /requests   (run as Administrator)',
    needsElevation: true,
  },
  notes: [
    'SetThreadExecutionState does not stop the screen saver. Run with',
    '--defeat-screensaver to also send a harmless F15 keystroke every 45s.',
    'A screen lock enforced by group policy cannot be overridden this way.',
    'Closing a laptop lid follows the lid-close power setting regardless.',
    'powercfg /requests needs an elevated prompt; without it Windows refuses',
    'to report the request table at all.',
  ],
};

// ---------------------------------------------------------------------------
// Linux

const linux: Backend = {
  platform: 'linux',
  mechanism: 'systemd-inhibit --what=idle:sleep -- tail --pid=<pid> -f /dev/null',
  command(pid) {
    // systemd-inhibit holds the lock for exactly as long as its child runs, and
    // `tail --pid` blocks until that pid exits without polling.
    return {
      cmd: 'systemd-inhibit',
      args: [
        '--what=idle:sleep',
        '--who=tui-saver',
        '--why=Running a terminal screensaver',
        '--mode=block',
        'tail',
        `--pid=${pid}`,
        '-f',
        '/dev/null',
      ],
      opts: { stdio: 'ignore' },
    };
  },
  startPulse() {
    // xdg-screensaver is the portable one: a shell script that dispatches to
    // whatever screen locker is actually running.
    return repeatEvery45s(() => fireAndForget('xdg-screensaver', ['reset']));
  },
  verify: {
    cmd: 'systemd-inhibit',
    args: ['--list'],
    expect: ['tui-saver'],
    display: 'systemd-inhibit --list',
  },
  notes: [
    'Needs systemd-logind, which is what desktop distributions use. On a system',
    'without it the animation still runs but nothing holds the idle timer.',
    'The screen locker is separate. --defeat-screensaver calls',
    'xdg-screensaver reset, which needs xdg-utils installed.',
  ],
};

const BACKENDS: readonly Backend[] = [darwin, win32, linux];

function backendFor(platform: string): Backend | undefined {
  return BACKENDS.find((b) => b.platform === platform);
}

/** Platforms with a sleep-suppression backend. */
export function supportedPlatforms(): string[] {
  return BACKENDS.map((b) => b.platform);
}

/**
 * The watcher command for a platform, without running it. Exists so the Windows
 * script can be checked on a machine that cannot execute PowerShell.
 */
export function watcherCommandFor(
  platform: string,
  pid: number,
  pulse: boolean,
): WatcherCommand | null {
  return backendFor(platform)?.command(pid, pulse) ?? null;
}

export class Awake {
  state: AwakeState = 'off';
  detail = '';
  private child: ChildProcess | null = null;
  private stopPulse: (() => void) | null = null;
  private opts: AwakeOptions;
  private backend: Backend | undefined;

  constructor(opts: AwakeOptions) {
    this.opts = opts;
    this.backend = backendFor(process.platform);
  }

  start(): void {
    if (!this.opts.enabled) {
      this.state = 'off';
      this.detail = 'disabled by --no-awake';
      return;
    }
    const backend = this.backend;
    if (!backend) {
      this.state = 'unsupported';
      this.detail = `no sleep-suppression backend for ${process.platform}`;
      return;
    }
    try {
      const { cmd, args, opts } = backend.command(process.pid, this.opts.defeatScreensaver);
      const child = spawn(cmd, args, opts);
      this.child = child;
      child.on('error', (err: Error) => {
        this.state = 'failed';
        this.detail = err.message;
        this.child = null;
      });
      child.on('exit', (code) => {
        // Only meaningful if the watcher dies while we are still running.
        if (this.state === 'holding') {
          this.state = 'failed';
          this.detail = `watcher exited early (code ${code})`;
        }
        this.child = null;
      });
      this.state = 'holding';
      this.detail = backend.mechanism;
      if (this.opts.defeatScreensaver) {
        this.detail += ' +user-activity';
        // Windows folds the pulse into the watcher itself; the others need a
        // timer here.
        this.stopPulse = backend.startPulse?.() ?? null;
      }
    } catch (err) {
      this.state = 'failed';
      this.detail = err instanceof Error ? err.message : String(err);
    }
  }

  stop(): void {
    if (this.stopPulse) {
      this.stopPulse();
      this.stopPulse = null;
    }
    const child = this.child;
    this.child = null;
    this.state = 'off';
    // The watcher would notice our exit by itself, but asking it to go now means
    // the lock drops the moment we quit rather than a beat later.
    if (child && child.pid) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }

  get label(): string {
    switch (this.state) {
      case 'holding':
        return 'awake';
      case 'off':
        return 'awake:off';
      case 'unsupported':
        return 'awake:n/a';
      default:
        return 'awake:FAIL';
    }
  }
}

/**
 * Prints what the OS itself reports, so "is it really staying awake?" is
 * answerable without taking this program's word for it. Holds the same lock the
 * real run would, then asks the platform's own tool about it.
 */
export async function doctor(): Promise<number> {
  const out = (s = ''): void => {
    process.stdout.write(`${s}\n`);
  };
  out('tui-saver --doctor');
  out(`  platform      ${process.platform} (${process.arch})`);
  out(`  pid           ${process.pid}`);

  const backend = backendFor(process.platform);
  if (!backend) {
    out('');
    out(`  No sleep-suppression backend for ${process.platform}.`);
    out('  The animation runs; the host may sleep under it.');
    out(`  Supported: ${supportedPlatforms().join(', ')}`);
    return 1;
  }

  out(`  mechanism     ${backend.mechanism}`);

  let held: ChildProcess;
  try {
    const { cmd, args, opts } = backend.command(process.pid, false);
    held = spawn(cmd, args, opts);
  } catch (err) {
    out(`  watcher       FAILED to launch: ${String(err)}`);
    return 1;
  }
  let launchError: string | null = null;
  held.on('error', (err) => {
    launchError = err.message;
  });

  // PowerShell has to compile the P/Invoke shim on first use, so give the
  // watcher long enough to actually take the lock before asking about it.
  await new Promise((resolve) => setTimeout(resolve, process.platform === 'win32' ? 3500 : 400));

  if (launchError) {
    out(`  watcher       FAILED: ${launchError}`);
    printNotes(out, backend);
    return 1;
  }
  out(`  watcher       running (pid ${held.pid})`);

  const v = backend.verify;
  let exit = 0;
  if (v) {
    out('');
    out(`  asking the OS (${v.display}):`);
    let report = '';
    let failed: string | null = null;
    try {
      report = execFileSync(v.cmd, v.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    if (failed) {
      out(`    could not run it: ${failed.split('\n')[0]}`);
      if (v.needsElevation) {
        out('    this command needs an elevated prompt; that is expected here,');
        out('    and does not by itself mean the lock is not held.');
      } else {
        exit = 1;
      }
    } else {
      for (const key of v.expect) {
        const hit = report.includes(key);
        out(`    ${key.padEnd(28)} ${hit ? 'present' : 'NOT FOUND'}`);
        if (!hit) exit = 1;
      }
      const mine = report
        .split('\n')
        .filter((l) => l.toLowerCase().includes('caffeinate') || l.includes('tui-saver'))
        .map((l) => l.trim())
        .filter(Boolean);
      if (mine.length) {
        out('');
        out('  entries naming this program:');
        for (const l of mine.slice(0, 8)) out(`    ${l}`);
      }
    }
  }

  printNotes(out, backend);
  try {
    held.kill();
  } catch {
    /* already gone */
  }
  return exit;
}

function printNotes(out: (s?: string) => void, backend: Backend): void {
  out('');
  out('  notes:');
  for (const n of backend.notes) out(`    ${n}`);
  out('');
  out('  The watcher holds the lock and watches this pid, so the lock is');
  out('  released even if this program is killed outright.');
}
