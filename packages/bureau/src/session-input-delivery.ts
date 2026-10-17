import {
  createMailboxSessionInputGate,
  type DecodedSessionInput,
  type MailboxSessionInputGateTimers,
  parseSessionInputPayload,
  type SessionInputGate,
  type SessionStore,
} from '@lostgradient/operative';
import type { ApplicationCommandClaim, Mailbox } from '@lostgradient/weft';

import { decodeSessionInputKind, type PersistedSessionInput } from './session-input-durability';
import { claimSessionInputDeliveries, promoteSessionInputs } from './session-input-promotion';

/** What {@link createSessionInputDeliveryGate} reads and writes for one run. */
export interface SessionInputDeliveryOptions {
  readonly sessionId: string;
  /** The run this gate delivers for, named in the session's delivery records. */
  readonly runId: string;
  /** The session incarnation the run started in; input admitted to another one is refused. */
  readonly incarnation: string;
  /** The session's session-input mailbox, the same instance admission writes to. */
  readonly mailbox: Mailbox;
  readonly sessionStore: SessionStore;
  readonly nowISO: () => string;
  readonly timers?: MailboxSessionInputGateTimers | undefined;
  readonly onRenewalError?: ((error: unknown) => void) | undefined;
  /** Stops the gate keeping its leases alive once it aborts (the bureau shutting down). */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Reads one claimed command as a persisted session input, or throws, which the
 * gate turns into a rejection without retry. Everything is checked, because the
 * value is plain stored data that an untyped caller, another version, or a
 * damaged record may have shaped, and a malformed one must be refused here
 * rather than fail a live run inside a step.
 */
export function decodeSessionInputCommand(
  claim: ApplicationCommandClaim,
  incarnation: string,
): DecodedSessionInput {
  if (claim.payload.form !== 'inline') {
    throw new TypeError('A session input must carry an inline payload.');
  }
  const value: unknown = claim.payload.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('A session input must be stored as an object.');
  }
  const persisted = value as Partial<Record<keyof PersistedSessionInput, unknown>>;
  if (typeof persisted.incarnation !== 'string') {
    throw new TypeError('A session input must record the session incarnation it was admitted to.');
  }
  if (persisted.incarnation !== incarnation) {
    throw new Error(
      'This session input was admitted to an earlier incarnation of the session and is not delivered to this one.',
    );
  }
  for (const field of ['expiresAt', 'supersedes'] as const) {
    if (persisted[field] !== undefined && typeof persisted[field] !== 'string') {
      throw new TypeError(`A session input's ${field} must be a string when present.`);
    }
  }
  return {
    payload: parseSessionInputPayload(persisted.payload),
    deliveryMode: decodeSessionInputKind(claim.receipt.kind),
  };
}

/**
 * COR-1476 — the {@link SessionInputGate} a Bureau hands each durable run of a
 * session, so input `submitSessionInput` admitted reaches the run at its next
 * step boundary.
 *
 * Operative's mailbox gate owns the claim, lease, and settle protocol. This
 * supplies the two Bureau-specific halves of it: how an admitted command decodes
 * ({@link decodeSessionInputCommand}), and where delivery is recorded: the
 * session's own metadata, keyed by the mailbox command (see
 * `session-input-promotion.ts`), so the record that decides an input must not be
 * delivered twice is the same one that makes its receipt read `promoted`.
 *
 * Delivery does not honour a record's `expiresAt` or `supersedes`: neither has a
 * terminal state recorded anywhere yet, so an expired or superseded input is
 * delivered like any other.
 */
export function createSessionInputDeliveryGate(
  options: SessionInputDeliveryOptions,
): SessionInputGate {
  const { sessionId, runId, incarnation, mailbox, sessionStore, nowISO } = options;
  return createMailboxSessionInputGate({
    mailbox,
    owner: runId,
    decode: (claim) => decodeSessionInputCommand(claim, incarnation),
    deliveries: {
      claim: (owner, commandIds) =>
        claimSessionInputDeliveries(sessionStore, sessionId, owner, commandIds, nowISO),
      promote: (deliveries) =>
        promoteSessionInputs(sessionStore, sessionId, runId, deliveries, nowISO),
    },
    timers: options.timers,
    onRenewalError: options.onRenewalError,
    signal: options.signal,
  });
}
