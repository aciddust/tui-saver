/**
 * Re-verification: the difference between "the watcher process is alive" and
 * "the OS says the lock is held". Both the watcher and the verify query here are
 * real subprocesses whose output this test controls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Awake, HELD_MARKER, type Backend, type VerifyCommand } from '../src/awake.ts';

const stayUp = ['-e', 'setInterval(() => {}, 1000)'];

function backend(verify: VerifyCommand | null, args = stayUp, pipe = false): Backend {
  return {
    platform: 'test',
    mechanism: 'a node process that will not exit on its own',
    command: () => ({
      cmd: process.execPath,
      args,
      opts: { stdio: pipe ? ['ignore', 'pipe', 'ignore'] : 'ignore' },
    }),
    verify,
    notes: [],
  };
}

/** A probe subprocess that prints whatever we tell it to. */
function probe(says: string, needsElevation = false): VerifyCommand {
  return {
    cmd: process.execPath,
    args: ['-e', `console.log(${JSON.stringify(says)})`],
    expect: ['LOCK-IS-HELD'],
    display: 'a test probe',
    ...(needsElevation ? { needsElevation: true } : {}),
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

test('the OS is asked again during the run, and a yes is recorded as evidence', async (t) => {
  const awake = new Awake(opts, backend(probe('LOCK-IS-HELD')));
  t.after(() => awake.stop());
  awake.start();

  await until(() => awake.evidence === 'os', 'os-level evidence');
  assert.equal(awake.state, 'holding');
  assert.ok(awake.lastVerifiedAt !== null, 'the time of the answer should be kept');
});

test('an OS that no longer reports the lock fails the run even though the watcher lives', async (t) => {
  const awake = new Awake(opts, backend(probe('nothing about any lock')));
  t.after(() => awake.stop());
  awake.start();

  await until(() => awake.state === 'failed', 'failure raised by the verify query');
  assert.ok(awake.watcherPid !== null, 'the watcher is still alive; that was never the question');
  assert.match(awake.detail, /LOCK-IS-HELD/);
  assert.equal(awake.everFailed, true);
});

test('a query that needs elevation is never used to fail the run', async (t) => {
  const awake = new Awake(opts, backend(probe('nothing about any lock', true)));
  t.after(() => awake.stop());
  awake.start();

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(awake.state, 'holding');
  assert.equal(awake.lastVerifiedAt, null);
});

test('a watcher that reports for itself counts for more than one that is merely alive', async (t) => {
  const reporting = backend(
    null,
    ['-e', `console.log('${HELD_MARKER}'); setInterval(() => {}, 1000)`],
    true,
  );
  const awake = new Awake(opts, reporting);
  t.after(() => awake.stop());
  awake.start();

  assert.equal(awake.evidence, 'liveness', 'nothing has been heard from it yet');
  await until(() => awake.evidence === 'self-report', "the watcher's own report");
});

test('with no way to ask, liveness is all the evidence there is', async (t) => {
  const awake = new Awake(opts, backend(null));
  t.after(() => awake.stop());
  awake.start();

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(awake.evidence, 'liveness');
});

test('an answer that has gone stale stops counting as evidence, without failing the run', async (t) => {
  // A probe that reads a file, so the test can change what the OS "says" — and
  // then take away its ability to answer at all by deleting it.
  const path = join(tmpdir(), `tui-saver-probe-${process.pid}.txt`);
  writeFileSync(path, 'LOCK-IS-HELD');
  t.after(() => rmSync(path, { force: true }));

  const reader: VerifyCommand = {
    cmd: process.execPath,
    args: ['-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(path)}, 'utf8'))`],
    expect: ['LOCK-IS-HELD'],
    display: 'a test probe that can be taken away',
  };

  const awake = new Awake(opts, backend(reader));
  t.after(() => awake.stop());
  awake.start();
  await until(() => awake.evidence === 'os', 'os-level evidence while the probe answers');

  rmSync(path);

  await until(() => awake.evidence !== 'os', 'the stale answer to stop counting');
  assert.equal(awake.state, 'holding', 'being unable to ask is not the same as a no');
  assert.equal(awake.everFailed, false);
});
