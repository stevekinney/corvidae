import {
  readSessionInputPromotion,
  type SessionInputAdmissionOutcome,
  type SessionInputDeliveryMode,
  type SessionInputPayload,
  type SessionInputPromotion,
  type SessionInputReceipt,
  type SessionInputState,
} from '@lostgradient/operative';
import { sha256HexSync } from '@lostgradient/cryptography';
import {
  type ApplicationCommandReceipt,
  type ConditionalTextValueStore,
  encodeStorageKeyComponent,
  Mailbox,
  type Storage,
} from '@lostgradient/weft';

/**
 * COR-435 — durable, mailbox-backed `submitSessionInput` admission.
 *
 * ## One mailbox for the durable log, one small KV index for cross-session identity
 *
 * WFT-84's `Mailbox` binds idempotency to `(caller, target, kind,
 * payloadDigest)` within one `(namespace, resourceId)` scope. That is exactly
 * right for everything AC3 asks EXCEPT one case:
 *
 * - The SESSION mailbox (one per session INCARNATION: `resourceId` is a
 *   digest of `(sessionId, incarnation)`, see `createSessionInputMailbox`) is
 *   the durable log AND the FIFO/backlog authority for one incarnation of a
 *   session. A session deleted and recreated under the same id therefore
 *   starts with an empty mailbox, and no reader has to check an incarnation:
 *   a run drains the mailbox of the incarnation it started in, a deletion
 *   retires that incarnation's mailbox, and an `id` reused in a later
 *   incarnation is a new input. `caller` is the submitting principal,
 *   `target` is fixed to `sessionId` (trivial within this mailbox, kept so
 *   the session stays readable), `kind` encodes `deliveryMode`, and the
 *   payload is the caller's own content. Because `id` is unique WITHIN a
 *   session regardless of principal (AB-42's 2026-09-02 coordinator
 *   amendment), `idempotencyKey` here is `id` alone. This one mailbox, one `admit()` call, and Weft's own
 *   idempotency-vs-backlog ordering (idempotency resolved BEFORE the backlog
 *   check — see `mailbox-admission.ts`) together produce `replayed`,
 *   `delivery-mode-mismatch`, `payload-mismatch`, `id-owned-by-other-principal`,
 *   and the native per-session `backlog-exhausted` correctly and atomically.
 *
 * - `session-mismatch` — the same `(principal, id)` retried against a
 *   DIFFERENT session — is structurally invisible to the session mailbox: a
 *   retry against a different `sessionId` lands in an entirely different
 *   mailbox instance. Catching it needs a second index, but a whole second
 *   `Mailbox` is heavy machinery for a `(principal, id) -> sessionId`
 *   lookup, and its records would never terminalize (nothing ever claims or
 *   acknowledges them), growing an identity mailbox without bound for a
 *   principal who legitimately submits many distinct ids over a long
 *   process lifetime — a real, disclosed problem in an earlier version of
 *   this module, not a hypothetical one.
 *
 *   This version replaces that mailbox with a small, TTL-bounded record in
 *   `runtime.kv` (`ConditionalTextValueStore` — the SAME text-value store
 *   `createSessionStore` builds sessions over; see `runtime-composition.ts`
 *   lines ~1731-1743, "Keep the raw Storage so the durable engine can share
 *   the exact backend with the text-value KV view"). One key per
 *   `(principal, id)`, compare-and-swapped via `kv.conditionalBatch`, holding
 *   the session and the incarnation the id belongs to and, as information
 *   for a reader, whether that incarnation's mailbox had admitted it when the
 *   value was written (`pending` from the claim until the mailbox commit,
 *   `admitted` after). A live identity naming the same session but another
 *   incarnation is an orphan of a deleted incarnation, taken over the way an
 *   orphan of a refused admission is: the id is admitted fresh.
 *   The field decides nothing on its own: every decision below reads the
 *   mailbox for the record, and the fence against a concurrent writer is the
 *   compare-and-swap's expected value, the exact bytes the attempt read. The
 *   rules the index keeps, and why:
 *
 *   - An identity is never deleted. A refusal (either backlog) or a thrown
 *     admission leaves its `pending` claim in place, because another process
 *     may already be admitting under it: deleting it would let the same id
 *     into a second session while the first's record stood.
 *   - A claim this session holds is a replay only if this session's mailbox
 *     holds a record for the id. Otherwise the claim is an orphan of a refused
 *     admission, and the attempt runs the full admission, principal check
 *     included, so a retry at the limit is refused the way the original was.
 *   - A claim another session holds answers `conflict` only if that session's
 *     mailbox holds a record. A `pending` claim with no record is an orphan
 *     and is taken over by compare-and-swap against the value read. The
 *     owner of an admission still in flight loses that swap when it commits
 *     its own record: it cancels the command it just admitted and answers
 *     with that receipt (`canceled`), so one id is never live in two
 *     sessions; its caller resends, and the resend reads the conflict.
 *   - The index and the mailbox are two stores with no transaction across
 *     them, and that leaves one window the rules above do not close: an
 *     attempt that found no record in the owning session and is about to take
 *     the claim over, against an owner that has just committed its record and
 *     is about to swap its identity to `admitted`. The takeover wins the swap,
 *     the owner then cancels its command, but a run of the owning session can
 *     claim that command in between, so for a moment one id is live in two
 *     sessions and the owner's caller may read `promoted` rather than
 *     `canceled`. Closing it needs an admission that writes the record and the
 *     identity in one transaction, which is Weft's to offer; until then it is
 *     disclosed here and bounded to that one interleaving.
 *   - `admitted` with no record is unreachable while
 *     `SESSION_INPUT_TERMINAL_RETENTION_MS` is at least
 *     `SESSION_INPUT_IDENTITY_TTL_MS`: the mailbox keeps a terminal record
 *     past the identity's lifetime, so the cross-session path always finds the
 *     record it answers from and never throws. Should it happen anyway (a
 *     replay refreshed an identity after its record terminalized), it is
 *     treated as an orphan and taken over, never thrown on.
 *
 *   An entry older than `SESSION_INPUT_IDENTITY_TTL_MS` is treated as absent —
 *   claimable again — rather than kept forever: overwriting an expired
 *   entry keeps each key's OWN storage bounded (a stale value is replaced,
 *   never accumulated), and the tradeoff this makes explicit is that
 *   `session-mismatch` is only guaranteed detectable for an id reused
 *   within that window. Beyond it, an old id can be reused across sessions
 *   undetected. That is a deliberate, bounded cost — not a solved problem
 *   either, but a materially smaller and more honest one than "one entry
 *   per id, forever, with no eviction," which is what the mailbox-backed
 *   version actually shipped. Physical garbage collection of expired keys
 *   (as opposed to logical treat-as-absent) is not implemented in this
 *   slice; an expired key's bytes persist until a future write to the same
 *   `(principal, id)` overwrites them.
 */

