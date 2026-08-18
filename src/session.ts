/**
 * Facts about the run itself: how long it should last, when it should stop by
 * itself, and which machine it is keeping awake.
 *
 * Separate from the frame loop because these are decisions rather than drawing,
 * and because "should this run stop now?" is the sort of question that is easy to
 * get subtly wrong — scene time instead of wall clock, a clock that stepped
 * backwards, a negative countdown on screen — and impossible to notice from
 * inside an animation.
 */

import type { Battery } from './battery.ts';

/** How long a low battery is warned about before the run ends. */
const BATTERY_GRACE_MS = 10_000;

/**
 * A span written for a person: widest unit first, two units at most. Shared by the
 * status bar and --doctor, which is why it lives here rather than in either.
 */
export function formatSpan(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export type SessionView = {
  /** Seconds left of the run, or null when it runs until quit. */
  remaining: number | null;
  /** Whether the limit has been reached, and the run should end normally. */
  expired: boolean;
};

export function sessionView(elapsedSeconds: number, limitSeconds: number | null): SessionView {
  if (limitSeconds === null) return { remaining: null, expired: false };
  // Date.now() is not monotonic. A clock that stepped backwards must not read as
  // time already served.
  const elapsed = Math.max(0, elapsedSeconds);
  const remaining = limitSeconds - elapsed;
  return { remaining: Math.max(0, remaining), expired: remaining <= 0 };
}

/** Adds time to a limit. A run with no limit has nothing to extend. */
export function extendLimit(limitSeconds: number | null, bySeconds: number): number | null {
  return limitSeconds === null ? null : limitSeconds + bySeconds;
}

export type BatteryGuardResult = {
  /** When the battery first read low, carried across calls; null when it is not. */
  lowSince: number | null;
  /** Whether the run should end now. */
  stop: boolean;
  /** Seconds of warning left, or null when there is nothing to warn about. */
  secondsLeft: number | null;
};

/**
 * What a battery reading means for a run in progress.
 *
 * Only a battery that is actually going down counts: a machine at 8% on mains
 * power is fine, and the same reading in a bag is what this exists for. Nothing
 * to read means nothing to do, which covers desktops, platforms with no reader,
 * and a query that failed — all four want the same answer.
 */
export function batteryGuard(
  battery: Battery | null,
  floorPct: number,
  lowSince: number | null,
  now: number,
  graceMs: number = BATTERY_GRACE_MS,
): BatteryGuardResult {
  const low = battery !== null && floorPct > 0 && battery.discharging && battery.percent < floorPct;
  if (!low) return { lowSince: null, stop: false, secondsLeft: null };
  // The clock starts on the first low reading, not on this one, so plugging in
  // and unplugging again does not silently reset the warning.
  const since = lowSince ?? now;
  const left = graceMs - (now - since);
  return { lowSince: since, stop: left <= 0, secondsLeft: Math.max(0, Math.ceil(left / 1000)) };
}

/**
 * The host this run is keeping awake, when that is not the machine the keyboard
 * is attached to — otherwise null.
 *
 * Over ssh, every part of this program works and none of it is about the computer
 * in front of you: the lock, the battery reading and the idle timer all belong to
 * the far end. A screensaver whose whole argument is that its state is visible
 * should not be vague about *whose* state it is showing. It became worth saying
 * out loud when the Linux backend started working without a login session, which
 * is exactly the ssh case.
 *
 * Only the first label of the hostname, because a status bar has no room for
 * ip-10-0-1-23.eu-west-1.compute.internal and the first label is the part that
 * identifies the box anyway.
 */
export function remoteHost(env: Record<string, string | undefined>, hostname: string): string | null {
  const overSsh = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
  if (!overSsh) return null;
  const label = hostname.split('.')[0]?.trim();
  return label ? label : null;
}

/**
 * Whether anything is on screen at all, when running inside tmux.
 *
 * The lock being visible is this program's whole argument, and a tmux pane can
 * hold a running animation nobody is looking at — the client detached, or it is on
 * another window. That is the invisible mode this exists to avoid, arrived at from
 * the inside.
 *
 * Measured against tmux 3.7b:
 *
 *                        session_attached  window_active  pane_active
 *   detached                     0               1             1
 *   attached, other window       1               0             1
 *   attached, our window         1               1             1
 *
 * So the pair that matters is session_attached and window_active. `pane_active` is
 * deliberately not consulted: a split pane that is not the active one is still on
 * screen, and treating it as unseen would be wrong.
 */
export function tmuxVisibilityQuery(pane: string): { cmd: string; args: string[] } {
  return {
    cmd: 'tmux',
    args: ['display-message', '-p', '-t', pane, '#{session_attached} #{window_active}'],
  };
}

/** true watched, false unseen, null when tmux could not be asked. */
export function parseTmuxVisibility(stdout: string): boolean | null {
  const parts = stdout.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [attached, windowActive] = parts.map(Number);
  if (!Number.isFinite(attached) || !Number.isFinite(windowActive)) return null;
  return attached > 0 && windowActive > 0;
}

export type Unseen = {
  /** Whole seconds this run has spent with nothing of it on screen. */
  unseen: number;
  /** When the current unseen stretch began, or null when somebody is watching. */
  since: number | null;
};

/**
 * Folds one visibility reading into the running total.
 *
 * An unreadable answer closes the stretch rather than extending it. Not knowing
 * whether anyone is looking is not evidence that nobody is, and the report this
 * feeds is an accusation of sorts — better to undercount it than to invent it.
 */
export function unseenTick(state: Unseen, visible: boolean | null, now: number): Unseen {
  if (visible === false) {
    return state.since === null ? { unseen: state.unseen, since: now } : state;
  }
  if (state.since === null) return state;
  return { unseen: state.unseen + Math.max(0, Math.round((now - state.since) / 1000)), since: null };
}

/**
 * The number of unseen seconds worth telling someone about, or null.
 *
 * Only while somebody is actually watching: a warning drawn into a pane nobody is
 * looking at is the same mistake it is warning about.
 */
export function unseenNotice(state: Unseen, minSeconds = 60): number | null {
  if (state.since !== null) return null;
  return state.unseen >= minSeconds ? state.unseen : null;
}
