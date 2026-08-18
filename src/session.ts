/**
 * How long a run should last, and when it should stop by itself.
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
