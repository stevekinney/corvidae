import {
  createMailboxSessionInputGate,
  type SessionInputGate,
  type SessionStore,
} from '@lostgradient/operative';
import type { Mailbox } from '@lostgradient/weft';

import { decodeSessionInputKind, type PersistedSessionInput } from './session-input-durability';
import { promoteSessionInput, readSessionInputPromotion } from './session-input-promotion';

/** What {@link createSessionInputDeliveryGate} reads and writes for one session. */
export interface SessionInputDeliveryOptions {
  readonly sessionId: string;
  /** The session's session-input mailbox, the same instance admission writes to. */
  readonly mailbox: Mailbox;
  readonly sessionStore: SessionStore;
  readonly nowISO: () => string;
}

/**
 * COR-1476 — the {@link SessionInputGate} a Bureau hands each of a session's
 * durable runs, so input admitted by `submitSessionInput` reaches the run at its
 * next step boundary.
 *
 * Operative's mailbox gate owns the claim and settle protocol. This supplies the
 * two Bureau-specific halves of it: how an admitted command decodes (the
 * `PersistedSessionInput` that `admitSessionInput` stored, and the delivery mode
 * its `kind` encodes), and where promotion lives. Promotion is
 * `promoteSessionInput`'s `sessionInputPromotions` entry in the session's own
 * metadata, so a delivered input's receipt reads `promoted` from the same fact
 * that decides it must not be delivered again.
 *
 * Delivery does not honour a record's `expiresAt` or `supersedes`: neither has a
 * terminal state recorded anywhere yet, so an expired or superseded input is
 * delivered like any other.
 */
export function createSessionInputDeliveryGate(
  options: SessionInputDeliveryOptions,
): SessionInputGate {
  const { sessionId, mailbox, sessionStore, nowISO } = options;
  return createMailboxSessionInputGate({
    mailbox,
    decode(claim) {
      if (claim.payload.form !== 'inline') {
        throw new Error('A session input must carry an inline payload.');
      }
      const persisted = claim.payload.value as PersistedSessionInput;
      return {
        payload: persisted.payload,
        deliveryMode: decodeSessionInputKind(claim.receipt.kind),
      };
    },
    promotion: {
      async isPromoted(id) {
        const session = await sessionStore.load(sessionId);
        return (
          session !== undefined && readSessionInputPromotion(session.metadata, id) !== undefined
        );
      },
      async promote(delivery) {
        const result = await promoteSessionInput(
          sessionStore,
          {
            sessionId,
            id: delivery.id,
            conversationMessageId: delivery.conversationMessageId,
            providerTurn: delivery.providerTurn,
          },
          nowISO,
        );
        if (!result.committed) {
          throw new Error(
            `Cannot promote session input "${delivery.id}": session "${sessionId}" no longer exists.`,
          );
        }
      },
    },
  });
}
