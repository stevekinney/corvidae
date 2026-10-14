import type { ConditionalTextValueStore, Storage } from '@lostgradient/weft';
import { encodeStorageKeyComponent, Mailbox } from '@lostgradient/weft';

import type {
  ImplementedSteeringCommand,
  SteeringDurableState,
  StoredSteeringCommand,
} from './steering';

/**
 * AB-200 — durable steering: the mailbox a durably-configured Bureau
 * persists admitted steering commands into, so an `accepted` command
 * survives a process restart instead of living only in the in-memory
 * gate.
 *
 * ## Why a mailbox and not a bespoke key
 *
 * WFT-84's `Mailbox` already owns exactly this problem — FIFO ordering
 * within one resource, idempotent admission bound to
 * `(caller, target, kind, payloadDigest)`, a receipt that survives
 * restart, and state transitions committed atomically with their fleet
 * event. Writing steering's own records against `Storage` directly would
 * reimplement all of it, worse. AB-67's own record anticipated this:
 * steering persistence is "a projection of the same mailbox
 * envelope/receipt contract".
 *
 * ## The division of authority
 *
 * The in-memory `BureauSteeringGate` stays the authority for *desired
 * state* — it owns `configVersion` accounting, per-run pause scoping and
 * supersession, and none of that belongs in a durable queue. The mailbox
 * is the durable *log*: what was admitted, by whom, and whether it has
 * been consumed. Two small `runtime.kv` records complete the picture,
 * because recovery acknowledges what it replays: a per-session snapshot of
 * the gate's desired state (restored before the log is replayed) and a
 * per-command record answering idempotency questions after the log has
 * been drained. Both are defined at the end of this module.
 *
 * That ordering matters. A command is written to the mailbox *before* it
 * reaches the gate, so a crash between the two loses nothing — recovery
 * finds it still un-consumed and replays it. The reverse order would
 * admit a command into desired state that no restart could ever recover.
 */

/** Weft namespaces this Bureau's steering mailboxes. Opaque to Weft. */
const STEERING_NAMESPACE = 'corvidae.bureau.steering';

/**
 * One session incarnation's steering mailbox. Sessions get their own
 * `resourceId` because FIFO order is meaningful within a session and
 * meaningless across unrelated ones, and the resource includes the
 * session's `incarnation` so a deleted-then-recreated session id never
 * inherits its predecessor's undrained log.
 */
export function createSteeringMailbox(
  storage: Storage,
  sessionId: string,
  incarnation: string,
): Mailbox {
  return new Mailbox({
    storage,
    namespace: STEERING_NAMESPACE,
    resourceId: sessionScope(sessionId, incarnation),
  });
}

/** `(sessionId, incarnation)` as one unambiguous key component pair. */
function sessionScope(sessionId: string, incarnation: string): string {
  return `${encodeStorageKeyComponent(sessionId)}:${encodeStorageKeyComponent(incarnation)}`;
}

/** The payload a steering command persists as. */
export interface PersistedSteeringCommand {
  readonly id: string;
  readonly sessionId: string;
  readonly principal: string;
  readonly requestedValue: ImplementedSteeringCommand['requestedValue'];
  readonly requestedAt: string;
  readonly runId?: string | undefined;
  readonly expectedRevision?: number | undefined;
  readonly deadline?: string | undefined;
}

/**
 * Persists one admitted steering command. Returns the mailbox's own
 * command id and its per-session FIFO `sequence`, or the reason nothing
 * was written.
 *
 * `idempotencyKey` is the caller-facing command id, so an exact retry
 * replays the original receipt rather than creating a second command —
 * the same idempotency the in-memory gate's ledger provides, now
 * surviving restart.
 */
export async function persistSteeringCommand(
  mailbox: Mailbox,
  command: ImplementedSteeringCommand,
): Promise<
  { persisted: true; commandId: string; sequence: number } | { persisted: false; reason: string }
> {
  const payload: PersistedSteeringCommand = {
    id: command.id,
    sessionId: command.sessionId,
    principal: command.principal,
    requestedValue: command.requestedValue,
    requestedAt: command.requestedAt,
    ...(command.runId !== undefined ? { runId: command.runId } : {}),
    ...(command.expectedRevision !== undefined
      ? { expectedRevision: command.expectedRevision }
      : {}),
    ...(command.deadline !== undefined ? { deadline: command.deadline } : {}),
  };

  const admission = await mailbox.admit({
    caller: command.principal,
    target: command.sessionId,
    kind: `steering:${command.requestedValue.target}`,
    payload: { form: 'inline', value: payload as unknown as Record<string, unknown> },
    idempotencyKey: command.id,
  });

  switch (admission.status) {
    case 'admitted':
    case 'duplicate':
      return {
        persisted: true,
        commandId: admission.receipt.commandId,
        sequence: admission.receipt.sequence,
      };
    case 'conflict':
      return { persisted: false, reason: 'idempotency-identity-mismatch' };
    case 'rejected':
      return { persisted: false, reason: admission.reason };
  }
}

