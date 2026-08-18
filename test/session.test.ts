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

import { batteryGuard } from '../src/session.ts';
import type { Battery } from '../src/battery.ts';

const draining = (percent: number): Battery => ({ percent, discharging: true });
const plugged = (percent: number): Battery => ({ percent, discharging: false });

test('no battery to read means the guard does nothing', () => {
  assert.deepEqual(batteryGuard(null, 15, null, 1000), {
    lowSince: null,
    stop: false,
    secondsLeft: null,
  });
});

test('a floor of zero turns the guard off', () => {
  assert.deepEqual(batteryGuard(draining(3), 0, null, 1000), {
    lowSince: null,
    stop: false,
    secondsLeft: null,
  });
});

test('a healthy battery is left alone', () => {
  assert.deepEqual(batteryGuard(draining(50), 15, null, 1000), {
    lowSince: null,
    stop: false,
    secondsLeft: null,
  });
});

test('a low battery on mains power is not a problem', () => {
  assert.deepEqual(batteryGuard(plugged(4), 15, null, 1000), {
    lowSince: null,
    stop: false,
    secondsLeft: null,
  });
});

test('a low battery starts a countdown rather than pulling the rug', () => {
  assert.deepEqual(batteryGuard(draining(10), 15, null, 1000), {
    lowSince: 1000,
    stop: false,
    secondsLeft: 10,
  });
});

test('the countdown runs down', () => {
  assert.deepEqual(batteryGuard(draining(10), 15, 1000, 4000), {
    lowSince: 1000,
    stop: false,
    secondsLeft: 7,
  });
});

test('the countdown reaching zero stops the run', () => {
  const r = batteryGuard(draining(10), 15, 1000, 11_000);
  assert.equal(r.stop, true);
  assert.equal(r.secondsLeft, 0);
});

test('plugging in during the countdown calls it off', () => {
  assert.deepEqual(batteryGuard(plugged(10), 15, 1000, 4000), {
    lowSince: null,
    stop: false,
    secondsLeft: null,
  });
});

test('exactly at the floor is not below it', () => {
  assert.deepEqual(batteryGuard(draining(15), 15, null, 1000), {
    lowSince: null,
    stop: false,
    secondsLeft: null,
  });
});

import { remoteHost } from '../src/session.ts';

test('a local run says nothing about which machine it is', () => {
  assert.equal(remoteHost({}, 'my-laptop'), null);
});

test('an ssh session names the machine actually being kept awake', () => {
  // The whole point: over ssh the lock is held there, not on the laptop you are
  // typing on, and nothing on screen used to say so.
  assert.equal(remoteHost({ SSH_CONNECTION: '10.0.0.1 52000 10.0.0.2 22' }, 'build-box'), 'build-box');
});

test('SSH_TTY and SSH_CLIENT count too, since not every sshd sets all three', () => {
  assert.equal(remoteHost({ SSH_TTY: '/dev/pts/0' }, 'box'), 'box');
  assert.equal(remoteHost({ SSH_CLIENT: '10.0.0.1 52000 22' }, 'box'), 'box');
});

test('only the first label of a long hostname, which is the part that identifies it', () => {
  assert.equal(
    remoteHost({ SSH_CONNECTION: 'x' }, 'ip-10-0-1-23.eu-west-1.compute.internal'),
    'ip-10-0-1-23',
  );
});

test('a hostname there is nothing to say about is not shown', () => {
  assert.equal(remoteHost({ SSH_CONNECTION: 'x' }, ''), null);
  assert.equal(remoteHost({ SSH_CONNECTION: '' }, 'box'), null);
});

import { parseTmuxVisibility, tmuxVisibilityQuery, unseenNotice, unseenTick } from '../src/session.ts';

test('the visibility query asks about the window, not the pane', () => {
  // Measured with tmux 3.7b: a split pane that is not the active one is still on
  // screen, so pane_active would report a visible animation as unseen. What
  // matters is whether our window is the one being displayed.
  const args = tmuxVisibilityQuery('%3').args.join(' ');
  assert.match(args, /session_attached/);
  assert.match(args, /window_active/);
  assert.doesNotMatch(args, /pane_active/);
  assert.match(args, /%3/);
});

test('an attached client looking at our window is watching', () => {
  assert.equal(parseTmuxVisibility('1 1\n'), true);
});

test('a detached session is not watching', () => {
  assert.equal(parseTmuxVisibility('0 1\n'), false);
});

test('an attached client on another window is not watching either', () => {
  assert.equal(parseTmuxVisibility('1 0\n'), false);
});

test('an answer we cannot read means we do not know, which is not an accusation', () => {
  for (const bad of ['', 'no server running on /tmp/tmux-501/default', 'x y', '1']) {
    assert.equal(parseTmuxVisibility(bad), null, JSON.stringify(bad));
  }
});

const watched = { unseen: 0, since: null };

test('a run somebody is watching accumulates nothing', () => {
  assert.deepEqual(unseenTick(watched, true, 1000), { unseen: 0, since: null });
});

test('going unseen starts the clock without banking anything yet', () => {
  assert.deepEqual(unseenTick(watched, false, 1000), { unseen: 0, since: 1000 });
});

test('the stretch is banked when somebody looks again', () => {
  assert.deepEqual(unseenTick({ unseen: 0, since: 1000 }, true, 61_000), {
    unseen: 60,
    since: null,
  });
});

test('stretches add up across a session', () => {
  assert.deepEqual(unseenTick({ unseen: 60, since: 100_000 }, true, 130_000), {
    unseen: 90,
    since: null,
  });
});

test('losing the ability to ask closes the stretch rather than counting forever', () => {
  assert.deepEqual(unseenTick({ unseen: 0, since: 1000 }, null, 11_000), {
    unseen: 10,
    since: null,
  });
});

test('a glance away is not worth reporting', () => {
  assert.equal(unseenNotice({ unseen: 30, since: null }), null);
});

test('a long stretch is reported once somebody is there to read it', () => {
  assert.equal(unseenNotice({ unseen: 90, since: null }), 90);
});

test('nothing is reported while still unseen, since nobody would see it', () => {
  assert.equal(unseenNotice({ unseen: 90, since: 5000 }), null);
});
