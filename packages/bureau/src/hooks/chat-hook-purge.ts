/**
 * COR-1953 — the hook deliveries of a deleted chat.
 *
 * A hook delivery is a record of one event delivered to one hook: for a webhook the exact request
 * body (`{ id, hookId, kind, bureauId, emittedAtMs, test, payload }`), for a `start-workflow` hook
 * the input the workflow starts with (the payload, or the same envelope). The payload is an event's
 * projection, which `bureau-event-catalog.ts` holds to identifiers, statuses and counts, so the
 * record holds none of what the chat said. It does name the chat's runs, and while it is pending it
 * still sends them: a deleted chat's delivery is removed, which cancels one still to be sent.
 *
 * A delivery is a chat's when its payload names one of the chat's runs in any string field
 * (`runId`, `goalRunId`, `taskId`, `blockingRunId`, ...), or names the deleted incarnation of the
 * chat (`sessionId` with `incarnation`, the fields of the session events). A context id alone is
 * not enough, because a recreated chat reuses it; with the incarnation it is exact. A `notify`
 * delivery holds a title and a body that name the event kind, the hook and the Bureau, and never a
 * payload, so it names no chat and stays.
 *
 * Removal is conditional on the text read (`HookStore.deleteDelivery`): a delivery a driver has
 * advanced meanwhile is read again and judged again, and the driver's own next write, compared
 * against the record it read, fails once the record is gone, so it stops.
 *
 * @module chat-hook-purge
 */

import type { HookStore } from './hook-store.ts';
import type { HookDeliveryRecord } from './hook-types.ts';

/** What identifies a deleted chat to a delivery. */
export interface DeletedChatReference {
  readonly sessionId: string;
  readonly incarnation: string;
}

/** How many times a delivery that changed under the removal is read and judged again. */
const REMOVAL_ATTEMPTS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The event payloads a delivery holds: the payload itself and, for the envelope shape, its `payload`. */
function payloadsOf(record: HookDeliveryRecord): Record<string, unknown>[] {
  let candidates: unknown[] = [];
  if (record.request !== undefined) {
    try {
      const body: unknown = JSON.parse(record.request.body);
      candidates = isRecord(body) ? [body['payload']] : [];
    } catch {
      candidates = [];
    }
  } else if (record.work?.type === 'start-workflow') {
    const { input } = record.work;
    candidates = isRecord(input) ? [input, input['payload']] : [];
  }
  return candidates.filter(isRecord);
}

function namesChat(
  payload: Record<string, unknown>,
  chat: DeletedChatReference,
  runIds: ReadonlySet<string>,
): boolean {
  if (payload['sessionId'] === chat.sessionId && payload['incarnation'] === chat.incarnation) {
    return true;
  }
  return Object.values(payload).some((value) =>
    Array.isArray(value)
      ? value.some((element) => typeof element === 'string' && runIds.has(element))
      : typeof value === 'string' && runIds.has(value),
  );
}

/** Whether `record` is a delivery of an event about the chat. */
export function isDeliveryOfChat(
  record: HookDeliveryRecord,
  chat: DeletedChatReference,
  runIds: ReadonlySet<string>,
): boolean {
  return payloadsOf(record).some((payload) => namesChat(payload, chat, runIds));
}

/**
 * Removes the chat's deliveries, pending ones included, with their pending index keys, and
 * resolves how many went. Idempotent: it lists what is left.
 */
export async function purgeChatHookDeliveries(
  store: Pick<HookStore, 'listStoredDeliveries' | 'getDelivery' | 'deleteDelivery'>,
  chat: DeletedChatReference,
  runIds: ReadonlySet<string>,
): Promise<number> {
  let removed = 0;
  for (const listed of await store.listStoredDeliveries()) {
    let current = listed;
    for (let attempt = 0; attempt < REMOVAL_ATTEMPTS; attempt += 1) {
      if (!isDeliveryOfChat(current.record, chat, runIds)) break;
      if (await store.deleteDelivery(current)) {
        removed += 1;
        break;
      }
      // A driver advanced the delivery (or another pass took it): judge what is there now.
      const latest = await store.getDelivery(current.record.id);
      if (latest === undefined) break;
      current = latest;
    }
  }
  return removed;
}
