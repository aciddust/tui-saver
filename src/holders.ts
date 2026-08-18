/**
 * Who else is holding a lock on this machine.
 *
 * `caffeinate` and its equivalents are global, invisible and unbounded, which is
 * the whole reason this program exists — and the state they leave behind outlives
 * the shell that started them. This program already asks the OS whether *its* lock
 * is held; the same answer lists everybody else's, so `--doctor` can report the
 * stray `caffeinate -dis` from three days ago that nothing else will ever mention.
 *
 * Parsing is pure and every sample in the tests was captured from the real tool
 * rather than written from memory. That is not fussiness: the Windows backend spent
 * its first release unable to explain a failure because its behaviour had been
 * reasoned about instead of observed.
 */

import { formatSpan } from './session.ts';

export type Holder = {
  /** The process holding it. */
  pid: number | null;
  process: string;
  /** Seconds held, or null where the platform does not report it. */
  heldSeconds: number | null;
  /** What is held, in the platform's own words. */
  what: string[];
  /**
   * The process this was taken on behalf of, where the platform says so.
   *
   * `caffeinate -w <pid>` records it, which is what turns a suspicion into a
   * verdict: if that pid is gone and the assertion is not, the lock leaked.
   */
  onBehalfOf: number | null;
};

/** How much attention a holder deserves. */
export type HolderVerdict = 'leaked' | 'normal';

/**
 * `   pid 16638(caffeinate): [0x0014796e00018403] 02:53:02 PreventUserIdleSystemSleep named: "..."`
 *
 * The process name can contain spaces ("Google Chrome"), so it is matched lazily up
 * to the closing paren rather than by word.
 */
const PMSET_LINE = /^\s*pid (\d+)\((.+?)\):\s+\[0x[0-9a-f]+\]\s+(\d+):(\d\d):(\d\d)\s+(\S+)/;
const PMSET_BEHALF = /Created for PID:\s*(\d+)/;

/**
 * Parses the "Listed by owning process" section of `pmset -g assertions`.
 *
 * One process appears once per assertion it holds, so entries are folded by pid and
 * the assertion names collected. The summary block above it lists names and counts
 * with no pid and is ignored by the same regex that finds the rest.
 */
export function parsePmsetAssertions(out: string): Holder[] {
  const byPid = new Map<number, Holder>();
  let current: Holder | null = null;

  for (const line of out.split('\n')) {
    const m = PMSET_LINE.exec(line);
    if (m) {
      const pid = Number(m[1]);
      const seconds = Number(m[3]) * 3600 + Number(m[4]) * 60 + Number(m[5]);
      const existing = byPid.get(pid);
      if (existing) {
        if (!existing.what.includes(m[6])) existing.what.push(m[6]);
        // Keep the longest, since one process's assertions can be of different ages.
        existing.heldSeconds = Math.max(existing.heldSeconds ?? 0, seconds);
        current = existing;
      } else {
        current = {
          pid,
          process: m[2],
          heldSeconds: seconds,
          what: [m[6]],
          onBehalfOf: null,
        };
        byPid.set(pid, current);
      }
      continue;
    }
    // Detail lines belong to the assertion above them.
    const behalf = current ? PMSET_BEHALF.exec(line) : null;
    if (behalf && current) current.onBehalfOf = Number(behalf[1]);
  }

  return [...byPid.values()];
}

/**
 * What to make of one holder.
 *
 * A dead target is the only certainty available, so it is the only thing called out.
 * Age deliberately is not: running this printed "held over an hour, which may be
 * exactly right" against macOS's own powerd, which had been holding
 * PreventUserIdleSystemSleep for three hours because that is what powerd does. The
 * flag taught nobody anything and buried the lines that mattered. Durations are
 * reported and sorted instead — a lock from Tuesday sits at the top of the list and
 * needs no commentary.
 *
 * `isAlive` is injected rather than called directly so this stays a decision about
 * data.
 */
export function judgeHolder(holder: Holder, isAlive: (pid: number) => boolean): HolderVerdict {
  return holder.onBehalfOf !== null && !isAlive(holder.onBehalfOf) ? 'leaked' : 'normal';
}

/**
 * Parses `systemd-inhibit --list`.
 *
 * Captured from a runner:
 *
 *   WHO          UID  USER   PID  COMM            WHAT  WHY                                 MODE
 *   ModemManager 0    root   1126 ModemManager    sleep ModemManager needs to reset devices delay
 *   tui-saver    1001 runner 2224 systemd-inhibit idle  probe capture                       block
 *
 *   2 inhibitors listed.
 *
 * The columns are space-padded and aligned, and both WHO and WHY can contain spaces,
 * so rows are sliced at the header's column positions rather than split on
 * whitespace. logind reports no duration at all, which is left as null rather than
 * filled in with something that would read like a measurement.
 */
