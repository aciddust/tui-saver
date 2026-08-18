/**
 * Verifies the sleep-suppression machinery. Run this on each platform you
 * intend to ship to:
 *
 *   node tools/check-awake.ts
 *
 * Two halves:
 *
 * 1. Static checks, which run identically everywhere — the shape of each
 *    platform's watcher command, and the structure of the PowerShell script
 *    Windows receives. These exist because the Windows script cannot be executed
 *    on a machine without PowerShell, so its correctness has to be established
 *    as data rather than by running it.
 *
 * 2. A live check on the current platform: hold the lock against a throwaway
 *    process, ask the OS whether it is held, then kill that process outright and
 *    confirm the watcher lets go. That last step is the property that matters —
 *    it is what guarantees this program cannot leave a machine unable to sleep —
 *    and unlike the OS query it needs no elevation anywhere.
 */

import { execFileSync, spawn } from 'node:child_process';
import { HELD_MARKER, watcherCommandFor, supportedPlatforms } from '../src/awake.ts';

let failures = 0;
const check = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures++;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}\n`);
};
const head = (s: string): void => process.stdout.write(`\n${s}\n`);

const alive = (pid: number): boolean => {
  try {
    // Signal 0 checks for existence without delivering anything, on every
    // platform Node supports.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
head('watcher commands (all platforms)');

const PID = 4242;
for (const p of supportedPlatforms()) {
  const c = watcherCommandFor(p, PID, false);
  check(c !== null, `${p} has a backend`);
  if (!c) continue;
  const shown = p === 'win32' ? `${c.cmd} ... -EncodedCommand <base64>` : `${c.cmd} ${c.args.join(' ')}`;
  process.stdout.write(`       ${shown}\n`);
  check(
    p === 'win32' || c.args.some((a) => a.includes(String(PID))),
    `${p} command references the watched pid`,
  );
}
check(watcherCommandFor('freebsd', PID, false) === null, 'unknown platform yields no backend');

// ---------------------------------------------------------------------------
head('windows powershell script (static)');

for (const pulse of [false, true]) {
  const c = watcherCommandFor('win32', PID, pulse)!;
  const script = Buffer.from(c.args[c.args.length - 1], 'base64').toString('utf16le');
  const tag = `[pulse=${pulse}]`;
  check(c.cmd === 'powershell.exe', `${tag} runs powershell.exe`);
  check(c.opts.windowsHide === true, `${tag} windowsHide set, so no console flashes up`);
  check(c.args.includes('-NoProfile'), `${tag} -NoProfile (user profile cannot interfere)`);
  check(c.args.includes('Bypass'), `${tag} -ExecutionPolicy Bypass (policy cannot block it)`);
  check(script.includes('SetThreadExecutionState'), `${tag} base64 round-trips as UTF-16LE`);
  check(script.includes(`Wait-Process -Id ${PID} `), `${tag} waits on the watched pid`);
  check(/Add-Type -TypeDefinition @'\n/.test(script), `${tag} here-string opens correctly`);
  check(/\n'@\n/.test(script), `${tag} here-string terminator is at column 0`);
  const braces = (script.match(/\{/g) ?? []).length === (script.match(/\}/g) ?? []).length;
  check(braces, `${tag} braces balanced`);
  check((script.match(/'/g) ?? []).length % 2 === 0, `${tag} quotes balanced`);
  // 0x80000000 | 0x1 | 0x2, then 0x80000000 alone to clear.
  check(script.includes('2147483651'), `${tag} holds ES_CONTINUOUS|SYSTEM|DISPLAY`);
  check(
    /finally \{\n\s*\[void\]\[Awake\]::SetThreadExecutionState\(\[uint32\]2147483648\)/.test(script),
    `${tag} clears the request in a finally block`,
  );
  check(!script.includes('\r'), `${tag} LF only`);
  // The keystroke is the one thing here that touches the rest of the desktop,
  // so its presence must track the flag exactly.
  check(
    script.includes('SendKeys') === pulse,
    `${tag} keystroke code ${pulse ? 'present' : 'absent'} exactly as requested`,
  );
}

// ---------------------------------------------------------------------------
head(`live check on this platform (${process.platform})`);

const mine = watcherCommandFor(process.platform, PID, false);
if (!mine) {
  process.stdout.write(`  skipped: no backend for ${process.platform}\n`);
} else {
  // A throwaway process for the watcher to watch, so we can kill it without
  // taking this tool down with it.
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await sleep(300);
  const victimPid = victim.pid!;
  check(alive(victimPid), `throwaway target running (pid ${victimPid})`);

  const { cmd, args, opts } = watcherCommandFor(process.platform, victimPid, false)!;
  const watcher = spawn(cmd, args, opts);
  let spawnError: string | null = null;
  watcher.on('error', (e) => {
    spawnError = e.message;
  });
  // A watcher that refuses to start explains itself on stderr. Printing that is
  // the difference between "FAIL watcher running" and knowing what to do next.
  let complaint = '';
  watcher.stderr?.setEncoding('utf8');
  watcher.stderr?.on('data', (chunk: string) => {
    complaint += chunk;
  });
  // Where the watcher can say when it holds the lock, wait for it to say so.
  let reported = false;
  watcher.stdout?.setEncoding('utf8');
  watcher.stdout?.on('data', (chunk: string) => {
    if (chunk.split('\n').some((l) => l.trim() === HELD_MARKER)) reported = true;
  });
  const reports = Array.isArray(opts.stdio) && opts.stdio[1] === 'pipe';
  if (reports) {
    // No fixed allowance: the Windows watcher compiles a P/Invoke shim before it
    // can take the lock, which took a flat four seconds here to cover. It says
    // when it is ready, so this waits for that and no longer.
    const deadline = Date.now() + 10_000;
    while (!reported && Date.now() < deadline) await sleep(100);
  } else {
    await sleep(500);
  }
  check(spawnError === null, 'watcher launched', spawnError ?? '');
  const watcherPid = watcher.pid;
  check(watcherPid !== undefined && alive(watcherPid), `watcher running (pid ${watcherPid})`);
  if (reports) check(reported, `watcher reported holding the lock ("${HELD_MARKER}")`);
  // PowerShell wraps a redirected stderr in a CLIXML envelope whether or not it
  // has anything to say, so printing that raw makes a clean run look as if the
  // watcher complained. Only the message lines are worth showing.
  const said = complaint
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#<') && !l.startsWith('<'));
  if (said.length > 0) {
    process.stdout.write('       it said:\n');
    for (const line of said.slice(0, 8)) process.stdout.write(`         ${line}\n`);
  }

  // Ask the OS, where we can. On Windows this needs elevation and is reported
  // rather than failed, because the kill test below is the load-bearing one.
  const probes: Record<string, [string, string[], string]> = {
    darwin: ['pmset', ['-g', 'assertions'], `Process ID ${victimPid}`],
    linux: ['systemd-inhibit', ['--list'], 'tui-saver'],
    win32: ['powercfg', ['/requests'], 'DISPLAY'],
  };
  const probe = probes[process.platform];
  if (probe) {
    const [pcmd, pargs, needle] = probe;
    try {
      const report = execFileSync(pcmd, pargs, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      check(report.includes(needle), `${pcmd} ${pargs.join(' ')} reports the lock`);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split('\n')[0];
      if (process.platform === 'win32') {
        process.stdout.write(`  note  powercfg /requests needs an elevated prompt — ${msg}\n`);
        process.stdout.write('        re-run this from an Administrator terminal to see the table\n');
      } else {
        check(false, `could not run ${pcmd}`, msg);
      }
    }
  }

  // The property that actually matters: kill the watched process outright, with
  // no chance for any cleanup handler to run, and the watcher must let go.
  process.kill(victimPid, 'SIGKILL');
  let released = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (watcherPid === undefined || !alive(watcherPid)) {
      released = true;
      break;
    }
  }
  check(released, 'watcher exited by itself after the target was killed');
  if (!released) {
    try {
      watcher.kill();
    } catch {
      /* nothing more to do */
    }
  }
}

head(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
