/**
 * Formats the age of an archived tab as a coarse, human-readable relative
 * string ("just now", "5m ago", "3h ago", "2d ago").
 *
 * This lives in core — a pure, clock-injected, unit-testable function — rather
 * than in `apps/ui` so the renderer stays thin and the bucketing rules have a
 * single tested home. `now` is passed in (never read from `Date.now()` here) so
 * callers control the clock and the output is deterministic.
 *
 * The delta is clamped at zero, so a `now` earlier than `archivedAt` (clock
 * skew) reads as "just now" rather than a negative age. Buckets: under a minute
 * is "just now"; under an hour is whole minutes; under a day is whole hours;
 * otherwise whole days. Each larger unit uses `Math.floor`, so a value is only
 * promoted once it fully crosses the next boundary.
 */
export function formatRelativeArchived(archivedAt: number, now: number): string {
  const deltaMs = Math.max(0, now - archivedAt);
  if (deltaMs < 60_000) {
    return "just now";
  }
  if (deltaMs < 3_600_000) {
    return `${Math.floor(deltaMs / 60_000)}m ago`;
  }
  if (deltaMs < 86_400_000) {
    return `${Math.floor(deltaMs / 3_600_000)}h ago`;
  }
  return `${Math.floor(deltaMs / 86_400_000)}d ago`;
}
