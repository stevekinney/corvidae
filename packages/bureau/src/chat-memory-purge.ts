/**
 * COR-1934 — what a chat delete removes from governed memory.
 *
 * A run that ends remembers its final answer (`createMemoryPersistHook`): an `episodic` record
 * under the agent's collection, tagged with the run (`runId`) and the chat (`metadata.sessionId`).
 * That record is the chat's words, kept for as long as memory's own retention keeps it, so a
 * chat's delete forgets it (owner decision: a chat delete deletes the chat's memories).
 *
 * The chat is gone by the time this runs, so it cannot say whose memory to read. Each run's task
 * record (kept past the delete, with its text dropped) names the agent that ran it and the owner
 * of record, which are the collection and the partition the record was written under. The records
 * are then forgotten as a source deletion, as `bureau.memory.forget` does, so every derived copy
 * goes with them. A record under a legal hold is kept, as the hold requires; the deletion resumes
 * when the hold is released.
 *
 * A record is the chat's when it was written by one of the chat's runs. A record with no run (one
 * written before records named it) is the chat's when its `metadata.sessionId` is the chat's.
 * Matching on the session id alone would take a chat recreated under the same id, whose records
 * are its own.
 */
import {
  createMemoryAuthority,
  type GovernedMemory,
  type GovernedMemoryRecord,
  type MemoryAuthority,
} from '@lostgradient/memory';

/** Where a run's memory was written: the agent it ran as and the owner of record. */
export interface RunMemoryPlacement {
  readonly agentName: string;
  readonly owner: string;
}

/** What the purge of a chat's memories needs. */
export interface ChatMemoryPurgeDependencies {
  readonly memory: GovernedMemory;
  /** The Bureau's identifier, which is the tenant memory is partitioned under. */
  readonly tenantId: string;
  /** Where a run's memory was written, or `undefined` when the run left no record to say. */
  readonly placementOf: (runId: string) => Promise<RunMemoryPlacement | undefined>;
}

/** The revision recorded on what the purge deletes, as `bureau.memory.*` records its own. */
const PURGE_POLICY_REVISION = 'bureau:chat-delete';

/** A page of the owner's collection; the listing is read whole before anything is deleted. */
const PAGE_SIZE = 500;

/**
 * The authority the purge acts under: the owner's own, holding only what it needs. `memory:inspect`
 * is in it so the listing also shows a record that was superseded or quarantined, and names the
 * run that wrote each, which a plain listing leaves out.
 */
function authorityFor(tenantId: string, owner: string): MemoryAuthority {
  return createMemoryAuthority({
    principal: { kind: 'user', id: owner },
    tenantId,
    ownerId: owner,
    purpose: 'bureau.chat-delete',
    capabilities: ['memory:list', 'memory:delete', 'memory:inspect'],
    policyRevision: PURGE_POLICY_REVISION,
    projection: 'bureau',
  });
}

function belongsToChat(
  record: GovernedMemoryRecord,
  sessionId: string,
  runIds: ReadonlySet<string>,
): boolean {
  const runId = record.governance?.runId;
  if (runId !== undefined) return runIds.has(runId);
  return record.metadata['sessionId'] === sessionId;
}

async function listWhole(
  memory: GovernedMemory,
  authority: MemoryAuthority,
  collection: string,
): Promise<GovernedMemoryRecord[]> {
  const records: GovernedMemoryRecord[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await memory.list(authority, {
      collection,
      visibility: 'all',
      limit: PAGE_SIZE,
      offset,
    });
    records.push(...page);
    if (page.length < PAGE_SIZE) return records;
  }
}

/**
 * Forgets the memories the chat's runs wrote. Rejects with the first record it could not forget,
 * after trying the rest, so the pass that called it stays owed.
 */
export async function purgeChatMemories(
  dependencies: ChatMemoryPurgeDependencies,
  chat: { readonly sessionId: string; readonly runIds: ReadonlySet<string> },
): Promise<void> {
  const { memory, tenantId } = dependencies;
  const places = new Map<string, { owner: string; agentName: string }>();
  for (const runId of chat.runIds) {
    const placement = await dependencies.placementOf(runId);
    if (placement !== undefined) {
      places.set(`${placement.owner}\u0000${placement.agentName}`, placement);
    }
  }
  const failures: unknown[] = [];
  for (const { owner, agentName } of places.values()) {
    const authority = authorityFor(tenantId, owner);
    for (const record of await listWhole(memory, authority, agentName)) {
      if (!belongsToChat(record, chat.sessionId, chat.runIds)) continue;
      try {
        const result = await memory.forget(authority, {
          mode: 'source-deletion',
          locator: { id: record.id, collection: agentName, visibility: record.visibility },
        });
        // `not-found`: another pass got there first. `rejected`: a record derived from others,
        // which goes with its sources. `exempt`: a legal hold keeps it. Only a deletion that
        // was refused or whose removing step failed leaves a record the next pass must retry.
        if (result.status === 'denied' || result.deletion === 'failed') {
          failures.push(
            new Error(
              `memory "${record.id}" could not be forgotten: ${result.deletion ?? result.status}`,
            ),
          );
        }
      } catch (error: unknown) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} memories of the chat could not be forgotten`,
    );
  }
}
