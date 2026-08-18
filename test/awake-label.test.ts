/**
 * The status bar is the only place most runs ever report on the lock, so what it
 * says has to track the evidence rather than the intent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Awake, HELD_MARKER, type Backend } from '../src/awake.ts';

const stayUp = ['-e', 'setInterval(() => {}, 1000)'];

function backend(over: Partial<Backend> = {}, args = stayUp, pipe = false): Backend {
  return {
    platform: 'test',
    mechanism: 'a node process that will not exit on its own',
    command: () => ({
      cmd: process.execPath,
      args,
      opts: { stdio: pipe ? ['ignore', 'pipe', 'ignore'] : 'ignore' },
    }),
    verify: null,
    notes: [],
    ...over,
  };
}

async function until(pred: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

const opts = { enabled: true, defeatScreensaver: false, verifyIntervalMs: 40 };

test('an answer from the OS earns a tick', async (t) => {
  const awake = new Awake(
    opts,
    backend({
      verify: {
        cmd: process.execPath,
        args: ['-e', "console.log('LOCK-IS-HELD')"],
        expect: ['LOCK-IS-HELD'],
        display: 'a test probe',
      },
    }),
  );
  t.after(() => awake.stop());
  awake.start();
  await until(() => awake.label === 'awake✓', 'the verified label');
});

test("the watcher's own word is marked as exactly that", async (t) => {
  const awake = new Awake(
    opts,
    backend({}, ['-e', `console.log('${HELD_MARKER}'); setInterval(() => {}, 1000)`], true),
  );
  t.after(() => awake.stop());
  awake.start();
  await until(() => awake.label === 'awake~', 'the self-reported label');
});

test('a lock nobody can vouch for says so rather than claiming a tick', (t) => {
  const awake = new Awake(opts, backend());
  t.after(() => awake.stop());
  awake.start();
  assert.equal(awake.label, 'awake…');
});

test('the labels for off, unsupported and failed are unchanged', async (t) => {
  const off = new Awake({ ...opts, enabled: false }, backend());
  off.start();
  assert.equal(off.label, 'awake:off');

  const none = new Awake(opts, null);
  none.start();
  assert.equal(none.label, 'awake:n/a');

  const broken = new Awake(opts, backend({}, ['-e', '']));
  t.after(() => broken.stop());
  broken.start();
  await until(() => broken.label === 'awake:FAIL', 'the failed label');
});

test('confirming waits for evidence rather than for a spawn to have succeeded', async (t) => {
  const slow = backend(
    {},
    ['-e', `setTimeout(() => console.log('${HELD_MARKER}'), 300); setInterval(() => {}, 1000)`],
    true,
  );
  const awake = new Awake(opts, slow);
  t.after(() => awake.stop());
  awake.start();

  assert.equal(awake.evidence, 'liveness', 'spawning proves nothing yet');
  assert.equal(await awake.confirm(3000), 'self-report');
});

test('confirming gives up rather than hanging when nothing can ever vouch', async (t) => {
  const awake = new Awake({ ...opts, verifyIntervalMs: 0 }, backend());
  t.after(() => awake.stop());
  awake.start();

  assert.equal(await awake.confirm(150), 'liveness');
});
