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

import { signalMessageIdentifier } from '@lostgradient/operative';

/** The sentinel a rejected or denied human wait delivers. */
export function humanWaitDenialPayload(
  decision: 'deny' | 'reject',
  reason: string | undefined,
): Record<string, unknown> {
  return decision === 'reject'
    ? { __abRejected: true, reason }
    : { __abDenied: true, ...(reason !== undefined ? { reason } : {}) };
}

/**
 * The id of the row the delivery that answers `review` appends to the run's
 * conversation, or `undefined` for an id that is not a park's. The park's ordinal is
 * the last segment of its review id (`human-wait:<runId>:<signalName>:<ordinal>`),
 * the count Operative names the row by (`signalMessageIdentifier`), so the row can be
 * named before the answer is delivered and without looking at any conversation.
 */
export function humanWaitAnswerRowIdentifier(review: {
  readonly id: string;
  readonly runId: string;
  readonly signalName: string;
}): string | undefined {
  const prefix = `human-wait:${review.runId}:${review.signalName}:`;
  if (!review.id.startsWith(prefix)) return undefined;
  const ordinal = review.id.slice(prefix.length);
  return /^\d+$/.test(ordinal)
    ? signalMessageIdentifier(review.runId, review.signalName, Number(ordinal))
    : undefined;
}