/** Weft namespaces this Bureau's session-input mailboxes. Opaque to Weft. */
const SESSION_INPUT_NAMESPACE = 'corvidae.bureau.session-input';

/** Key prefix for the cross-session identity index in `runtime.kv`. */
const SESSION_INPUT_IDENTITY_KEY_PREFIX = 'session-input-identity:v1';

/** Bounds the compare-and-swap retry loop against concurrent claimants of the same key. */
const SESSION_INPUT_IDENTITY_MAX_CAS_ATTEMPTS = 10;

/**
 * How long an admitted input stays deliverable before the mailbox dead-letters
 * it and its receipt reads `expired`. Weft's own default is an hour, shorter
 * than a run may stay parked on a human reviewer or a wakeup, which would lose
 * input the receipt still called admitted.
 */
export const SESSION_INPUT_COMMAND_TIMEOUT_MS = 7 * 86_400_000;

/**
 * The most times a command may be leased before the mailbox dead-letters it
 * (Weft's ceiling). Retries here are crashes and lapsed leases, never poison:
 * a malformed input is rejected without retry when it is read. Weft's default
 * of 3 would dead-letter a healthy input after a few restarts.
 */
export const SESSION_INPUT_MAXIMUM_ATTEMPTS = 100;

/**
 * How long a `(principal, id) -> sessionId` identity claim is honored before
 * being treated as absent: the command's whole lifetime plus a day's margin,
 * so the same id can never be admitted to another session while the original
 * is still open.
 */
