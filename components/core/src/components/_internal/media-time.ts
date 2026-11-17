/**
 * Formats a playback position in seconds as `m:ss`, or `h:mm:ss` from an hour up. A negative or
 * non-finite value (a live stream's `Infinity`, an unloaded element's `NaN`) reads `0:00`.
 */
export function formatMediaTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`;
}

/** Seconds an arrow key moves the seek slider. */
export const SEEK_STEP_SECONDS = 5;

/** Share of the duration a Page Up or Page Down key moves the seek slider. */
export const SEEK_PAGE_FRACTION = 0.1;

/**
 * The position, as a fraction of `duration`, that a seek-slider key moves to from `fraction`, or
 * `undefined` for a key the slider leaves to the browser (Home, End, and everything else).
 */
export function seekFractionForKey(
  key: string,
  fraction: number,
  duration: number,
): number | undefined {
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  const arrowStep = SEEK_STEP_SECONDS / duration;
  const offsets = new Map<string, number>([
    ['ArrowRight', arrowStep],
    ['ArrowUp', arrowStep],
    ['ArrowLeft', -arrowStep],
    ['ArrowDown', -arrowStep],
    ['PageUp', SEEK_PAGE_FRACTION],
    ['PageDown', -SEEK_PAGE_FRACTION],
  ]);
  const offset = offsets.get(key);
  if (offset === undefined) return undefined;
  return Math.max(0, Math.min(1, fraction + offset));
}