/**
 * Drains this session's steering mailbox, in FIFO order, for replay into a
 * fresh gate after a restart.
 *
 * Claim, replay, acknowledge — not a passive read. A receipt from `list()`
 * carries only metadata (`payloadDigest`, `payloadForm`); the payload
 * itself is delivered on `claim()`, digest-verified. Claiming is also the
 * correct semantic rather than a workaround: recovery genuinely *consumes*
 * each command into desired state, and acknowledging says so.
 *
 * A crash midway is safe by construction, but only because `apply` runs
 * before the acknowledgement for each command individually. A
 * claimed-but-unacknowledged command's visibility lease expires and it
 * returns to the queue head, so the next boot replays it. The cost of
 * that safety is at-least-once replay, which is harmless here precisely
 * because replay is idempotent: re-applying "desired model is X" yields
 * the same desired state, and the gate's own value-idempotency check
 * declines to advance `configVersion` for a value already in force.
 *
 * `apply` receives each command with its mailbox `sequence`, so a caller
 * holding a durable desired-state snapshot can skip commands that snapshot
 * already reflects.
 *
 * `maximumCommands` bounds one drain so a pathological backlog cannot
 * stall boot indefinitely; the remainder stays durable for the next pass.
 */
export async function recoverSteeringCommands(
  mailbox: Mailbox,
  apply: (command: PersistedSteeringCommand, sequence: number) => unknown,
  maximumCommands = 1000,
): Promise<number> {
  let applied = 0;
  for (let drained = 0; drained < maximumCommands; drained += 1) {
    const result = await mailbox.claim();
    if (result.status !== 'claimed') break;
    const { claim } = result;
    const command = readInlinePayload(claim.payload);
    if (command !== undefined) {
      // Apply BEFORE acknowledging, per command. `apply` is the caller's
      // replay into the in-memory gate, and acknowledging is what durably
      // forgets the command — so acknowledging first would open a window
      // where a crash loses it from both sides at once: already forgotten
      // durably, never applied in memory.
      //
      // An earlier version of this function collected the whole batch,
      // acknowledging as it went, and let the caller admit afterwards.
      // That contradicted this function's own crash-safety claim, and the
      // window was up to `maximumCommands` wide.
      //
      // `apply` may be asynchronous — the caller persists its desired-state
      // snapshot there — and is awaited before the acknowledgement, which
      // is the property that matters: the command is reflected durably
      // before the mailbox forgets it. The caller keeps its own gate write
      // synchronous within `apply`, so no other admission can interleave
      // between a replayed command and its gate write.
      await apply(command, claim.receipt.sequence);
      applied += 1;
      await mailbox.acknowledge({
        commandId: claim.receipt.commandId,
        attemptToken: claim.attemptToken,
      });
    } else {
      // A malformed or reference-form payload is rejected outright rather
      // than replayed: a partial record must never become a steering
      // decision, and leaving it claimed would have it reappear on every
      // subsequent boot forever.
      await mailbox.reject({
        commandId: claim.receipt.commandId,
        attemptToken: claim.attemptToken,
        failure: { reason: 'application', message: 'unreadable steering payload' },
        retry: false,
      });
    }
  }
  return applied;
}

function readInlinePayload(payload: {
  readonly form: string;
  readonly value?: unknown;
}): PersistedSteeringCommand | undefined {
  if (payload.form !== 'inline') return undefined;
  const value = payload.value;
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<PersistedSteeringCommand>;
  // Fail closed on a malformed record rather than replaying a partial
  // command into desired state: a hostile or truncated payload must not
  // become a steering decision.
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.principal !== 'string' ||
    typeof candidate.requestedAt !== 'string' ||
    typeof candidate.requestedValue !== 'object' ||
    candidate.requestedValue === null
  ) {
    return undefined;
  }
  return candidate as PersistedSteeringCommand;
}

