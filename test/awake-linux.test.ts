/**
 * The Linux watcher's scope, asserted as data for the same reason the Windows
 * one is: what logind will grant depends on the session the caller is in, and
 * that is not something this machine can answer for every machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { watcherCommandFor } from '../src/awake.ts';

function linuxArgs(): string {
  const cmd = watcherCommandFor('linux', 4242, false);
  assert.ok(cmd, 'linux must have a backend');
  return cmd.args.join(' ');
}

test('the watcher asks only for what logind grants without a login session', () => {
  // A GitHub runner, measured: --what=idle --mode=block succeeds with no session,
  // while sleep and shutdown block are refused with "Access denied". A
  // systemd-inhibit request is atomic, so asking for idle:sleep loses the idle
  // inhibitor too — holding nothing at all where it could have held the part
  // that matters.
  const args = linuxArgs();
  assert.match(args, /--what=idle(\s|$)/);
  assert.doesNotMatch(args, /--what=idle:sleep/);
  assert.doesNotMatch(args, /sleep/);
});

test('it is a blocking inhibitor, not a delaying one', () => {
  // Delay inhibitors are not offered for idle at all: logind answers "Delay
  // inhibitors only supported for shutdown and sleep".
  assert.match(linuxArgs(), /--mode=block/);
});

test('it still names itself, so systemd-inhibit --list can be believed', () => {
  assert.match(linuxArgs(), /--who=tui-saver/);
});

test('it still watches the pid it was given', () => {
  assert.match(linuxArgs(), /--pid=4242/);
});