export const SESSION_INPUT_IDENTITY_TTL_MS = SESSION_INPUT_COMMAND_TIMEOUT_MS + 86_400_000;

/**
 * How long the mailbox keeps a terminal record (`promoted`, `canceled`,
 * `expired`, `rejected`) before retiring it, after which a replay of its id is
 * admitted as a fresh command. At least the identity's lifetime: a record is
 * retired no earlier than its terminal transition plus this, and an identity
 * is recorded no later than its admission, so the record the cross-session
 * path answers a conflict from outlives the identity that names it. Weft's
 * default of a day would retire an input that terminalized soon after
 * admission while its identity still named the session, and the conflict
 * would have no receipt to answer from.
 */
export const SESSION_INPUT_TERMINAL_RETENTION_MS = SESSION_INPUT_IDENTITY_TTL_MS;

/**
 * How long a delivery record outlives its last write: the identity's lifetime
 * plus a day's margin. A record may be deleted only when its command can no
 * longer be claimed by any run and a replay of its caller's id is answered
 * from the mailbox's retained record or as a fresh admission with a new
 * command.
 */
export const SESSION_INPUT_DELIVERY_RETENTION_MS = SESSION_INPUT_IDENTITY_TTL_MS + 86_400_000;

/**
 * The most bytes a session id may encode to and still be carried as each
 * command's `target`: Weft's identity limit. The mailbox resource itself is a
 * fixed-length digest, so this is the one length the session id is held to.
 */
export const SESSION_INPUT_MAX_SESSION_ID_BYTES = 256;

/** Whether a session id can be a command target in its mailbox. */
export function isSessionInputSessionIdAddressable(sessionId: string): boolean {
  return new TextEncoder().encode(sessionId).byteLength <= SESSION_INPUT_MAX_SESSION_ID_BYTES;
}

/**
 * The mailbox resource of one incarnation of a session: a fixed-length digest
 * of both, so the resource id stays within Weft's identity limit whatever the
 * session id's length, and no boundary between the two can be forged (a JSON
 * array, not a joined string).
 */
export function sessionInputMailboxResourceId(sessionId: string, incarnation: string): string {
  return `session-input:${sha256HexSync(JSON.stringify([sessionId, incarnation]))}`;
}

/**
 * One session incarnation's session-input mailbox — the durable log, FIFO
 * sequencer, and per-session backlog authority. Keyed by the incarnation, so a
 * session recreated under the same id starts with an empty mailbox and the
 * deleted incarnation's is retired on its own.
 */
export function createSessionInputMailbox(
  storage: Storage,
  sessionId: string,
  incarnation: string,
  sessionBacklogLimit: number,
  now?: () => number,
): Mailbox {
  return new Mailbox({
    storage,
    namespace: SESSION_INPUT_NAMESPACE,
    resourceId: sessionInputMailboxResourceId(sessionId, incarnation),
    maxBacklog: sessionBacklogLimit,
    commandTimeoutMs: SESSION_INPUT_COMMAND_TIMEOUT_MS,
    maxAttempts: SESSION_INPUT_MAXIMUM_ATTEMPTS,
    terminalRetentionMs: SESSION_INPUT_TERMINAL_RETENTION_MS,
    // A released command is due again almost at once: a lease a run's gate
    // returns is claimable by the session's next step boundary.
    retryBackoffMs: 10,
    maxRetryBackoffMs: 1_000,
    ...(now === undefined ? {} : { now }),
  });
}

function sessionInputIdentityKey(principal: string, id: string): string {
  // Each component is encoded individually (this codebase's established
  // colon-delimited key convention — see `encodeStorageKeyComponent`'s own
  // doc comment and its use throughout `packages/weft/src/core`'s key
  // builders) so neither `principal` nor `id` can inject a stray `:` that
  // merges two components, or any other byte that would stop this file
  // from being read as plain text — a raw delimiter byte embedded directly
  // in the template literal is exactly the mistake this convention exists
  // to prevent.
  return `${SESSION_INPUT_IDENTITY_KEY_PREFIX}:${encodeStorageKeyComponent(principal)}:${encodeStorageKeyComponent(id)}`;
}

/** Whether the named session's mailbox has committed a record for the id. */
type SessionInputIdentityAdmission = 'pending' | 'admitted';

