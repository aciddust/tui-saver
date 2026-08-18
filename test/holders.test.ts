/**
 * Parsers for "who else is holding a lock". Every sample here was captured from the
 * real tool rather than written from memory — pmset on this machine, the other two
 * off CI runners — because a parser written blind is how the Windows backend spent
 * its first release unable to say anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  judgeHolder,
  parseInhibitList,
  parsePmsetAssertions,
  parsePowercfgRequests,
} from '../src/holders.ts';

const PMSET = "Assertion status system-wide:\n   BackgroundTask                 0\n   PreventUserIdleDisplaySleep    1\n   PreventSystemSleep             1\nListed by owning process:\n   pid 33124(caffeinate): [0x0014a1c900018b4e] 00:00:54 PreventUserIdleSystemSleep named: \"caffeinate command-line tool\"  \n\tDetails: caffeinate asserting for 300 secs\n\tLocalized=THE CAFFEINATE TOOL IS PREVENTING SLEEP.\n\tTimeout will fire in 246 secs Action=TimeoutActionRelease\n   pid 16638(caffeinate): [0x0014796e00018403] 02:53:02 PreventUserIdleSystemSleep named: \"caffeinate command-line tool\"  \n\tDetails: caffeinate asserting on behalf of Process ID 16577\n\tCreated for PID: 16577. \n\tLocalized=THE CAFFEINATE TOOL IS PREVENTING SLEEP.\n   pid 16638(caffeinate): [0x0014796e00058404] 02:53:02 PreventUserIdleDisplaySleep named: \"caffeinate command-line tool\"  \n\tDetails: caffeinate asserting on behalf of Process ID 16577\n\tCreated for PID: 16577. \n   pid 501(Google Chrome): [0x0000000c00099b1f] 41:07:33 PreventUserIdleDisplaySleep named: \"Video Wake Lock\"  \n\tDetails: playing audio\n";

test('every process holding an assertion is found, once each', () => {
  const holders = parsePmsetAssertions(PMSET);
  assert.deepEqual(
    holders.map((h) => h.pid),
    [33124, 16638, 501],
    'one entry per pid, in the order the tool listed them',
  );
});

test('the system-wide summary block is not mistaken for a holder', () => {
  // It lists assertion names and counts with no pid, immediately above the part
  // that matters.
  assert.equal(parsePmsetAssertions(PMSET).some((h) => h.pid === null), false);
});

test('a process name with a space in it survives', () => {
  const chrome = parsePmsetAssertions(PMSET).find((h) => h.pid === 501);
  assert.equal(chrome?.process, 'Google Chrome');
});

test('the assertions one process holds are collected together', () => {
  const held = parsePmsetAssertions(PMSET).find((h) => h.pid === 16638);
  assert.deepEqual(held?.what, ['PreventUserIdleSystemSleep', 'PreventUserIdleDisplaySleep']);
});

test('durations are read as seconds, including past a day', () => {
  const holders = parsePmsetAssertions(PMSET);
  assert.equal(holders.find((h) => h.pid === 33124)?.heldSeconds, 54);
  assert.equal(holders.find((h) => h.pid === 16638)?.heldSeconds, 2 * 3600 + 53 * 60 + 2);
  // 41:07:33 — pmset keeps counting hours rather than rolling over to days.
  assert.equal(holders.find((h) => h.pid === 501)?.heldSeconds, 41 * 3600 + 7 * 60 + 33);
});

test('a lock taken on behalf of another process records whose', () => {
  // This is the part that makes a verdict possible instead of a guess: caffeinate -w
  // says who it is waiting for, so a dead target is a leak rather than a suspicion.
  const holders = parsePmsetAssertions(PMSET);
  assert.equal(holders.find((h) => h.pid === 16638)?.onBehalfOf, 16577);
  assert.equal(holders.find((h) => h.pid === 33124)?.onBehalfOf, null);
});

test('nothing held parses to nothing', () => {
  assert.deepEqual(parsePmsetAssertions('Listed by owning process:\n   None\n'), []);
  assert.deepEqual(parsePmsetAssertions(''), []);
});

const holder = {
  pid: 16638,
  process: 'caffeinate',
  heldSeconds: 60,
  what: ['PreventUserIdleSystemSleep'],
  onBehalfOf: null,
};

test('a lock held for a process that no longer exists is a leak, not a suspicion', () => {
  const verdict = judgeHolder({ ...holder, onBehalfOf: 16577 }, () => false);
  assert.equal(verdict, 'leaked');
});

test('a lock held for a process that is still running is nobody business', () => {
  assert.equal(judgeHolder({ ...holder, onBehalfOf: 16577 }, () => true), 'normal');
});

test('age alone is not a verdict', () => {
  // Running it proved this: macOS's own powerd had held PreventUserIdleSystemSleep
  // for three hours, which is what powerd does. Flagging that taught nobody
  // anything and buried the lines that mattered.
  assert.equal(judgeHolder({ ...holder, heldSeconds: 9 * 3600 }, () => true), 'normal');
});

test('a dead target is a verdict at any age', () => {
  const brief = { ...holder, heldSeconds: 5, onBehalfOf: 16577 };
  assert.equal(judgeHolder(brief, () => false), 'leaked');
});

test('a platform that reports no duration and no owner says nothing either way', () => {
  assert.equal(judgeHolder({ ...holder, heldSeconds: null }, () => true), 'normal');
});

// Captured from an ubuntu-latest runner, with one of ours held so there is a row.
const INHIBIT = "WHO          UID  USER   PID  COMM            WHAT  WHY                                 MODE\nModemManager 0    root   1126 ModemManager    sleep ModemManager needs to reset devices delay\ntui-saver    1001 runner 2224 systemd-inhibit idle  probe capture                       block\n\n2 inhibitors listed.\n";

test('every inhibitor is found, with the fields logind actually reports', () => {
  assert.deepEqual(parseInhibitList(INHIBIT), [
    {
      pid: 1126,
      process: 'ModemManager',
      heldSeconds: null,
      what: ['sleep (delay)'],
      onBehalfOf: null,
    },
    {
      pid: 2224,
      process: 'tui-saver',
      heldSeconds: null,
      what: ['idle (block)'],
      onBehalfOf: null,
    },
  ]);
});

test('the columns are sliced by the header, not split on spaces', () => {
  // WHY contains spaces — "ModemManager needs to reset devices" — and WHO can too.
  // Splitting on whitespace shifts every field after it.
  const holders = parseInhibitList(INHIBIT);
  assert.equal(holders[0].process, 'ModemManager');
  assert.equal(holders[0].pid, 1126);
});

test('the trailing count line is not an inhibitor', () => {
  assert.equal(parseInhibitList(INHIBIT).length, 2);
});

test('logind reports no duration, and that is said rather than invented', () => {
  // Nothing in this output says how long anything has been held. A guessed number
  // would read exactly like a measured one.
  for (const h of parseInhibitList(INHIBIT)) assert.equal(h.heldSeconds, null);
});

test('nothing inhibited parses to nothing', () => {
  assert.deepEqual(parseInhibitList('WHO UID USER PID COMM WHAT WHY MODE\n\n0 inhibitors listed.\n'), []);
  assert.deepEqual(parseInhibitList(''), []);
});

// Captured from a windows-latest runner, which is elevated, holding a request.
const POWERCFG = "DISPLAY:\n[PROCESS] \\Device\\HarddiskVolume4\\Program Files\\PowerShell\\7\\pwsh.exe\n\nSYSTEM:\n[PROCESS] \\Device\\HarddiskVolume4\\Program Files\\PowerShell\\7\\pwsh.exe\n\nAWAYMODE:\nNone.\n\nEXECUTION:\nNone.\n\nPERFBOOST:\nNone.\n\nACTIVELOCKSCREEN:\nNone.\n";
const POWERCFG_IDLE = "DISPLAY:\nNone.\n\nSYSTEM:\nNone.\n\nAWAYMODE:\nNone.\n\nEXECUTION:\nNone.\n\nPERFBOOST:\nNone.\n\nACTIVELOCKSCREEN:\nNone.\n";

test('a process holding requests is found once, with every category it holds', () => {
  assert.deepEqual(parsePowercfgRequests(POWERCFG), [
    {
      pid: null,
      process: 'pwsh.exe',
      heldSeconds: null,
      what: ['DISPLAY', 'SYSTEM'],
      onBehalfOf: null,
    },
  ]);
});

test('powercfg names no pid, so none is reported', () => {
  // It prints a device path and nothing else. Reporting a pid here would mean
  // inventing one.
  assert.equal(parsePowercfgRequests(POWERCFG)[0].pid, null);
});

test('the categories holding nothing are not turned into holders', () => {
  assert.deepEqual(parsePowercfgRequests(POWERCFG_IDLE), []);
  assert.deepEqual(parsePowercfgRequests(''), []);
});

import { describeHolders } from '../src/holders.ts';

const OURS = [4242, 4243];

test('our own lock is not news', () => {
  const mine = { pid: 4243, process: 'caffeinate', heldSeconds: 30, what: ['x'], onBehalfOf: 4242 };
  assert.deepEqual(describeHolders([mine], OURS, () => true), []);
});

test('a watcher holding a lock for us is ours too, whatever its pid', () => {
  // On macOS our watcher is a caffeinate we did not name, recognised by the pid it
  // was created for.
  const watcher = { pid: 9999, process: 'caffeinate', heldSeconds: 30, what: ['x'], onBehalfOf: 4242 };
  assert.deepEqual(describeHolders([watcher], OURS, () => true), []);
});

test('a stranger holding a lock is listed with what it holds', () => {
  const other = {
    pid: 501,
    process: 'Google Chrome',
    heldSeconds: 90,
    what: ['PreventUserIdleDisplaySleep'],
    onBehalfOf: null,
  };
  const lines = describeHolders([other], OURS, () => true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /pid 501/);
  assert.match(lines[0], /Google Chrome/);
  assert.match(lines[0], /1m30s/);
  assert.match(lines[0], /PreventUserIdleDisplaySleep/);
});

test('a lock whose process is gone is called a leak, with the command to clear it', () => {
  const leaked = {
    pid: 16638,
    process: 'caffeinate',
    heldSeconds: 3 * 3600,
    what: ['PreventUserIdleSystemSleep'],
    onBehalfOf: 16577,
  };
  const lines = describeHolders([leaked], OURS, () => false).join('\n');
  assert.match(lines, /LEAKED/);
  assert.match(lines, /16577/);
  assert.match(lines, /kill 16638/);
});

test('a long-held lock is reported plainly, with no verdict attached', () => {
  const old = {
    pid: 700,
    process: 'zoom',
    heldSeconds: 5 * 3600,
    what: ['PreventUserIdleDisplaySleep'],
    onBehalfOf: null,
  };
  const lines = describeHolders([old], OURS, () => true);
  assert.equal(lines.length, 1, 'the duration is the finding; a comment on it is not');
  assert.match(lines[0], /5h00m/);
});

test('the longest-held come first, so a lock from Tuesday is at the top', () => {
  const mk = (pid: number, held: number) => ({
    pid,
    process: 'caffeinate',
    heldSeconds: held,
    what: ['PreventUserIdleSystemSleep'],
    onBehalfOf: null,
  });
  const lines = describeHolders([mk(1, 60), mk(2, 72 * 3600), mk(3, 600)], OURS, () => true);
  assert.match(lines[0], /pid 2/);
  assert.match(lines[0], /72h00m/);
  assert.match(lines[2], /pid 1/);
});

test('holders with no duration keep the order the platform listed them in', () => {
  const mk = (pid: number) => ({
    pid,
    process: 'p',
    heldSeconds: null,
    what: ['idle (block)'],
    onBehalfOf: null,
  });
  const lines = describeHolders([mk(7), mk(8)], OURS, () => true);
  assert.match(lines[0], /pid 7/);
  assert.match(lines[1], /pid 8/);
});

test('a platform with no durations says so instead of leaving a blank column', () => {
  const inhibitor = {
    pid: 1126,
    process: 'ModemManager',
    heldSeconds: null,
    what: ['sleep (delay)'],
    onBehalfOf: null,
  };
  const lines = describeHolders([inhibitor], OURS, () => true);
  assert.match(lines.join('\n'), /reports no duration/);
  assert.doesNotMatch(lines[0], /\d+[hms]/, 'no invented span in the row itself');
});

test('nothing to report produces no section at all', () => {
  assert.deepEqual(describeHolders([], OURS, () => true), []);
});
