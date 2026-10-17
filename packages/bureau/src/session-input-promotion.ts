import type {
  JSONValue,
  SessionInputDelivery,
  SessionInputDeliveryClaim,
  SessionInputPromotion,
  SessionStore,
} from '@lostgradient/operative';

/**
 * COR-435 AC6/AC7, COR-1476 — the durable record of which run is delivering
 * each admitted session input, and of the promotion (`accepted`/`queued` to
 * `promoted`) that completes it.
 *
 * ## One record per mailbox command, in the session's own metadata
 *
 * Both facts live in `session.metadata['sessionInputDeliveries']`, keyed by the
 * mailbox COMMAND's identity, never by the caller's input id. A caller may
 * legitimately reuse an id once the mailbox has retired the record (the identity
 * index's TTL and the mailbox's terminal retention are both a day), and a record
 * keyed by that id would then call a brand new input already delivered.
 *
 * An entry is written in two steps, each its own `SessionStore.update`
 * (optimistic-concurrency read-decide-commit):
 *
 * - {@link claimSessionInputDeliveries} records the run that is delivering a
 *   command, before the run appends the input to its conversation. A claim is
 *   never overwritten by a different run, so no second run (or a run recovering
 *   a crashed peer) appends an input another run already claimed, while the
 *   claiming run's own replay finds its claim and delivers again.
 * - {@link promoteSessionInputs} stamps the claimed entry with the promotion,
 *   which is what moves the input's receipt to `promoted`.
 *
 * ## Why not `ctx.memo` (AC6's literal wording)
 *
 * AC6 as filed says "a single dedicated `ctx.memo` step whose entire body is
 * one `conditionalBatch`". That wording was written against the old
 * `agent-bureau` repository. `ctx.memo` exists only inside an active workflow
 * generator's execution, and `Bureau.submitSessionInput` runs outside any
 * workflow. The observable contract (AC7: one correct outcome per crash window,
 * never a duplicate message) governs; the named mechanism does not. The run
 * workflow's own checkpointed step memo carries the message, and these writes
 * are idempotent around it.
 *
 * ## Crash windows
 *
 * - Before the claim commits: nothing durable happened; the retry claims.
 * - After the claim, before the step that appends the input is checkpointed: the
 *   claiming run's replay reads its own claim (`owned`) and appends again. No
 *   other run can, because the claim names this one.
 * - After the step is checkpointed, before promotion: the replayed workflow
 *   skips the step (its memo is cached) and runs the settle memo, which promotes.
 * - After promotion, before the mailbox command is acknowledged: the next
 *   boundary leases the command again, sees it `promoted`, and acknowledges it.
 *
 * Promotion rides the session outbox (`SessionStore.update()`'s `options.outbox`)
 * in the same commit as the metadata, the way review-transition audit records do
 * (AB-391), so a durable consumer can observe it. Entries older than
 * {@link SESSION_INPUT_DELIVERY_RETENTION_MS} are pruned on every write so the
 * metadata does not grow without bound; by then the mailbox has retired the
 * command they describe.
 *
 * @module session-input-promotion
 */

/** `SessionOutboxEntry.namespace` this module's attachments use. Opaque to `SessionStore`. */
export const SESSION_INPUT_PROMOTION_OUTBOX_NAMESPACE = 'session-input-promotion';

/** Key in session metadata holding the per-command delivery records. */
export const SESSION_INPUT_DELIVERIES_METADATA_KEY = 'sessionInputDeliveries';

/**
 * How long a delivery record outlives its last write. Longer than the mailbox's
 * one-day terminal retention, after which the command it describes is gone.
 */
export const SESSION_INPUT_DELIVERY_RETENTION_MS = 2 * 86_400_000;

/** The durable fact riding the session outbox alongside the promotion commit. */
export interface SessionInputPromotionAttachment {
  readonly sessionId: string;
  readonly id: string;
  readonly commandId: string;
  readonly conversationMessageId: string;
  readonly providerTurn: number;
}