interface SessionInputIdentityRecord {
  readonly sessionId: string;
  readonly incarnation: string;
  readonly recordedAtMs: number;
  readonly admission: SessionInputIdentityAdmission;
}

function encodeSessionInputIdentityRecord(record: SessionInputIdentityRecord): string {
  return JSON.stringify(record);
}

function parseSessionInputIdentityRecord(
  raw: string | null,
): SessionInputIdentityRecord | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { sessionId?: unknown }).sessionId === 'string' &&
      typeof (parsed as { incarnation?: unknown }).incarnation === 'string' &&
      typeof (parsed as { recordedAtMs?: unknown }).recordedAtMs === 'number'
    ) {
      const { sessionId, incarnation, recordedAtMs, admission } = parsed as {
        sessionId: string;
        incarnation: string;
        recordedAtMs: number;
        admission?: unknown;
      };
      // A record without the field predates it; it was only ever written
      // after an admission, so it is read as admitted.
      return {
        sessionId,
        incarnation,
        recordedAtMs,
        admission: admission === 'pending' ? 'pending' : 'admitted',
      };
    }
    return undefined;
  } catch {
    // Malformed JSON is treated exactly like an absent key (claimable) —
    // fails open toward "no cross-session memory" rather than fails closed
    // toward "permanently stuck," matching how an expired entry is handled.
    return undefined;
  }
}

/**
 * What the identity index says about this attempt, resolved against the
 * mailbox records it names (see the module doc's rules).
 *
 * - `fresh`: this session holds the claim, `pending`, and must run the full
 *   admission; `expected` is the value the commit swaps against.
 * - `replay`: this session holds the claim and its mailbox holds the record,
 *   so the principal check is skipped and the mailbox answers the replay;
 *   `commit` says the identity still reads `pending` and is upgraded.
 * - `conflict`: another session holds the id and its mailbox holds the record.
 */
type SessionInputIdentityClaim =
  | { readonly kind: 'fresh'; readonly expected: string | null }
  | { readonly kind: 'replay'; readonly expected: string; readonly commit: boolean }
  | {
      readonly kind: 'conflict';
      readonly existingSessionId: string;
      readonly existingIncarnation: string;
      readonly record: ApplicationCommandReceipt;
    };

/**
 * The mailbox record admitted under `id`, if the mailbox still holds one. A
 * direct lookup through the id's binding: a listing examines a bounded number
 * of index entries, and a session keeps its terminal records for the
 * identity's lifetime, so a live command can sit behind more retained entries
 * than one listing reaches, and a listing that did not reach it would have
 * read as "no record" and let the id into a second session.
 */
async function findSessionInputRecord(
  mailbox: Mailbox,
  id: string,
): Promise<ApplicationCommandReceipt | undefined> {
  return (await mailbox.receiptByIdempotencyKey(id)) ?? undefined;
}

/** One page of a session-input mailbox walk. */
export const SESSION_INPUT_MAILBOX_WALK_PAGE = 100;

/**
 * Visits every receipt the mailbox holds, in admission order (newest first
 * with `reverse`), until `visit` returns `false`. Unfiltered pages resumed by
 * `afterSequence`, so the walk is exhaustive where a single listing is
 * bounded: this is the only way the session-input code reads a set out of a
 * mailbox, because a bounded listing must never decide that something is
 * absent, that a set is empty, or that a limit is not yet reached. A
 * retention sweep deleting an entry between the index scan and the record
 * read shortens one page, not the walk, which only stops at an empty page.
 */
export async function walkSessionInputMailbox(
  mailbox: Mailbox,
  visit: (receipt: ApplicationCommandReceipt) => boolean | undefined | Promise<boolean | undefined>,
  options: { readonly reverse?: boolean } = {},
): Promise<void> {
  let afterSequence: number | undefined;
  for (;;) {
    const page = await mailbox.list({
      limit: SESSION_INPUT_MAILBOX_WALK_PAGE,
      ...(options.reverse === true ? { reverse: true } : {}),
      ...(afterSequence === undefined ? {} : { afterSequence }),
    });
    if (page.length === 0) return;
    for (const receipt of page) {
      if ((await visit(receipt)) === false) return;
    }
    afterSequence = page.at(-1)!.sequence;
  }
}

