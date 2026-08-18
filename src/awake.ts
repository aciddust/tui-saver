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
 *   Linux    systemd-inhibit --what=idle -- tail --pid=<pid> -f /dev/null
 *
 * What none of them do is stop the screen saver or lock screen, which run off a
 * separate idle timer and would cover the animation. `--defeat-screensaver`
 * mitigates that per platform by declaring synthetic user activity; it is
 * best-effort and cannot override a security policy that locks the screen, nor
 * should it.
 */

import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';

export type AwakeState = 'off' | 'holding' | 'unsupported' | 'failed';

/**
 * What a watcher prints on stdout once it has confirmed the lock is held, and
 * again on every wait iteration. Only Windows can report this — caffeinate and
 * systemd-inhibit are not ours to teach — but where it exists it is better
 * evidence than "the child process is still alive", and it removes the fixed
 * delay that asking the OS too early would otherwise need.
 */
export const HELD_MARKER = 'tui-saver:held';

/**
 * What a watcher prints on stdout, followed by a message, when it is giving up.
 *
 * Windows needs this because stderr cannot carry a reason there: PowerShell
 * serialises a redirected stderr as CLIXML, whose first line is always
 * "#< CLIXML", so a failure read from it says nothing at all. Reporting on stdout
 * keeps the message intact.
 */
export const ERROR_MARKER = 'tui-saver:error';

export type AwakeOptions = {
  /** Hold the sleep lock at all. */
  enabled: boolean;
  /** Also declare synthetic user activity to hold off the screen saver. */
  defeatScreensaver: boolean;
  /**
   * How often to ask the OS whether the lock is still held. 0 disables it.
   * A running watcher is not proof: the lock could have been refused, or dropped
   * by something outside this program, and the process would look identical.
   */
  verifyIntervalMs?: number;
};

/**
 * How good the reason to believe the lock is held actually is. Worth
 * distinguishing because the three platforms cannot offer the same one: only
 * some can be asked, and where they cannot, saying so is better than implying an
 * answer nobody gave.
 *
 *   os           the platform's own tool reports the lock, recently
 *   self-report  the watcher says it holds it; nobody independent has agreed
 *   liveness     the watcher process is running, and that is all we know
 *   none         we are not holding anything
 */
export type AwakeEvidence = 'none' | 'liveness' | 'self-report' | 'os';

/** Default seconds between re-verifications. */
const VERIFY_INTERVAL_MS = 90_000;

/**
 * How many intervals an answer stays good for. Beyond this the answer is stale —
 * which happens when the query itself starts failing — and evidence drops back
 * rather than showing a tick mark earned hours ago.
 */
const STALE_AFTER_INTERVALS = 3;

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
  opts: { stdio: 'ignore' | ('ignore' | 'pipe')[]; windowsHide?: boolean };
};

