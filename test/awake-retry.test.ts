/**
 * Retry and re-verification, driven with real child processes. The backend is
 * injected rather than mocked: these are genuine spawns, genuine kills, and a
 * genuine subprocess answering the verify query.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Awake, type Backend } from '../src/awake.ts';

/** A watcher that stays up until it is killed. */
const sleeper: Backend = {
  platform: 'test',
  mechanism: 'a node process that will not exit on its own',
  command: () => ({
    cmd: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    opts: { stdio: 'ignore' },
  }),
  verify: null,
  notes: [],
};

/** A watcher that cannot stay up, however many times it is asked. */
const quitter: Backend = {
  ...sleeper,
  command: () => ({ cmd: process.execPath, args: ['-e', ''], opts: { stdio: 'ignore' } }),
};

async function until(pred: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

test('a watcher killed outright is replaced, and the lock is still reported held', async (t) => {
  const awake = new Awake({ enabled: true, defeatScreensaver: false }, sleeper);
  // Unconditionally, because a failed assertion must not leave a watcher behind
  // holding the test runner's own event loop open.
  t.after(() => awake.stop());
  awake.start();
  const first = awake.watcherPid;
  assert.ok(first, 'the first watcher should have a pid');

  process.kill(first, 'SIGKILL');

  await until(() => awake.watcherPid !== null && awake.watcherPid !== first, 'a replacement watcher');
  assert.equal(awake.state, 'holding');
});

test('a watcher that will not stay up fails rather than being retried forever', async (t) => {
  const awake = new Awake({ enabled: true, defeatScreensaver: false }, quitter);
  t.after(() => awake.stop());
  awake.start();

  await until(() => awake.state === 'failed', 'the failed state');
  assert.match(awake.detail, /watcher/);
  assert.equal(awake.everFailed, true, 'a lost lock must be remembered for the exit code');
});

test('no backend for this platform is unsupported, not failed', (t) => {
  const awake = new Awake({ enabled: true, defeatScreensaver: false }, null);
  t.after(() => awake.stop());
  awake.start();
  assert.equal(awake.state, 'unsupported');
  assert.equal(awake.everFailed, false);
});