async function resolveSessionInputIdentity(
  attempt: SessionInputAdmissionAttempt,
): Promise<SessionInputIdentityClaim> {
  const { kv, storage, sessionMailbox, sessionId, incarnation, id, principal, nowMs } = attempt;
  const key = sessionInputIdentityKey(principal, id);
  for (let cas = 0; cas < SESSION_INPUT_IDENTITY_MAX_CAS_ATTEMPTS; cas += 1) {
    const raw = await kv.get(key);
    const current = parseSessionInputIdentityRecord(raw);
    const live =
      current !== undefined && nowMs - current.recordedAtMs <= SESSION_INPUT_IDENTITY_TTL_MS;
    if (live && current.sessionId === sessionId && current.incarnation === incarnation) {
      const record = await findSessionInputRecord(sessionMailbox, id);
      if (record === undefined) return { kind: 'fresh', expected: raw };
      return { kind: 'replay', expected: raw as string, commit: current.admission === 'pending' };
    }
    if (live && current.sessionId !== sessionId) {
      const record = await findSessionInputRecord(
        createSessionInputMailbox(
          storage,
          current.sessionId,
          current.incarnation,
          attempt.sessionBacklogLimitForCrossSessionRead,
        ),
        id,
      );
      if (record !== undefined) {
        return {
          kind: 'conflict',
          existingSessionId: current.sessionId,
          existingIncarnation: current.incarnation,
          record,
        };
      }
      // An orphan: a claim no admission committed under (or, unreachable while
      // the terminal retention covers the identity's lifetime, one whose record
      // has been retired). Taken over below.
    }
    // Absent, expired, an orphan, or the same session's earlier incarnation,
    // whose mailbox was retired with it: claimed for this incarnation.
    const pending = encodeSessionInputIdentityRecord({
      sessionId,
      incarnation,
      recordedAtMs: nowMs,
      admission: 'pending',
    });
    const committed = await kv.conditionalBatch(
      [{ key, expectedValue: raw }],
      [{ type: 'set', key, value: pending }],
    );
    if (committed) return { kind: 'fresh', expected: pending };
    // Lost the compare-and-swap race — someone else wrote this key between
    // the read and the write above. Re-read and retry against fresh state.
  }
  throw new Error(
    `Session-input identity index exceeded ${SESSION_INPUT_IDENTITY_MAX_CAS_ATTEMPTS} compare-and-swap attempts for principal "${principal}", id "${id}".`,
  );
}

/**
 * Records that this session's mailbox holds a record for the id. `false` when
 * the identity changed since `expected` was read: another attempt of this
 * session committed first, or another session took the claim over while this
 * admission was in flight; the caller tells which.
 */
async function commitSessionInputIdentity(
  attempt: SessionInputAdmissionAttempt,
  expected: string | null,
): Promise<boolean> {
  const key = sessionInputIdentityKey(attempt.principal, attempt.id);
  return attempt.kv.conditionalBatch(
    [{ key, expectedValue: expected }],
    [
      {
        type: 'set',
        key,
        value: encodeSessionInputIdentityRecord({
          sessionId: attempt.sessionId,
          incarnation: attempt.incarnation,
          recordedAtMs: attempt.nowMs,
          admission: 'admitted',
        }),
      },
    ],
  );
}

/** Reason recorded on a command cancelled because its identity was taken over by another session. */
export const SESSION_INPUT_IDENTITY_TAKEN_REASON =
  'the same input id was admitted to another session while this admission was in flight';

/** The payload a session input persists as, inside the session mailbox's inline command payload. */
export interface PersistedSessionInput {
  /**
   * The session incarnation the input was admitted to. The mailbox is keyed by
   * session id alone, so a recreated session would otherwise inherit what a
   * deleted one left pending; delivery refuses an input from another incarnation.
   */
  readonly incarnation: string;
  readonly payload: SessionInputPayload;
  readonly expiresAt?: string | undefined;
  readonly supersedes?: string | undefined;
}

function encodeSessionInputKind(deliveryMode: SessionInputDeliveryMode): string {
  return `session-input:${deliveryMode}`;
}