export type Backend = {
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
    return {
      cmd: 'caffeinate',
      args: ['-dis', '-w', String(pid)],
      opts: { stdio: ['ignore', 'ignore', 'pipe'] },
    };
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
    // Everything is inside the try, Add-Type included: compiling the shim is the
    // likeliest thing to fail here, and it happens before the loop is entered.
    `try {`,
    `Add-Type -TypeDefinition @'`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public static class Awake {`,
    `  [DllImport("kernel32.dll", SetLastError = true)]`,
    `  public static extern uint SetThreadExecutionState(uint esFlags);`,
    `}`,
    `'@`,
    // The return value is the *previous* state, or 0 if the request was refused.
    // Discarding it — which this line used to do — left a watcher sitting in its
    // wait loop holding nothing at all while the parent happily reported awake.
    `$r = [Awake]::SetThreadExecutionState([uint32]${HOLD})`,
    `if ($r -eq 0) { throw 'SetThreadExecutionState refused the request' }`,
    `Write-Output '${HELD_MARKER}'`,
    // The keystroke line is omitted entirely rather than guarded at runtime.
    // This program gets distributed, and someone reading the script — or a
    // security tool scanning it — should find no input-injection code at all
    // unless --defeat-screensaver actually asked for it.
    ...(pulse ? [`$shell = New-Object -ComObject WScript.Shell`] : []),
    `  try {`,
    `    while ($true) {`,
    // Returns as soon as the pid exits, or after 45s — so release is prompt and
    // the pulse cadence comes for free from the same wait.
    `      Wait-Process -Id ${pid} -Timeout 45 -ErrorAction SilentlyContinue`,
    `      if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { break }`,
    // Re-asserting the same flags is a no-op the OS is happy to repeat, and it
    // turns the wait loop into a heartbeat: the parent learns the request is
    // still real without needing the elevated prompt powercfg would want.
    `      $r = [Awake]::SetThreadExecutionState([uint32]${HOLD})`,
    `      if ($r -eq 0) { throw 'SetThreadExecutionState refused the request' }`,
    `      Write-Output '${HELD_MARKER}'`,
    ...(pulse ? [`      $shell.SendKeys('{F15}')`] : []),
    `    }`,
    `  } finally {`,
    `    [void][Awake]::SetThreadExecutionState([uint32]${RELEASE})`,
    `  }`,
    // Reported on stdout, not stderr: PowerShell serialises a redirected stderr
    // as CLIXML, so a reason read from there arrives as "#< CLIXML".
    `} catch {`,
    `  Write-Output "${ERROR_MARKER} $($_.Exception.Message)"`,
    `  exit 1`,
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
      // stdout carries the watcher's own report; stderr carries the reason it
      // could not make one — if Add-Type fails to compile the shim, that text is
      // the only thing that says so.
      // windowsHide keeps a console window from flashing up over the animation.
      opts: { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
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
  mechanism: 'systemd-inhibit --what=idle -- tail --pid=<pid> -f /dev/null',
  command(pid) {
    // systemd-inhibit holds the lock for exactly as long as its child runs, and
    // `tail --pid` blocks until that pid exits without polling.
    return {
      cmd: 'systemd-inhibit',
      args: [
        // idle, and only idle. Measured on a machine with no login session:
        // --what=idle --mode=block is granted, while sleep and shutdown block are
        // refused by polkit with "Access denied". A systemd-inhibit request is
        // atomic, so asking for idle:sleep there loses the idle inhibitor as
        // well and holds nothing at all — over SSH, headless, or anywhere else
        // without a seat.
        //
        // Nothing is really given up by narrowing it. Blocking sleep would also
        // block an explicit suspend — a lid close, systemctl suspend, the power
        // button — which is the user asking for something, not the idle timer
        // taking it. macOS makes the same concession from the other direction:
        // caffeinate's -s is documented as valid only on AC power, so the
        // strongest component is silently dropped on battery there too.
        '--what=idle',
        '--who=tui-saver',
        '--why=Running a terminal screensaver',
        '--mode=block',
        'tail',
        `--pid=${pid}`,
        '-f',
        '/dev/null',
      ],
      opts: { stdio: ['ignore', 'ignore', 'pipe'] },
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
    'The inhibitor covers the idle timer only. An explicit suspend — a lid close,',
    'systemctl suspend — still sleeps the machine, and blocking that needs an',
    'active login session that polkit will authorise.',
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
  /**
   * Whether the lock was ever lost during this run. The animation carries on
   * either way, but a run that spent time not holding what it promised should
   * not exit claiming success.
   */
  everFailed = false;
  /** When the OS last confirmed the lock, or null if it never has. */
  lastVerifiedAt: number | null = null;
  private lastHeartbeatAt: number | null = null;
  /** The watcher's first usable line of stderr, if it made one. */
  private lastStderr = '';
  /** What the watcher said about itself on stdout, which beats guessing. */
  private reported = '';
  private verifyTimer: NodeJS.Timeout | null = null;
  private child: ChildProcess | null = null;
  private stopPulse: (() => void) | null = null;
  private opts: AwakeOptions;
  private backend: Backend | null;
  /**
   * One replacement, not an unbounded supply. A watcher that dies because
   * something transient got in the way is worth relaunching; a watcher that
   * cannot stay up is a fact to report, and retrying it forever would be a
   * process-spawn loop nobody asked for.
   */
  private retriesLeft = 1;

  /**
   * @param backend defaults to this platform's. Pass one explicitly — or null
   * for none — to drive the state machine somewhere other than where it runs.
   */
  constructor(opts: AwakeOptions, backend?: Backend | null) {
    this.opts = opts;
    this.backend = backend === undefined ? (backendFor(process.platform) ?? null) : backend;
  }

  /** The pid of the process currently holding the lock, if there is one. */
  get watcherPid(): number | null {
    return this.child?.pid ?? null;
  }

  private get verifyInterval(): number {
    return this.opts.verifyIntervalMs ?? VERIFY_INTERVAL_MS;
  }

  /** How good our reason to believe the lock is held actually is. */
  get evidence(): AwakeEvidence {
    if (this.state !== 'holding') return 'none';
    const fresh = this.verifyInterval * STALE_AFTER_INTERVALS;
    if (this.lastVerifiedAt !== null && Date.now() - this.lastVerifiedAt < fresh) return 'os';
    if (this.lastHeartbeatAt !== null) return 'self-report';
    return 'liveness';
  }

  start(): void {
    if (!this.opts.enabled) {
      this.state = 'off';
      this.detail = 'disabled by --no-awake';
      return;
    }
    if (!this.backend) {
      this.state = 'unsupported';
      this.detail = `no sleep-suppression backend for ${process.platform}`;
      return;
    }
    this.launch();
    this.scheduleVerify(Math.min(this.verifyInterval, 500));
  }

  /**
   * Asks the platform's own tool whether the lock is held, on a timer that
   * reschedules itself only after each answer arrives — so a slow query cannot
   * stack up behind itself.
   */
  private scheduleVerify(delay: number): void {
    const v = this.backend?.verify;
    // An elevated query is no use here: it would fail for a reason that says
    // nothing about the lock, every single time.
    if (!v || v.needsElevation || this.verifyInterval <= 0) return;
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = setTimeout(() => {
      if (this.state !== 'holding') return;
      execFile(v.cmd, v.args, { encoding: 'utf8' }, (err, stdout) => {
        if (this.state !== 'holding') return;
        if (err) {
          // Being unable to ask is not a no. The answer simply goes stale, which
          // `evidence` reports on its own without inventing a failure.
        } else {
          const missing = v.expect.filter((key) => !stdout.includes(key));
          if (missing.length > 0) {
            this.fail(`the OS no longer reports ${missing.join(', ')} — ${v.display}`);
            return;
          }
          this.lastVerifiedAt = Date.now();
        }
        this.scheduleVerify(this.verifyInterval);
      });
    }, delay);
    this.verifyTimer.unref();
  }

  private launch(): void {
    const backend = this.backend;
    if (!backend) return;
    try {
      const { cmd, args, opts } = backend.command(process.pid, this.opts.defeatScreensaver);
      const child = spawn(cmd, args, opts);
      this.child = child;
      this.lastStderr = '';
      this.reported = '';
      this.readHeartbeat(child);
      this.readComplaint(child);
      child.on('error', (err: Error) => {
        this.child = null;
        // A command that cannot be launched will not launch on the second ask
        // either, so this one does not retry.
        this.fail(err.message);
      });
      // 'close' rather than 'exit': it fires once the child's streams are done,
      // so whatever it said on the way out has arrived and can be reported.
      child.on('close', (code, signal) => {
        this.child = null;
        // Any other state means we are shutting down, or already know we failed.
        if (this.state !== 'holding') return;
        if (this.retriesLeft > 0) {
          this.retriesLeft--;
          this.launch();
          return;
        }
        // The watcher's own account first; stderr only if it did not give one.
        const reason = this.reported || this.lastStderr;
        const said = reason ? `: ${reason}` : '';
        this.fail(
          `watcher exited early (code ${code}${signal ? `, ${signal}` : ''})${said}`,
        );
      });
      this.state = 'holding';
      this.detail = backend.mechanism;
      if (this.opts.defeatScreensaver) {
        this.detail += ' +user-activity';
        // Windows folds the pulse into the watcher itself; the others need a
        // timer here.
        this.stopPulse ??= backend.startPulse?.() ?? null;
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Consumes the watcher's own reports, where it has any. Only the Windows
   * watcher can talk: it is a script we wrote, and it prints a line each time it
   * has re-asserted the flags. Reading whole lines matters — a timestamp updated
   * by a repeated substring in a growing buffer would say "still held" forever.
   */
  private readHeartbeat(child: ChildProcess): void {
    const out = child.stdout;
    if (!out) return;
    out.setEncoding('utf8');
    let pending = '';
    out.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (line === HELD_MARKER) this.lastHeartbeatAt = Date.now();
        else if (line.startsWith(ERROR_MARKER)) {
          this.reported = line.slice(ERROR_MARKER.length).trim();
        }
      }
    });
    out.on('error', () => {
      /* the exit handler is the one that matters */
    });
  }

  /**
   * Keeps the watcher's first line of stderr. systemd-inhibit and PowerShell both
   * explain themselves there before giving up, and "exited early (code 1)" is not
   * something a user can act on.
   */
  private readComplaint(child: ChildProcess): void {
    const err = child.stderr;
    if (!err) return;
    err.setEncoding('utf8');
    err.on('data', (chunk: string) => {
      if (this.lastStderr) return;
      const line = chunk
        .split('\n')
        .map((l) => l.trim())
        // PowerShell prefixes a redirected stderr with a CLIXML envelope. None of
        // it is a message, and taking the first line would take that every time.
        .find((l) => l && !l.startsWith('#<') && !l.startsWith('<'));
      if (line) this.lastStderr = line.slice(0, 200);
    });
    err.on('error', () => {
      /* the close handler is the one that matters */
    });
  }

  private fail(detail: string): void {
    this.state = 'failed';
    this.detail = detail;
    this.everFailed = true;
  }

  stop(): void {
    if (this.verifyTimer) {
      clearTimeout(this.verifyTimer);
      this.verifyTimer = null;
    }
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

  /**
   * Waits for something better than liveness, or gives up. Used by
   * --require-awake, where "the spawn returned" is not an answer: the Windows
   * watcher has to compile a P/Invoke shim before it can take the lock, so it
   * looks identical to a working one for the first second or two.
   */
  async confirm(timeoutMs = 5000): Promise<AwakeEvidence> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = this.evidence;
      if (now === 'os' || now === 'self-report' || now === 'none') return now;
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.evidence;
  }

  get label(): string {
    switch (this.state) {
      case 'holding':
        switch (this.evidence) {
          case 'os':
            return 'awake✓';
          case 'self-report':
            return 'awake~';
          // Running, and that is the whole of what we know.
          default:
            return 'awake…';
        }
      case 'off':
        return 'awake:off';
      case 'unsupported':
        return 'awake:n/a';
      default:
        return 'awake:FAIL';
    }
  }
}

/** How to read each grade of evidence, for anyone running --doctor. */
const EVIDENCE_NOTE: Record<AwakeEvidence, string> = {
  os: '           the platform’s own tool reports the lock',
  'self-report': '  the watcher says so; nothing independent has agreed',
  liveness: '     the watcher is running, and that is all we know',
  none: '         nothing is being held',
};

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

  // The same class a real run uses, rather than a second copy of the spawn.
  const held = new Awake({ enabled: true, defeatScreensaver: false });
  held.start();

  // Waiting for evidence rather than for a duration. This used to be a flat
  // 3.5 seconds on Windows, because the watcher there has to compile a P/Invoke
  // shim with Add-Type before it can take the lock, and asking the OS any sooner
  // reported a lock that genuinely was not held yet. The guess was both too slow
  // on a fast machine and not provably long enough on a slow one; the watcher now
  // says when it is ready, so there is nothing left to estimate.
  const evidence = await held.confirm();

  if (held.state !== 'holding') {
    out(`  watcher       FAILED: ${held.detail}`);
    printNotes(out, backend);
    return 1;
  }
  out(`  watcher       running (pid ${held.watcherPid})`);
  out(`  evidence      ${evidence}${EVIDENCE_NOTE[evidence]}`);

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
  held.stop();
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
