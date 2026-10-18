/**
 * What a human-wait review delivers on its signal when it is not approved.
 *
 * Denying or rejecting a human-wait review must still deliver something on the
 * signal the run is parked on, or the run stays parked forever (AB-46); the
 * payloads are sentinels the run's continuation recognizes and renders. The one
 * place they are built, so the review that delivers them and the AG-UI mount that
 * shows the row they become cannot disagree.
 *
 * @module human-wait-signal
 */

/** The sentinel a rejected or denied human wait delivers. */
export function humanWaitDenialPayload(
  decision: 'deny' | 'reject',
  reason: string | undefined,
): Record<string, unknown> {
  return decision === 'reject'
    ? { __abRejected: true, reason }
    : { __abDenied: true, ...(reason !== undefined ? { reason } : {}) };
}