/** Inverse of {@link encodeSessionInputKind}. Throws on a kind this module never produced. */
export function decodeSessionInputKind(kind: string): SessionInputDeliveryMode {
  if (kind === 'session-input:steer') return 'steer';
  if (kind === 'session-input:queue') return 'queue';
  throw new Error(
    `Unrecognized session-input mailbox command kind "${kind}" — expected "session-input:steer" or "session-input:queue".`,
  );
}

/**
 * Builds the fixed {@link SessionInputReceipt} shape from a session mailbox's
 * own receipt.
 *
 * `revision` is fixed at `1`: nothing in this slice amends a record in
 * place. `state` is derived by `receiptState`: from `deliveryMode` for an
 * input still waiting, `'promoted'` once its command is promoted (read from
 * session metadata by the command's identity, via
 * {@link readSessionInputPromotion}), and an honest terminal state once the
 * mailbox has closed it some other way. Every caller building a receipt for an
 * EXISTING record (a replay, or a conflict's `originalReceipt`) must pass that
 * command's current promotion, never assume `deliveryMode` still describes it:
 * a replay of an already-promoted record used to report `accepted`/`queued`,
 * telling a legitimately-retrying caller the input was still waiting for a
 * boundary it had already passed.
 */
function buildReceipt(
  receipt: ApplicationCommandReceipt,
  deliveryMode: SessionInputDeliveryMode,
  promotion: SessionInputPromotion | undefined,
): SessionInputReceipt {
  if (receipt.idempotencyKey === undefined) {
    // Every admission through this module always supplies `idempotencyKey`
    // (the caller-facing `id`, generated when the caller omits one) —
    // reachable only if a future caller of this module stops doing that.
    throw new Error(
      'Session-input mailbox receipt is missing its idempotencyKey (caller-facing id).',
    );
  }
  return {
    id: receipt.idempotencyKey,
    sessionId: receipt.target,
    deliveryMode,
    admissionSequence: receipt.sequence,
    revision: 1,
    state: receiptState(receipt, deliveryMode, promotion),
    admittedAt: new Date(receipt.acceptedAt).toISOString(),
  };
}

/**
 * The state a receipt reports. Promotion in the session's metadata is the
 * authority for `promoted`; a command the mailbox has since closed without it
 * reports the honest terminal state, so a caller never reads `accepted` for
 * input that was dead-lettered, cancelled, or refused.
 */
function receiptState(
  receipt: ApplicationCommandReceipt,
  deliveryMode: SessionInputDeliveryMode,
  promotion: SessionInputPromotion | undefined,
): SessionInputState {
  if (promotion !== undefined || receipt.state === 'applied') return 'promoted';
  switch (receipt.state) {
    case 'dead-lettered':
      return receipt.failure?.reason === 'deadline-exceeded' ? 'expired' : 'failed';
    case 'cancelled':
      return 'canceled';
    case 'rejected':
      return 'failed';
    default:
      return deliveryMode === 'steer' ? 'accepted' : 'queued';
  }
}

/** Non-terminal `ApplicationCommandState`s — mirrors what counts toward a mailbox's own `openCount`. */
const OPEN_STATES: ReadonlySet<string> = new Set([
  'accepted',
  'available',
  'claimed',
  'cancellation-requested',
]);

/**
 * Whether `principal` has `limit` or more open (non-terminal) commands in a
 * session mailbox.
 *
 * The mailbox's own open count is exhaustive, so a session with fewer open
 * commands than the limit answers without a walk. Otherwise the walk reads
 * every record, stopping once it has seen as many open commands as that
 * count, which bounds it to the open set rather than to one listing.
 *
 * A manual, best-effort count — Weft has no native per-caller sub-quota
 * within one mailbox, so unlike the native per-session `maxBacklog` check
 * (atomic, inside `admit()`'s own compare-and-swap), this read-then-decide
 * has a benign race under CONCURRENT distinct submissions from the same
 * principal: two callers can both read a count under the limit and both
 * proceed to admit, together exceeding `principalBacklogLimit` by a small
 * margin. Disclosed and accepted (coordinator ruling): it degrades to
 * admitting slightly over the cap under concurrent distinct submissions,
 * which is not a correctness violation — a stronger guarantee would need
 * Weft to expose a native per-caller counter, which it does not today.
 */
