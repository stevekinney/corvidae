/** The longest wait between two restart attempts, in seconds. */
export const RESTART_RETRY_MAXIMUM_SECONDS = 8;

/**
 * How long to wait before attempt `attempt` of a reconnect, in seconds: 1, 2, 4, then 8 for every
 * attempt after, so a host that is slow to start is not hammered and one that is quick is found
 * quickly. The same schedule as the connection banner's.
 *
 * @example
 * ```ts
 * restartRetryDelaySeconds(3); // 4
 * ```
 */
export function restartRetryDelaySeconds(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 1) return 1;
  return Math.min(2 ** (Math.floor(attempt) - 1), RESTART_RETRY_MAXIMUM_SECONDS);
}
