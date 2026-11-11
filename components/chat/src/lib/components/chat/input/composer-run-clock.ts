/** The word the run toolbar shows beside the elapsed time while a run is working. */
export const COMPOSER_RUNNING_LABEL = 'Running';

/** The placeholder of a composer whose run is working, where what is typed waits as a follow-up. */
export const COMPOSER_FOLLOW_UP_PLACEHOLDER = 'Add another follow-up…';

/**
 * How long a run has been working, as the run toolbar shows it: `m:ss` under an hour, `h:mm:ss`
 * from then on. A negative or non-finite duration reads `0:00`.
 */
export function formatRunElapsed(milliseconds: number): string {
  const totalSeconds =
    Number.isFinite(milliseconds) && milliseconds > 0 ? Math.floor(milliseconds / 1000) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, '0');
  if (hours === 0) return `${minutes}:${paddedSeconds}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
}