async function principalAtBacklogLimit(
  mailbox: Mailbox,
  principal: string,
  limit: number,
): Promise<boolean> {
  const { open, admitted } = await mailbox.capacity();
  if (open < limit) return false;
  // Newest first, because open commands are the newest, and the walk stops
  // once it has seen as many open commands as the count read above. A command
  // admitted after that read has a sequence at or past `admitted` (sequences
  // are dense from zero, one per admission) and is not counted, so the count
  // is reached by the commands it described.
  let openSeen = 0;
  let ownedByPrincipal = 0;
  await walkSessionInputMailbox(
    mailbox,
    (receipt) => {
      if (receipt.sequence >= admitted || !OPEN_STATES.has(receipt.state)) return undefined;
      openSeen += 1;
      if (receipt.caller === principal) ownedByPrincipal += 1;
      return ownedByPrincipal < limit && openSeen < open;
    },
    { reverse: true },
  );
  return ownedByPrincipal >= limit;
}

/** Input to {@link admitSessionInput}, gathering everything the admission decision needs. */
export interface SessionInputAdmissionAttempt {
  readonly storage: Storage;
  readonly kv: ConditionalTextValueStore;
  readonly sessionMailbox: Mailbox;
  readonly sessionId: string;
  /** The session incarnation `sessionMailbox` belongs to; the identity names it. */
  readonly incarnation: string;
  readonly id: string;
  readonly principal: string;
  readonly deliveryMode: SessionInputDeliveryMode;
  readonly payload: PersistedSessionInput;
  readonly principalBacklogLimit: number;
  readonly sessionBacklogLimitForCrossSessionRead: number;
  readonly nowMs: number;
}

/**
 * What one admission attempt reports: `Bureau.submitSessionInput`'s outcomes
 * once a mailbox is composed (`admitted`, `replayed`, `conflict`,
 * `backlog-exhausted`), with an `admitted` outcome also naming the mailbox
 * command it created, which the caller needs to cancel the input it just
 * admitted when no run is live to deliver it (COR-1476). The command id is
 * Bureau's own and never reaches the caller-facing outcome.
 */
export type SessionInputAdmissionAttemptOutcome =
  | {
      readonly outcome: 'admitted';
      readonly receipt: SessionInputReceipt;
      readonly commandId: string;
    }
  | Exclude<SessionInputAdmissionOutcome, { readonly outcome: 'admitted' }>;

/**
 * Runs one admission attempt against the mailbox-plus-identity-index scheme
 * the module doc describes. Returns exactly the outcomes
 * `Bureau.submitSessionInput` contracts for once a mailbox is composed:
 * `admitted`, `replayed`, `conflict`, `backlog-exhausted`.
 */