/**
 * The durable steering bookkeeping a durably-configured Bureau keeps in
 * `runtime.kv` beside each session incarnation's mailbox. Recovery
 * acknowledges what it replays, so the mailbox alone carries neither
 * desired state nor idempotency past one restart; these records do.
 *
 * - A **lease** per session incarnation: the single Bureau process allowed
 *   to admit steering for it. Every other write below is fenced on it, so
 *   two processes sharing one backend can never both advance one session's
 *   durable state. The lease fences admission only: a live run reads its
 *   own process's gate, so steering admitted elsewhere reaches it at that
 *   process's next recovery.
 * - A **desired-state snapshot** per session incarnation: the gate's
 *   session-scoped desired state plus the highest mailbox `sequence` it
 *   reflects. Recovery restores it and replays only later entries.
 * - A **command record** per `(principal, id)`, keyed bureau-wide exactly
 *   as the in-memory ledger is, and indexed per session incarnation for
 *   deletion. It is reserved before the mailbox write — so a concurrent or
 *   orphaned admission of the same key is detected before anything is
 *   logged — and then kept current through every state transition.
 *
 * Everything is keyed by session incarnation as well as id, so cleanup
 * after a deletion can never touch a recreated session's state, and a
 * recreated session never inherits the deleted one's.
 */
const STEERING_LEASE_PREFIX = 'steering-lease:v1';
const STEERING_DESIRED_STATE_PREFIX = 'steering-desired-state:v2';
const STEERING_RECORD_PREFIX = 'steering-command:v2';
const STEERING_RECORD_INDEX_PREFIX = 'steering-command-session:v2';

/**
 * How long a steering lease is honored without renewal before another
 * process may take it over. Admission renews it, so it only lapses for a
 * session nobody is steering, or one whose owner died. A restarted process
 * keeping the same Bureau `id` reclaims its own lease immediately; any
 * other process waits this long after an owner's crash.
 */
export const STEERING_LEASE_TTL_MS = 60_000;

function steeringLeaseKey(sessionId: string, incarnation: string): string {
  return `${STEERING_LEASE_PREFIX}:${sessionScope(sessionId, incarnation)}`;
}

function steeringDesiredStateKey(sessionId: string, incarnation: string): string {
  return `${STEERING_DESIRED_STATE_PREFIX}:${sessionScope(sessionId, incarnation)}`;
}

function steeringRecordKey(principal: string, id: string): string {
  return `${STEERING_RECORD_PREFIX}:${encodeStorageKeyComponent(principal)}:${encodeStorageKeyComponent(id)}`;
}

function steeringRecordIndexPrefix(sessionId: string, incarnation: string): string {
  return `${STEERING_RECORD_INDEX_PREFIX}:${sessionScope(sessionId, incarnation)}:`;
}

function steeringRecordIndexKey(
  sessionId: string,
  incarnation: string,
  principal: string,
  id: string,
): string {
  return `${steeringRecordIndexPrefix(sessionId, incarnation)}${encodeStorageKeyComponent(principal)}:${encodeStorageKeyComponent(id)}`;
}

/** A held steering lease, as this process last wrote it. */
export interface SteeringLease {
  readonly key: string;
  /** The exact stored value, the precondition every fenced write uses. */
  readonly raw: string;
}

interface SteeringLeaseValue {
  readonly owner: string;
  readonly token: string;
  readonly expiresAtMs: number;
}

function parseSteeringLease(raw: string | null): SteeringLeaseValue | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { owner?: unknown }).owner === 'string' &&
      typeof (parsed as { token?: unknown }).token === 'string' &&
      typeof (parsed as { expiresAtMs?: unknown }).expiresAtMs === 'number'
    ) {
      return parsed as SteeringLeaseValue;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type SteeringLeaseAcquisition =
  | {
      readonly acquired: true;
      readonly lease: SteeringLease;
      /** False when this process did not hold the lease up to now — a fresh acquisition, a takeover, or a reclaim after a restart — so its in-memory gate must be rebuilt from durable state. */
      readonly continuous: boolean;
    }
  | { readonly acquired: false };

/**
 * Acquires or renews `owner`'s steering lease for one session incarnation.
 * `held` is the lease this process last wrote, if any; the acquisition is
 * `continuous` only when the stored value is still exactly that. Another
 * owner's unexpired lease is refused. A malformed, expired, or same-owner
 * lease is taken over.
 */
export async function acquireSteeringLease(
  kv: ConditionalTextValueStore,
  sessionId: string,
  incarnation: string,
  options: {
    readonly owner: string;
    readonly token: string;
    readonly nowMs: number;
    readonly held: SteeringLease | undefined;
  },
): Promise<SteeringLeaseAcquisition> {
  const key = steeringLeaseKey(sessionId, incarnation);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const currentRaw = await kv.get(key);
    const current = parseSteeringLease(currentRaw);
    const continuous = options.held !== undefined && currentRaw === options.held.raw;
    if (
      !continuous &&
      current !== undefined &&
      current.owner !== options.owner &&
      current.expiresAtMs > options.nowMs
    ) {
      return { acquired: false };
    }
    const raw = JSON.stringify({
      owner: options.owner,
      token: options.token,
      expiresAtMs: options.nowMs + STEERING_LEASE_TTL_MS,
    } satisfies SteeringLeaseValue);
    const committed = await kv.conditionalBatch(
      [{ key, expectedValue: currentRaw }],
      [{ type: 'set', key, value: raw }],
    );
    if (committed) return { acquired: true, lease: { key, raw }, continuous };
  }
  return { acquired: false };
}

