import { formatDuration } from '@lostgradient/cinder';

/**
 * Whole seconds as a countdown reads them in copy, through Cinder's `formatDuration`: `8s`, `5s`,
 * `1m 5s`. Zero is `0s`, which `formatDuration` would read as `0ms`.
 */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.trunc(seconds));
  return whole === 0 ? '0s' : formatDuration(whole * 1000);
}
