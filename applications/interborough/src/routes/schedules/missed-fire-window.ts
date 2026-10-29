/**
 * The span of time a schedule skipped, as the fleet's `schedule:missed-fire` frame reports it: the
 * engine was not running when the occurrences between `windowStart` and `windowEnd` were due, so it
 * skipped them and counted how many. The frame is the engine's event serialized (`scheduleId`,
 * `missedCount`, `windowStart`, `windowEnd`, the window as epoch milliseconds).
 */

/** One skipped window of occurrences. */
export interface MissedFireWindow {
  /** Names the window (its bounds), which is what makes a replayed frame the same window. */
  readonly id: string;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly missedCount: number;
}

function numberAt(payload: object, key: string): number | undefined {
  if (!Object.hasOwn(payload, key)) return undefined;
  const value: unknown = Reflect.get(payload, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Reads a `schedule:missed-fire` frame's payload, or `undefined` when it does not hold a window. */
export function missedFireWindowOf(payload: unknown): MissedFireWindow | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const windowStart = numberAt(payload, 'windowStart');
  const windowEnd = numberAt(payload, 'windowEnd');
  const missedCount = numberAt(payload, 'missedCount');
  if (windowStart === undefined || windowEnd === undefined || missedCount === undefined) {
    return undefined;
  }
  return { id: `${String(windowStart)}:${String(windowEnd)}`, windowStart, windowEnd, missedCount };
}

/** Adds a window to those seen, newest first; a window already listed (a frame replayed after a reconnect) is not added twice. */
export function withMissedFireWindow(
  seen: readonly MissedFireWindow[],
  next: MissedFireWindow,
): readonly MissedFireWindow[] {
  const listed = seen.some((window) => window.id === next.id);
  return listed ? seen : [next, ...seen];
}

const WINDOW_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** A window's bounds as a range a person reads: "Oct 29, 09:00 to Oct 29, 09:03". */
export function formatMissedFireRange(window: MissedFireWindow): string {
  return `${WINDOW_FORMATTER.format(window.windowStart)} to ${WINDOW_FORMATTER.format(window.windowEnd)}`;
}