export function parseInhibitList(out: string): Holder[] {
  const lines = out.split('\n');
  const header = lines.find((l) => /^WHO\s/.test(l));
  if (!header) return [];
  const columns = ['WHO', 'UID', 'USER', 'PID', 'COMM', 'WHAT', 'WHY', 'MODE'];
  const starts = columns.map((c) => header.indexOf(c));
  if (starts.some((i) => i < 0)) return [];
  const field = (row: string, i: number): string =>
    row.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined).trim();

  const holders: Holder[] = [];
  for (const row of lines.slice(lines.indexOf(header) + 1)) {
    if (!row.trim()) continue;
    // "2 inhibitors listed." closes the table.
    if (/inhibitors? listed\./.test(row)) break;
    const pid = Number(field(row, 3));
    const what = field(row, 5);
    const mode = field(row, 7);
    if (!Number.isInteger(pid) || !what) continue;
    holders.push({
      pid,
      process: field(row, 0) || field(row, 4),
      heldSeconds: null,
      what: [mode ? `${what} (${mode})` : what],
      onBehalfOf: null,
    });
  }
  return holders;
}

/**
 * Parses `powercfg /requests`.
 *
 * Captured from an elevated runner:
 *
 *   DISPLAY:
 *   [PROCESS] \Device\HarddiskVolume4\Program Files\PowerShell\7\pwsh.exe
 *
 *   SYSTEM:
 *   None.
 *
 * A category heading, then either `None.` or one line per holder. The holder is a
 * device path with no pid and no duration — so this platform can say what is held
 * and by which executable, and nothing else. It also means our own watcher cannot be
 * told apart from any other PowerShell, which is a limit worth stating rather than
 * working around.
 */
export function parsePowercfgRequests(out: string): Holder[] {
  const byProcess = new Map<string, Holder>();
  let category = '';
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^([A-Z]+):$/.exec(line);
    if (heading) {
      category = heading[1];
      continue;
    }
    if (line === 'None.' || !category) continue;
    const holder = /^\[[A-Z]+\]\s+(.*\S)/.exec(line);
    if (!holder) continue;
    // The device path is not a path anything else understands; the executable name
    // is the part a reader can act on.
    const name = holder[1].split('\\').pop() ?? holder[1];
    const existing = byProcess.get(name);
    if (existing) {
      if (!existing.what.includes(category)) existing.what.push(category);
      continue;
    }
    byProcess.set(name, {
      pid: null,
      process: name,
      heldSeconds: null,
      what: [category],
      onBehalfOf: null,
    });
  }
  return [...byProcess.values()];
}

/**
 * The lines `--doctor` prints about everybody else's locks.
 *
 * `ours` are the pids belonging to this program — this process and its watcher. A
 * holder is ours if it *is* one of them or was taken *for* one of them, which is how
 * a watcher we never named gets recognised.
 *
 * The duration column disappears entirely on a platform that reports no durations,
 * rather than being padded with blanks that read like zero.
 */
export function describeHolders(
  holders: readonly Holder[],
  ours: readonly (number | null)[],
  isAlive: (pid: number) => boolean,
): string[] {
  const mine = (pid: number | null): boolean => pid !== null && ours.includes(pid);
  const others = holders
    .filter((h) => !mine(h.pid) && !mine(h.onBehalfOf))
    // Longest first, where the platform says. Nothing else brings a three-day lock
    // to the reader's attention, and it does so without passing judgement on it.
    .sort((a, b) => (b.heldSeconds ?? 0) - (a.heldSeconds ?? 0));
  if (others.length === 0) return [];

  const anyDuration = others.some((h) => h.heldSeconds !== null);
  const nameWidth = Math.max(...others.map((h) => h.process.length));
  const pidWidth = Math.max(...others.map((h) => String(h.pid ?? '-').length));

  const lines: string[] = [];
  for (const h of others) {
    const pid = String(h.pid ?? '-').padStart(pidWidth);
    const held = anyDuration
      ? `${(h.heldSeconds === null ? '' : formatSpan(h.heldSeconds)).padStart(7)}  `
      : '';
    lines.push(`pid ${pid}  ${h.process.padEnd(nameWidth)}  ${held}${h.what.join(', ')}`);

    if (judgeHolder(h, isAlive) === 'leaked' && h.onBehalfOf !== null) {
      const how = h.pid === null ? '' : ` - release it with: kill ${h.pid}`;
      lines.push(`  LEAKED: taken for pid ${h.onBehalfOf}, which no longer exists${how}`);
    }
  }
  if (!anyDuration) lines.push('(this platform reports no duration for any of them)');
  return lines;
}
