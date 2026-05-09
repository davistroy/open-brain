/**
 * getGreeting — return a time-aware greeting based on the local hour.
 *
 * Boundaries:
 *   00:00–11:59  → "Good morning"
 *   12:00–16:59  → "Good afternoon"
 *   17:00–23:59  → "Good evening"
 *
 * @param now  Optional Date to test against (defaults to current time).
 *             Inject in tests to avoid relying on wall-clock time.
 */
export function getGreeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