interface SessionInputDeliveryRecord {
  readonly runId: string;
  readonly claimedAt: string;
  readonly promotion?: SessionInputPromotion;
}

function isPlainRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSessionInputPromotion(
  value: JSONValue | undefined,
): value is JSONValue & SessionInputPromotion {
  return (
    isPlainRecord(value) &&
    typeof value['promotedAt'] === 'string' &&
    typeof value['conversationMessageId'] === 'string' &&
    typeof value['providerTurn'] === 'number'
  );
}

function readDeliveryRecord(value: JSONValue | undefined): SessionInputDeliveryRecord | undefined {
  if (
    !isPlainRecord(value) ||
    typeof value['runId'] !== 'string' ||
    typeof value['claimedAt'] !== 'string'
  ) {
    return undefined;
  }
  const promotion = value['promotion'];
  return {
    runId: value['runId'],
    claimedAt: value['claimedAt'],
    ...(isSessionInputPromotion(promotion) ? { promotion } : {}),
  };
}

function deliveryRecordsOf(metadata: Record<string, JSONValue>): Record<string, JSONValue> {
  const records = metadata[SESSION_INPUT_DELIVERIES_METADATA_KEY];
  return isPlainRecord(records) ? records : {};
}

/**
 * Reads a command's {@link SessionInputPromotion} out of a session's own
 * metadata, or `undefined` when the command has never been promoted (or the
 * session predates this field, or the stored value is malformed: fails closed
 * toward "not promoted" rather than fabricating a promotion).
 *
 * Shared by `session-input-durability.ts` so a replayed or conflicting
 * admission's receipt reports the record's ACTUAL current state rather than
 * guessing `accepted`/`queued` for a command that has since promoted.
 */
export function readSessionInputPromotion(
  metadata: Record<string, JSONValue>,
  commandId: string,
): SessionInputPromotion | undefined {
  return readDeliveryRecord(deliveryRecordsOf(metadata)[commandId])?.promotion;
}

/** The records that are still within retention as of `nowMs`. */
function retainedRecords(
  records: Record<string, JSONValue>,
  nowMs: number,
): Record<string, JSONValue> {
  const retained: Record<string, JSONValue> = {};
  for (const [commandId, value] of Object.entries(records)) {
    const record = readDeliveryRecord(value);
    const writtenAt = Date.parse(record?.promotion?.promotedAt ?? record?.claimedAt ?? '');
    if (record === undefined || Number.isNaN(writtenAt)) continue;
    if (nowMs - writtenAt <= SESSION_INPUT_DELIVERY_RETENTION_MS) retained[commandId] = value;
  }
  return retained;
}

/**
 * Records `owner` as the run delivering each command in `commandIds`, in one
 * commit, and reports each command's outcome (see
 * `SessionInputDeliveryStore.claim`). Throws when the session no longer exists:
 * a run whose session was deleted has nothing left to deliver into.
 */
export async function claimSessionInputDeliveries(
  sessionStore: SessionStore,
  sessionId: string,
  owner: string,
  commandIds: readonly string[],
  nowISO: () => string,
): Promise<ReadonlyMap<string, SessionInputDeliveryClaim>> {
  let outcomes = new Map<string, SessionInputDeliveryClaim>();
  let sessionFound = false;
  await sessionStore.update(sessionId, (session) => {
    outcomes = new Map();
    sessionFound = session !== undefined;
    if (!session) return undefined;
    const now = nowISO();
    const existing = deliveryRecordsOf(session.metadata);
    const records: Record<string, JSONValue> = { ...existing };
    let changed = false;
    for (const commandId of commandIds) {
      const record = readDeliveryRecord(records[commandId]);
      if (record === undefined) {
        records[commandId] = { runId: owner, claimedAt: now } satisfies JSONValue;
        outcomes.set(commandId, 'claimed');
        changed = true;
      } else if (record.promotion !== undefined) {
        outcomes.set(commandId, 'promoted');
      } else {
        outcomes.set(commandId, record.runId === owner ? 'owned' : 'foreign');
      }
    }
    const kept = retainedRecords(records, Date.parse(now));
    if (Object.keys(kept).length !== Object.keys(records).length) changed = true;
    if (!changed) return undefined;
    return {
      ...session,
      metadata: { ...session.metadata, [SESSION_INPUT_DELIVERIES_METADATA_KEY]: kept },
    };
  });
  if (!sessionFound) {
    throw new Error(
      `Cannot claim session input delivery: session "${sessionId}" no longer exists.`,
    );
  }
  return outcomes;
}

