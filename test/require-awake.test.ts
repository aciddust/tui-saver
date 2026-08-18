/**
 * End to end, because this is wiring rather than logic: the failure is produced
 * for real by launching the program somewhere its watcher command does not
 * exist, and the assertion is on what the process does about it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Not .pathname: on Windows that yields '/D:/...', which then joins into
// 'D:\D:\...'. CI found this; a macOS-only run never would have.
const ENTRY = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

test('--require-awake exits rather than animating when the lock cannot be taken', () => {
  // No PATH means no caffeinate, no systemd-inhibit and no powershell.
  const r = run(['--require-awake'], { PATH: '/nonexistent' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /require-awake/);
  assert.equal(r.stdout, '', 'nothing should have been drawn');
});

test('without --require-awake the same failure still runs, and still says so', () => {
  const r = run([], { PATH: '/nonexistent' });
  assert.match(r.stderr, /sleep lock/i);
  // A run that spent time not holding what it promised does not exit clean.
  assert.equal(r.status, 1);
});

test('a working run exits clean', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
});

test('--require-awake with --no-awake is rejected before anything starts', () => {
  const r = run(['--require-awake', '--no-awake']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /contradict/);
});
