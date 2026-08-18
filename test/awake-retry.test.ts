/**
 * Retry and re-verification, driven with real child processes. The backend is
 * injected rather than mocked: these are genuine spawns, genuine kills, and a
 * genuine subprocess answering the verify query.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Awake, ERROR_MARKER, type Backend } from '../src/awake.ts';

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

test('a watcher that dies says why, when it said anything at all', async (t) => {
  // systemd-inhibit and PowerShell both explain themselves on stderr before
  // exiting. Throwing that away leaves "watcher exited early (code 1)", which
  // tells the user nothing they can act on.
  const noisy: Backend = {
    ...sleeper,
    command: () => ({
      cmd: process.execPath,
      args: ['-e', "process.stderr.write('Failed to inhibit: no session\\n'); process.exit(1)"],
      opts: { stdio: ['ignore', 'ignore', 'pipe'] },
    }),
  };
  const awake = new Awake({ enabled: true, defeatScreensaver: false }, noisy);
  t.after(() => awake.stop());
  awake.start();

  await until(() => awake.state === 'failed', 'the failed state');
  assert.match(awake.detail, /Failed to inhibit: no session/);
});

test("a watcher's own error report is preferred over whatever it wrote to stderr", async (t) => {
  // PowerShell always writes "#< CLIXML" to a redirected stderr, so a reason taken
  // from stderr would be that, every time, on the one platform that has no other
  // way to explain itself.
  const speaking: Backend = {
    ...sleeper,
    command: () => ({
      cmd: process.execPath,
      args: [
        '-e',
        `process.stderr.write('#< CLIXML\\n');` +
          `process.stdout.write('${ERROR_MARKER} Add-Type could not compile the shim\\n');` +
          `process.exit(1)`,
      ],
      opts: { stdio: ['ignore', 'pipe', 'pipe'] },
    }),
  };
  const awake = new Awake({ enabled: true, defeatScreensaver: false }, speaking);
  t.after(() => awake.stop());
  awake.start();

  await until(() => awake.state === 'failed', 'the failed state');
  assert.match(awake.detail, /Add-Type could not compile the shim/);
  assert.doesNotMatch(awake.detail, /CLIXML/);
});

test('CLIXML noise on its own is not offered as a reason', async (t) => {
  const noisy: Backend = {
    ...sleeper,
    command: () => ({
      cmd: process.execPath,
      args: ['-e', "process.stderr.write('#< CLIXML\\n<Objs/>\\n'); process.exit(1)"],
      opts: { stdio: ['ignore', 'ignore', 'pipe'] },
    }),
  };
  const awake = new Awake({ enabled: true, defeatScreensaver: false }, noisy);
  t.after(() => awake.stop());
  awake.start();

  await until(() => awake.state === 'failed', 'the failed state');
  assert.doesNotMatch(awake.detail, /CLIXML|Objs/);
});