/** Releases `lease` if it is still exactly what this process wrote. */
export async function releaseSteeringLease(
  kv: ConditionalTextValueStore,
  lease: SteeringLease,
): Promise<void> {
  await kv.conditionalBatch(
    [{ key: lease.key, expectedValue: lease.raw }],
    [{ type: 'delete', key: lease.key }],
  );
}

/** A record as stored: reserved before the mailbox write, admitted after. */
export interface SteeringCommandRecord {
  readonly phase: 'reserved' | 'admitted';
  readonly incarnation: string;
  readonly command: StoredSteeringCommand;
}

function parseSteeringCommandRecord(
  raw: string,
  principal: string,
  id: string,
): SteeringCommandRecord {
  const parsed: unknown = JSON.parse(raw);
  const command = (parsed as { command?: Partial<StoredSteeringCommand> } | null)?.command;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    ((parsed as { phase?: unknown }).phase !== 'reserved' &&
      (parsed as { phase?: unknown }).phase !== 'admitted') ||
    typeof (parsed as { incarnation?: unknown }).incarnation !== 'string' ||
    command?.id !== id ||
    command.principal !== principal ||
    typeof command.sessionId !== 'string' ||
    typeof command.requestedValue?.target !== 'string'
  ) {
    throw new Error(`Steering command record for "${principal}"/"${id}" is malformed.`);
  }
  return parsed as SteeringCommandRecord;
}

/**
 * Reads the record for `(principal, id)`, whichever session it belongs to,
 * or `undefined` when there is none. A malformed record throws: it stands
 * for an admission whose identity can no longer be checked, and treating
 * it as absent would let a mismatched retry through.
 */
export async function loadSteeringCommandRecord(
  kv: ConditionalTextValueStore,
  principal: string,
  id: string,
): Promise<SteeringCommandRecord | undefined> {
  const raw = await kv.get(steeringRecordKey(principal, id));
  return raw === null ? undefined : parseSteeringCommandRecord(raw, principal, id);
}

export type SteeringFencedWrite = 'committed' | 'fence-lost';

/**
 * Reserves `(principal, id)` for `command`, fenced on `lease`, before the
 * command is written to the mailbox. `exists` carries the record that
 * already holds the key; `fence-lost` means this process no longer owns the
 * session's steering.
 */
export async function reserveSteeringCommandRecord(
  kv: ConditionalTextValueStore,
  lease: SteeringLease,
  incarnation: string,
  command: StoredSteeringCommand,
): Promise<
  | { readonly status: 'reserved' }
  | { readonly status: 'exists'; readonly record: SteeringCommandRecord }
  | { readonly status: 'fence-lost' }
> {
  const key = steeringRecordKey(command.principal, command.id);
  const record: SteeringCommandRecord = { phase: 'reserved', incarnation, command };
  const committed = await kv.conditionalBatch(
    [
      { key: lease.key, expectedValue: lease.raw },
      { key, expectedValue: null },
    ],
    [
      { type: 'set', key, value: JSON.stringify(record) },
      {
        type: 'set',
        key: steeringRecordIndexKey(command.sessionId, incarnation, command.principal, command.id),
        value: key,
      },
    ],
  );
  if (committed) return { status: 'reserved' };
  if ((await kv.get(lease.key)) !== lease.raw) return { status: 'fence-lost' };
  const existing = await loadSteeringCommandRecord(kv, command.principal, command.id);
  // The key was taken and released again between the failed write and
  // this read; reporting the fence as lost makes the caller refuse rather
  // than admit without a reservation.
  return existing === undefined ? { status: 'fence-lost' } : { status: 'exists', record: existing };
}

/**
 * Deletes a record (and its index entry) left by a session incarnation that
 * no longer exists. Unfenced: no live session's lease covers a deleted one.
 */
