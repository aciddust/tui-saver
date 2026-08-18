import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CliError, parseArgs } from '../src/cli.ts';

test('by default the sleep lock is held and the whole playlist cycles', () => {
  const { opts } = parseArgs([]);
  assert.equal(opts.awake, true);
  assert.equal(opts.playlist, null);
  assert.equal(opts.duration, 22);
});

test('--duration clamps a negative value to zero rather than rejecting it', () => {
  const { opts } = parseArgs(['--duration', '-5']);
  assert.equal(opts.duration, 0);
});

test('an unknown option throws CliError instead of killing the process', () => {
  assert.throws(() => parseArgs(['--nope']), (err: unknown) => {
    assert.ok(err instanceof CliError, `expected CliError, got ${String(err)}`);
    assert.equal(err.code, 2);
    assert.match(err.message, /unknown option: --nope/);
    return true;
  });
});

test('an option missing its value throws rather than reading the next flag', () => {
  assert.throws(() => parseArgs(['--scene']), CliError);
});

test('a non-numeric --fps throws', () => {
  assert.throws(() => parseArgs(['--fps', 'fast']), CliError);
});
