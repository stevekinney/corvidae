import type { ApplicationCommandClaim, Mailbox } from '@lostgradient/weft';

import type {
  ClaimedSessionInput,
  SessionInputDelivery,
  SessionInputDeliveryMode,
  SessionInputGate,
  SessionInputPayload,
} from './types';

/** The most inputs one step boundary claims, so a deep backlog is delivered over several steps. */
export const MAILBOX_SESSION_INPUT_BATCH_LIMIT = 100;

/** What a mailbox command means as a session input. */
export interface DecodedSessionInput {
  readonly payload: SessionInputPayload;
  readonly deliveryMode: SessionInputDeliveryMode;
}

/**
 * The durable record of which inputs already became messages. It is the
 * authority that keeps delivery exactly-once: the mailbox only says an input is
 * still open, this says whether the conversation already holds it.
 */
export interface SessionInputPromotionStore {
  isPromoted(id: string): Promise<boolean>;
  /** Commits the promotion. Idempotent per `id`: a second call changes nothing. */
  promote(
    delivery: SessionInputDelivery & { readonly conversationMessageId: string },
  ): Promise<void>;
}

export interface MailboxSessionInputGateOptions {
  /** The session's session-input mailbox, strictly FIFO in admission order. */
  readonly mailbox: Mailbox;
  /**
   * Reads one claimed command as a session input. Throwing marks the command
   * malformed: it is rejected without retry and never delivered.
   */
  readonly decode: (claim: ApplicationCommandClaim) => DecodedSessionInput;
  readonly promotion: SessionInputPromotionStore;
}

/**
 * A {@link SessionInputGate} over a Weft mailbox (COR-1476).
 *
 * Delivery is a claim, a durable message, then a settlement, and each hand-off
 * is safe to repeat:
 *
 * - `claimPending` leases the mailbox head command by command. The mailbox
 *   yields a command's payload only to a claimant, so the lease is how the
 *   gate reads it. The lease is held across the step that generates with the
 *   input, which may outlive the mailbox's visibility timeout; that is safe
 *   because the promotion store, not the lease, decides whether an input was
 *   delivered.
 * - `settle` writes the promotion, then acknowledges the lease. A lease that
 *   expired, or was lost to a restart, makes the acknowledgement stale and
 *   leaves the command open; the next boundary claims it again, finds it
 *   promoted, reports it `delivered`, and the acknowledgement happens then.
 *
 * Order is preserved even when a lease is outstanding. The mailbox hands the
 * head only while it is waiting, so a command whose lease is still live (a
 * crash between claim and settle) would be skipped and a later one delivered
 * first. The gate therefore returns nothing while any command is leased, and
 * runs the mailbox's maintenance first so an expired lease is released rather
 * than blocking forever.
 *
 * It assumes one live run per session drains the mailbox: two runs claiming the
 * same session's inputs concurrently could both deliver an input whose lease
 * lapsed before the other settled.
 */
export function createMailboxSessionInputGate(
  options: MailboxSessionInputGateOptions,
): SessionInputGate {
  const { mailbox, decode, promotion } = options;
  const leases = new Map<string, { commandId: string; attemptToken: string }>();

  return {
    async claimPending() {
      await mailbox.runMaintenance();
      const leased = await mailbox.list({
        states: ['claimed', 'cancellation-requested'],
        limit: 1,
      });
      if (leased.length > 0) return [];

      const claimedInputs: ClaimedSessionInput[] = [];
      while (claimedInputs.length < MAILBOX_SESSION_INPUT_BATCH_LIMIT) {
        const result = await mailbox.claim();
        if (result.status !== 'claimed') break;
        const { claim } = result;
        const id = claim.receipt.idempotencyKey;
        if (id === undefined) {
          await mailbox.reject({
            commandId: claim.receipt.commandId,
            attemptToken: claim.attemptToken,
            failure: { reason: 'application', message: 'session input has no id' },
            retry: false,
          });
          continue;
        }
        let decoded: DecodedSessionInput;
        try {
          decoded = decode(claim);
        } catch (error) {
          await mailbox.reject({
            commandId: claim.receipt.commandId,
            attemptToken: claim.attemptToken,
            failure: {
              reason: 'application',
              message: error instanceof Error ? error.message : 'malformed session input',
            },
            retry: false,
          });
          continue;
        }
        leases.set(id, { commandId: claim.receipt.commandId, attemptToken: claim.attemptToken });
        claimedInputs.push({
          id,
          deliveryMode: decoded.deliveryMode,
          payload: decoded.payload,
          delivered: await promotion.isPromoted(id),
        });
      }
      return claimedInputs;
    },

    async settle(deliveries) {
      for (const delivery of deliveries) {
        if (delivery.conversationMessageId !== undefined) {
          await promotion.promote({
            ...delivery,
            conversationMessageId: delivery.conversationMessageId,
          });
        }
        const lease = leases.get(delivery.id);
        if (lease === undefined) continue;
        leases.delete(delivery.id);
        await mailbox.acknowledge(lease);
      }
    },
  };
}
