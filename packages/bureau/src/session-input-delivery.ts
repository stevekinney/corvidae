import {
  createMailboxSessionInputGate,
  type DecodedSessionInput,
  type MailboxSessionInputGateTimers,
  parseSessionInputPayload,
  type SessionInputDeliveryStore,
  type SessionInputGate,
} from '@lostgradient/operative';
import type { ApplicationCommandClaim, Mailbox } from '@lostgradient/weft';
import { createUnsupportedSchemaVersionError, CURRENT_SCHEMA_VERSION } from 'conversationalist';

import {
  decodeSessionInputKind,
  type PersistedSessionInput,
  SESSION_INPUT_EXPIRED_MESSAGE,
} from './session-input-durability';

/** What {@link createSessionInputDeliveryGate} reads and writes for one run. */
export interface SessionInputDeliveryOptions {
  readonly sessionId: string;
  /** The run this gate delivers for, named in the session's delivery records. */
  readonly runId: string;
  /**
   * The session incarnation the run started in, which the mailbox belongs to.
   * The mailbox is keyed by the incarnation, so every record in it was
   * admitted to this one; decoding still asserts it, and refuses a record
   * that says otherwise as malformed.
   */
  readonly incarnation: string;
  /** The session's session-input mailbox, the same instance admission writes to. */
  readonly mailbox: Mailbox;
  readonly deliveryStore: SessionInputDeliveryStore;
  /** Whether a run is live: one that will replay or re-run the step that appended its input. */
  readonly isOwnerLive: (runId: string) => Promise<boolean>;
  readonly now: () => number;
  readonly timers?: MailboxSessionInputGateTimers | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  /** Disposes the gate when it aborts (the bureau shutting down). */
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
  nowMs?: number,
): DecodedSessionInput {
  if (claim.payload.form !== 'inline') {
    throw new TypeError('A session input must carry an inline payload.');
  }
  const value: unknown = claim.payload.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('A session input must be stored as an object.');
  }
  const persisted = value as Partial<Record<keyof PersistedSessionInput, unknown>>;
  if (persisted.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw createUnsupportedSchemaVersionError(persisted.schemaVersion, CURRENT_SCHEMA_VERSION);
  }
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
  // The persisted instant is the authority on expiry: the mailbox's deadline can trail it.
  if (
    nowMs !== undefined &&
    typeof persisted.expiresAt === 'string' &&
    Date.parse(persisted.expiresAt) <= nowMs
  ) {
    throw new Error(SESSION_INPUT_EXPIRED_MESSAGE);
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
 * Operative's mailbox gate owns the claim, lease, and retire protocol. This
 * supplies the two Bureau-specific halves of it: how an admitted command decodes
 * ({@link decodeSessionInputCommand}), and where delivery is recorded: the
 * session's delivery store, keyed by the mailbox command, which also holds the
 * promotion the checkpoint write commits with the transcript.
 *
 * Delivery honours a record's `expiresAt` twice (COR-1661): the mailbox's absolute deadline, set when
 * the input is admitted, refuses a claim past it and dead-letters the command as
 * `deadline-exceeded`; and decoding refuses a claim whose persisted `expiresAt` has passed, because
 * that deadline is set from the clock at admission and can trail the instant by however long the
 * admission took. It does not honour `supersedes`: that has no terminal state recorded anywhere
 * yet, so a superseded input is delivered like any other.
 */
export function createSessionInputDeliveryGate(
  options: SessionInputDeliveryOptions,
): SessionInputGate {
  const { sessionId, runId, incarnation, mailbox, deliveryStore, isOwnerLive } = options;
  return createMailboxSessionInputGate({
    mailbox,
    decode: (claim) => decodeSessionInputCommand(claim, incarnation, options.now()),
    deliveries: {
      claim: (commandIds) => deliveryStore.claim(sessionId, runId, commandIds, isOwnerLive),
    },
    now: options.now,
    timers: options.timers,
    onError: options.onError,
    signal: options.signal,
  });
}
