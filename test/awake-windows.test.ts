/**
 * The Windows watcher cannot be executed on a machine without PowerShell, so
 * what it does is asserted as data — the same reason src/awake.ts returns the
 * command instead of spawning it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HELD_MARKER, watcherCommandFor } from '../src/awake.ts';

function windowsScript(pulse = false): string {
  const cmd = watcherCommandFor('win32', 4242, pulse);
  assert.ok(cmd, 'win32 must have a backend');
  const encoded = cmd.args[cmd.args.indexOf('-EncodedCommand') + 1];
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

test('a failed SetThreadExecutionState kills the watcher instead of being discarded', () => {
  const s = windowsScript();
  // The call returns the previous state, or 0 on failure. Discarding it lets a
  // watcher sit in its wait loop holding nothing while the parent reports awake.
  assert.doesNotMatch(
    s,
    /\[void\]\[Awake\]::SetThreadExecutionState\(\[uint32\]2147483651\)/,
    'the hold call must not discard its return value',
  );
  assert.match(s, /-eq 0/, 'a zero return must be tested for');
  assert.match(s, /throw/, 'a zero return must abort the watcher');
});

test('the watcher announces on stdout that the lock is held', () => {
  assert.match(windowsScript(), new RegExp(`Write-Output '${HELD_MARKER}'`));
});

test('the watcher re-announces from inside the wait loop, so silence means trouble', () => {
  const s = windowsScript();
  const marker = s.split('\n').filter((l) => l.includes(HELD_MARKER));
  assert.equal(marker.length, 2, 'once after taking the lock, once per wait iteration');
});

test('both output streams are kept: one announces, the other explains', () => {
  const cmd = watcherCommandFor('win32', 4242, false);
  assert.deepEqual(cmd?.opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('releasing still happens in a finally block', () => {
  assert.match(windowsScript(), /finally \{/);
  assert.match(windowsScript(), /SetThreadExecutionState\(\[uint32\]2147483648\)/);
});
