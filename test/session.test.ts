import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extendLimit, sessionView } from '../src/session.ts';

test('a run with no limit has nothing to count down and never expires', () => {
  assert.deepEqual(sessionView(9_999, null), { remaining: null, expired: false });
});

test('a run inside its limit reports what is left of it', () => {
  assert.deepEqual(sessionView(10, 60), { remaining: 50, expired: false });
});

test('reaching the limit expires the run', () => {
  assert.deepEqual(sessionView(60, 60), { remaining: 0, expired: true });
});

test('overshooting the limit does not report negative time left', () => {
  assert.deepEqual(sessionView(90, 60), { remaining: 0, expired: true });
});

test('a clock that jumped backwards does not end the run early', () => {
  // Date.now() is not monotonic; a backwards step must not read as time served.
  assert.deepEqual(sessionView(-30, 60), { remaining: 60, expired: false });
});

test('a run with no limit has nothing to extend', () => {
  assert.equal(extendLimit(null, 900), null);
});

test('extending adds to the limit rather than resetting it', () => {
  assert.equal(extendLimit(3600, 900), 4500);
});