/**
 * Commits each delivery's promotion, in one commit with one outbox attachment
 * per newly promoted command. Idempotent per command: a delivery already
 * promoted changes nothing and appends nothing. Throws when the session no
 * longer exists.
 */
export async function promoteSessionInputs(
  sessionStore: SessionStore,
  sessionId: string,
  owner: string,
  deliveries: readonly SessionInputDelivery[],
  nowISO: () => string,
): Promise<void> {
  // `SessionStore.update()` validates `options.outbox` once, before its retry
  // loop, so the attachments are fixed from a first read. A promotion that lands
  // in between leaves a harmless extra entry for the drain to retire; the
  // updater below still promotes each command at most once.
  const before = await sessionStore.load(sessionId);
  if (before === undefined) {
    throw new Error(`Cannot promote session input: session "${sessionId}" no longer exists.`);
  }
  const records = deliveryRecordsOf(before.metadata);
  const attachments: SessionInputPromotionAttachment[] = deliveries
    .filter((delivery) => readDeliveryRecord(records[delivery.commandId])?.promotion === undefined)
    .map((delivery) => ({
      sessionId,
      id: delivery.id,
      commandId: delivery.commandId,
      conversationMessageId: delivery.conversationMessageId,
      providerTurn: delivery.providerTurn,
    }));
  if (attachments.length === 0) return;

  let sessionFound = false;
  await sessionStore.update(
    sessionId,
    (session) => {
      sessionFound = session !== undefined;
      if (!session) return undefined;
      const now = nowISO();
      const current: Record<string, JSONValue> = { ...deliveryRecordsOf(session.metadata) };
      let changed = false;
      for (const delivery of deliveries) {
        const record = readDeliveryRecord(current[delivery.commandId]);
        if (record?.promotion !== undefined) continue;
        const promotion: SessionInputPromotion = {
          promotedAt: now,
          conversationMessageId: delivery.conversationMessageId,
          providerTurn: delivery.providerTurn,
        };
        current[delivery.commandId] = {
          runId: record?.runId ?? owner,
          claimedAt: record?.claimedAt ?? now,
          promotion: promotion as unknown as JSONValue,
        };
        changed = true;
      }
      if (!changed) return undefined;
      return {
        ...session,
        metadata: {
          ...session.metadata,
          [SESSION_INPUT_DELIVERIES_METADATA_KEY]: retainedRecords(current, Date.parse(now)),
        },
      };
    },
    {
      // The cast matches `create-bureau.ts`'s existing `reviewAuditOutboxAttachment`
      // (AB-391): `SessionOutboxEntry.payload` is `JSONValue`, and a
      // `readonly`-fielded interface has no index signature TypeScript can match
      // structurally; the value itself is plain, JSON-safe data. Ignored when the
      // updater returns `undefined` (every delivery was already promoted).
      outbox: attachments.map((attachment) => ({
        namespace: SESSION_INPUT_PROMOTION_OUTBOX_NAMESPACE,
        payload: attachment as unknown as JSONValue,
      })),
    },
  );
  if (!sessionFound) {
    throw new Error(`Cannot promote session input: session "${sessionId}" no longer exists.`);
  }
}
