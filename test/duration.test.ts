import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CliError, parseDuration, parseUntil } from '../src/cli.ts';
import { formatSpan } from '../src/ui.ts';

test('a bare number is seconds, like every other duration in this program', () => {
  assert.equal(parseDuration('45'), 45);
});

test('suffixes read the way they are written', () => {
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('90m'), 5400);
  assert.equal(parseDuration('2h'), 7200);
});

test('units compose, so an hour and a half can be said as one', () => {
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('2h5m10s'), 7510);
});

test('nonsense is rejected rather than silently read as zero', () => {
  for (const bad of ['', 'soon', '10x', '-5', 'm', '1h30']) {
    assert.throws(() => parseDuration(bad), CliError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('--until resolves to the seconds between now and that clock time', () => {
  const now = new Date('2026-08-18T14:00:00');
  assert.equal(parseUntil('18:00', now), 4 * 3600);
  assert.equal(parseUntil('14:30', now), 30 * 60);
});

test('a time already past today means that time tomorrow', () => {
  const now = new Date('2026-08-18T23:30:00');
  assert.equal(parseUntil('06:00', now), 6.5 * 3600);
});

test('the same minute means tomorrow, not zero seconds from now', () => {
  const now = new Date('2026-08-18T14:00:00');
  assert.equal(parseUntil('14:00', now), 24 * 3600);
});

test('a clock time that is not one is rejected', () => {
  const now = new Date('2026-08-18T14:00:00');
  for (const bad of ['25:00', '18:60', '6pm', '1800', '18:0a', '']) {
    assert.throws(() => parseUntil(bad, now), CliError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('spans are written for a status bar, widest unit first, no padding waste', () => {
  assert.equal(formatSpan(45), '45s');
  assert.equal(formatSpan(605), '10m05s');
  assert.equal(formatSpan(3600), '1h00m');
  assert.equal(formatSpan(13320), '3h42m');
  assert.equal(formatSpan(0), '0s');
});
