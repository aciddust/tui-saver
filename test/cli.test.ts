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

test('--require-awake is off unless asked for', () => {
  assert.equal(parseArgs([]).opts.requireAwake, false);
  assert.equal(parseArgs(['--require-awake']).opts.requireAwake, true);
});

test('--require-awake and --no-awake cannot both be meant', () => {
  for (const argv of [['--require-awake', '--no-awake'], ['--no-awake', '--require-awake']]) {
    assert.throws(() => parseArgs(argv), (err: unknown) => {
      assert.ok(err instanceof CliError);
      // Not merely "unknown option" — the message has to name the contradiction.
      assert.match(err.message, /--require-awake/);
      assert.match(err.message, /--no-awake/);
      return true;
    }, argv.join(' '));
  }
});

test('there is no session limit unless one is asked for', () => {
  assert.equal(parseArgs([]).opts.sessionSeconds, null);
});

test('--for is resolved to seconds at parse time', () => {
  assert.equal(parseArgs(['--for', '90m']).opts.sessionSeconds, 5400);
});

test('--until is resolved against the clock at parse time', () => {
  const { opts } = parseArgs(['--until', '23:59']);
  assert.ok(opts.sessionSeconds !== null && opts.sessionSeconds > 0);
  assert.ok(opts.sessionSeconds <= 24 * 3600);
});

test('--for and --until cannot both set the same limit', () => {
  assert.throws(() => parseArgs(['--for', '1h', '--until', '18:00']), CliError);
});

test('the battery floor defaults to a percentage that leaves room to act', () => {
  assert.equal(parseArgs([]).opts.batteryFloor, 15);
});

test('--battery-floor 0 turns the guard off', () => {
  assert.equal(parseArgs(['--battery-floor', '0']).opts.batteryFloor, 0);
});

test('a battery floor outside 0-100 is rejected rather than clamped', () => {
  // Clamping would silently turn a typo into a policy.
  assert.throws(() => parseArgs(['--battery-floor', '150']), CliError);
  assert.throws(() => parseArgs(['--battery-floor', '-1']), CliError);
  assert.throws(() => parseArgs(['--battery-floor', 'low']), CliError);
});