export async function admitSessionInput(
  attempt: SessionInputAdmissionAttempt,
): Promise<SessionInputAdmissionAttemptOutcome> {
  const {
    kv,
    sessionMailbox,
    sessionId,
    incarnation,
    id,
    principal,
    deliveryMode,
    payload,
    principalBacklogLimit,
  } = attempt;

  // Fresh, not the caller's earlier snapshot: `submitSessionInput` loads the
  // session once, up front, for the pre-admission authorization/lifecycle
  // checks — but a promotion can land in the time between that load and
  // this admission attempt actually running (especially once an in-flight
  // reservation defers it), so a REPLAY or CONFLICT receipt describing an
  // EXISTING record must read this session's CURRENT promotion state, not
  // whatever it was when `submitSessionInput` started.
  async function currentPromotion(commandId: string): Promise<SessionInputPromotion | undefined> {
    return readSessionInputPromotion(kv, sessionId, commandId);
  }

  const claim = await resolveSessionInputIdentity(attempt);

  if (claim.kind === 'conflict') {
    // The ORIGINAL session's record, not the one this attempt targets: a
    // session-mismatch conflict's `originalReceipt` reflects that record's own
    // current state, promoted or not.
    const promotion = await readSessionInputPromotion(
      kv,
      claim.existingSessionId,
      claim.record.commandId,
    );
    return {
      outcome: 'conflict',
      conflict: {
        id,
        reason: 'session-mismatch',
        originalReceipt: buildReceipt(
          claim.record,
          decodeSessionInputKind(claim.record.kind),
          promotion,
        ),
      },
    };
  }

  // The principal backlog is checked ONLY for a fresh claim: a replay means
  // this session's mailbox already holds the record, and it creates nothing
  // new. AC5 ("before a record is created") is satisfied because this check
  // runs before the mailbox's own `admit()` call below, which is the one that
  // could create a record. A refusal leaves the pending claim in place (see
  // the module doc): the retry runs this check again.
  if (
    claim.kind === 'fresh' &&
    (await principalAtBacklogLimit(sessionMailbox, principal, principalBacklogLimit))
  ) {
    return { outcome: 'backlog-exhausted', scope: 'principal', limit: principalBacklogLimit };
  }

  const admission = await sessionMailbox.admit({
    caller: principal,
    target: sessionId,
    kind: encodeSessionInputKind(deliveryMode),
    payload: { form: 'inline', value: payload as unknown as Record<string, unknown> },
    idempotencyKey: id,
  });

  // With a record in this session's mailbox, the identity commits to
  // `admitted`. Losing that swap to another attempt of this session is fine
  // (it committed the same fact); losing it to another session means the
  // claim was taken over while this admission was in flight, and the command
  // this call created is cancelled before it can be delivered: the caller
  // reads `canceled` and resends, and the resend answers from the session
  // that holds the id.
  const commits = claim.kind === 'fresh' || claim.commit;
  if (admission.status !== 'rejected' && commits) {
    const committed = await commitSessionInputIdentity(attempt, claim.expected);
    if (!committed) {
      const latest = parseSessionInputIdentityRecord(
        await kv.get(sessionInputIdentityKey(principal, id)),
      );
      const ours = latest?.sessionId === sessionId && latest.incarnation === incarnation;
      if (!ours && admission.status === 'admitted') {
        const commandId = admission.receipt.commandId;
        await sessionMailbox.requestCancellation({
          commandId,
          reason: SESSION_INPUT_IDENTITY_TAKEN_REASON,
        });
        const cancelled = (await sessionMailbox.receipt(commandId)) ?? admission.receipt;
        return {
          outcome: 'admitted',
          receipt: buildReceipt(cancelled, deliveryMode, undefined),
          commandId,
        };
      }
    }
  }

  switch (admission.status) {
    case 'admitted':
      // Genuinely brand new: nothing has had a chance to promote it yet.
      return {
        outcome: 'admitted',
        receipt: buildReceipt(admission.receipt, deliveryMode, undefined),
        commandId: admission.receipt.commandId,
      };
    case 'duplicate':
      return {
        outcome: 'replayed',
        receipt: buildReceipt(
          admission.receipt,
          decodeSessionInputKind(admission.receipt.kind),
          await currentPromotion(admission.receipt.commandId),
        ),
      };
    case 'conflict': {
      const reason =
        admission.receipt.caller !== principal
          ? ('id-owned-by-other-principal' as const)
          : admission.receipt.kind !== encodeSessionInputKind(deliveryMode)
            ? ('delivery-mode-mismatch' as const)
            : ('payload-mismatch' as const);
      return {
        outcome: 'conflict',
        conflict: {
          id,
          reason,
          originalReceipt: buildReceipt(
            admission.receipt,
            decodeSessionInputKind(admission.receipt.kind),
            await currentPromotion(admission.receipt.commandId),
          ),
        },
      };
    }
    case 'rejected':
      return {
        outcome: 'backlog-exhausted',
        scope: 'session',
        limit: admission.capacity.limit,
      };
  }
}

/**
 * The receipt of one admitted input as the mailbox and the session's promotion
 * records describe it now (COR-1476): what `submitSessionInput` returns after
 * cancelling the input it just admitted, so the caller reads `canceled` rather
 * than the `accepted` the admission reported a moment earlier.
 */
export async function readSessionInputReceipt(
  kv: ConditionalTextValueStore,
  sessionMailbox: Mailbox,
  sessionId: string,
  commandId: string,
): Promise<SessionInputReceipt> {
  const receipt = await sessionMailbox.receipt(commandId);
  if (receipt === null) {
    throw new Error(
      `Session input command "${commandId}" of session "${sessionId}" has no mailbox receipt to read back.`,
    );
  }
  return buildReceipt(
    receipt,
    decodeSessionInputKind(receipt.kind),
    await readSessionInputPromotion(kv, sessionId, commandId),
  );
}
