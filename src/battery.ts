/**
 * Reading the battery, on the three platforms that have a sleep-lock backend.
 *
 * caffeinate has no notion of a power source — `-s` is the closest thing, and it
 * is silently inert on battery — so a lock taken to keep a machine awake will
 * happily flatten it in a bag. Knowing the charge is what lets that be avoided.
 *
 * Structured the way src/awake.ts is: the parsing is pure and exported, so the
 * two platforms the author cannot run are still testable against captured
 * output rather than being taken on trust.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

export type Battery = {
  /** Charge remaining, 0-100. */
  percent: number;
  /**
   * Whether the charge is actually going down. This rather than "charging"
   * because it is the question the guard asks: a battery at 8% on mains power is
   * not a problem, and one at 8% in a bag is.
   */
  discharging: boolean;
};

/** Parses `pmset -g batt`. */
export function parsePmset(out: string): Battery | null {
  const percent = out.match(/(\d{1,3})%/);
  if (!percent) return null;
  return {
    percent: Number(percent[1]),
    // The header line names the source, which is more reliable than the status
    // word: "charged" and "charging" and "finishing charge" are all AC.
    discharging: !/Now drawing from 'AC Power'/.test(out),
  };
}

/** Parses the `capacity` and `status` files Linux exposes per battery. */
export function parseSysfs(capacity: string, status: string): Battery | null {
  const percent = capacity.trim();
  if (!/^\d{1,3}$/.test(percent)) return null;
  return { percent: Number(percent), discharging: status.trim() === 'Discharging' };
}

/**
 * Parses `Get-CimInstance Win32_Battery | Format-List`.
 *
 * BatteryStatus is a CIM enumeration, not a boolean: 1 is "Other", which for
 * this class means running down; 2 is "Unknown", which means the system has AC.
 * 4 and 5 are Low and Critical, both on battery. Anything else is either a
 * charging state or a value we do not recognise, and a value we do not recognise
 * must not read as draining — that would end a run on a plugged-in machine.
 */
export function parseWin32Battery(out: string): Battery | null {
  const percent = out.match(/EstimatedChargeRemaining\s*:\s*(\d{1,3})/);
  const status = out.match(/BatteryStatus\s*:\s*(\d{1,2})/);
  if (!percent || !status) return null;
  return {
    percent: Number(percent[1]),
    discharging: [1, 4, 5].includes(Number(status[1])),
  };
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function readLinuxBattery(): Promise<Battery | null> {
  const root = '/sys/class/power_supply';
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  for (const name of entries.filter((n) => n.startsWith('BAT'))) {
    try {
      const [capacity, status] = await Promise.all([
        readFile(`${root}/${name}/capacity`, 'utf8'),
        readFile(`${root}/${name}/status`, 'utf8'),
      ]);
      const battery = parseSysfs(capacity, status);
      if (battery) return battery;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * The battery on this platform, or null where there is nothing to read — a
 * desktop, a platform with no reader, or a query that failed. Null means the
 * guard does nothing, which is the right answer in all four cases.
 *
 * Windows pays a PowerShell start for this, once a minute. Folding it into the
 * watcher's own loop would have been free, and was rejected: the watcher holds
 * the sleep lock, and a battery query that threw inside it would drop the lock
 * to answer a question about the battery.
 */
export async function readBattery(): Promise<Battery | null> {
  switch (process.platform) {
    case 'darwin': {
      const out = await run('pmset', ['-g', 'batt']);
      return out === null ? null : parsePmset(out);
    }
    case 'linux':
      return readLinuxBattery();
    case 'win32': {
      const out = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | Format-List',
      ]);
      return out === null ? null : parseWin32Battery(out);
    }
    default:
      return null;
  }
}