export async function discardSteeringCommandRecord(
  kv: ConditionalTextValueStore,
  record: SteeringCommandRecord,
): Promise<void> {
  const { command } = record;
  await kv.delete(
    steeringRecordIndexKey(command.sessionId, record.incarnation, command.principal, command.id),
  );
  await kv.delete(steeringRecordKey(command.principal, command.id));
}

/** Writes the current state of a command's record, fenced on `lease`. */
export async function writeSteeringCommandRecord(
  kv: ConditionalTextValueStore,
  lease: SteeringLease,
  record: SteeringCommandRecord,
): Promise<SteeringFencedWrite> {
  const { command } = record;
  const key = steeringRecordKey(command.principal, command.id);
  const committed = await kv.conditionalBatch(
    [{ key: lease.key, expectedValue: lease.raw }],
    [
      { type: 'set', key, value: JSON.stringify(record) },
      {
        type: 'set',
        key: steeringRecordIndexKey(
          command.sessionId,
          record.incarnation,
          command.principal,
          command.id,
        ),
        value: key,
      },
    ],
  );
  return committed ? 'committed' : 'fence-lost';
}

/** Removes a reservation the gate then declined to record, fenced on `lease`. */
export async function releaseSteeringCommandReservation(
  kv: ConditionalTextValueStore,
  lease: SteeringLease,
  incarnation: string,
  command: StoredSteeringCommand,
): Promise<SteeringFencedWrite> {
  const committed = await kv.conditionalBatch(
    [{ key: lease.key, expectedValue: lease.raw }],
    [
      { type: 'delete', key: steeringRecordKey(command.principal, command.id) },
      {
        type: 'delete',
        key: steeringRecordIndexKey(command.sessionId, incarnation, command.principal, command.id),
      },
    ],
  );
  return committed ? 'committed' : 'fence-lost';
}

/** See the section comment above. */
export interface SteeringDesiredStateSnapshot {
  readonly mailboxSequence: number;
  readonly state: SteeringDurableState;
}

/** Writes one session incarnation's desired-state snapshot, fenced on `lease`. */
export async function persistSteeringDesiredState(
  kv: ConditionalTextValueStore,
  lease: SteeringLease,
  sessionId: string,
  incarnation: string,
  snapshot: SteeringDesiredStateSnapshot,
): Promise<SteeringFencedWrite> {
  const committed = await kv.conditionalBatch(
    [{ key: lease.key, expectedValue: lease.raw }],
    [
      {
        type: 'set',
        key: steeringDesiredStateKey(sessionId, incarnation),
        value: JSON.stringify(snapshot),
      },
    ],
  );
  return committed ? 'committed' : 'fence-lost';
}

/**
 * Reads one session incarnation's desired-state snapshot, or `undefined`
 * when none was ever written. A malformed snapshot throws rather than
 * reading as absent: once recovery has acknowledged the commands it
 * reflects, it is the only durable copy of the session's desired state,
 * and silently starting from defaults would route later work differently
 * without anyone noticing.
 */
export async function loadSteeringDesiredState(
  kv: ConditionalTextValueStore,
  sessionId: string,
  incarnation: string,
): Promise<SteeringDesiredStateSnapshot | undefined> {
  const raw = await kv.get(steeringDesiredStateKey(sessionId, incarnation));
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { mailboxSequence?: unknown }).mailboxSequence !== 'number' ||
    typeof (parsed as { state?: { rawConfigVersion?: unknown } }).state?.rawConfigVersion !==
      'number'
  ) {
    throw new Error(
      `Steering desired-state snapshot for session "${sessionId}" is malformed; refusing to recover from defaults.`,
    );
  }
  return parsed as SteeringDesiredStateSnapshot;
}

/**
 * Deletes everything durable steering keeps for one session incarnation:
 * its command records (through their index), snapshot, and lease. Keyed by
 * incarnation, so it never touches a recreated session's state.
 */
export async function deleteSteeringSessionState(
  kv: ConditionalTextValueStore,
  sessionId: string,
  incarnation: string,
): Promise<void> {
  const indexKeys = await kv.list(steeringRecordIndexPrefix(sessionId, incarnation));
  for (const indexKey of indexKeys) {
    const recordKey = await kv.get(indexKey);
    if (recordKey !== null) await kv.delete(recordKey);
    await kv.delete(indexKey);
  }
  await kv.delete(steeringDesiredStateKey(sessionId, incarnation));
  await kv.delete(steeringLeaseKey(sessionId, incarnation));
}
