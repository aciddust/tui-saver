/**
 * How long a run should last, and when it should stop by itself.
 *
 * Separate from the frame loop because these are decisions rather than drawing,
 * and because "should this run stop now?" is the sort of question that is easy to
 * get subtly wrong — scene time instead of wall clock, a clock that stepped
 * backwards, a negative countdown on screen — and impossible to notice from
 * inside an animation.
 */

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
