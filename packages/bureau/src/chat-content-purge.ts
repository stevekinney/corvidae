/**
 * COR-1934 — what a chat delete removes from durable storage besides the chat itself.
 *
 * `contexts.delete` removes the session and cancels its work. The conversation's content also
 * sits in places the session store does not own, and until this module only retention removed it:
 *
 * - the durable event history: the `fleet-event:` records and their `fleet-event-by-workflow:`
 *   index entries for each of the chat's runs (`run:<id>`) and for the chat (`session:<id>`),
 *   whose `run.completed` events hold the agent's whole answer, and their `outbox-dedupe:`
 *   markers;
 * - the `bureau-removed-surfaces:v1:<runId>:` markers a run's removed surfaces left;
 * - each run's durable workflow and checkpoints, which hold the answer step by step;
 * - the audit trail's `step.completed` and `run.completed` entries, which hold the answer word
 *   for word. Those are kept, as proof that the runs happened, with their answer text redacted
 *   (see `redactAuditDetail`).
 *
 * ## Order, and what a failure leaves
 *
 * The purge runs AFTER the session store's delete has committed, so a chat is never listed while
 * its content is gone. A purge that fails partway therefore cannot be retried by deleting the chat
 * again, which no longer exists: a pending record is written BEFORE the store delete
 * (`record`), and removed only when the whole purge has finished (`run`). `sweep` runs every
 * pending purge whose chat is gone, at boot and in every maintenance pass, so a purge that
 * failed, or a process that died after the commit, is finished by the next one. Every step is
 * idempotent: it lists what is left each time.
 *
 * A pending record whose chat still exists under the same incarnation belongs to a delete that
 * has not committed (or never will); the sweep leaves it alone, and the delete that does commit
 * finishes it. A chat recreated under the same id has another incarnation: the purge removes only
 * what the deleted incarnation recorded, and never the new chat's events.
 */
import { encodeStorageKeyComponent } from '@lostgradient/storage';
import type { ConditionalTextValueStore } from '@lostgradient/storage';

import type { AuditTrail } from './audit-trail';
import type { DurableEventHistory, DurableEventProducer } from './durable-event-history';
import { deletionMarkerKindFor } from './durable-event-history';
import { serializeUnknownError } from './serialization';
import type { DiagnosticSink } from './types';

/** The reserved key prefix of the records of purges that are owed. */
const PENDING_PREFIX = 'chat-content-purge-pending:v1:';

/** The prefix of the markers an interactive surface's removal leaves, one per run. */
const REMOVED_SURFACES_PREFIX = 'bureau-removed-surfaces:v1:';

/** What a chat's purge needs to know, fixed before the chat is deleted. */
export interface DeletedChat {
  readonly sessionId: string;
  readonly incarnation: string;
  /** Every run of the chat: those this process holds, those it attributed, and its task records. */
  readonly runIds: readonly string[];
}

/** What {@link createChatContentPurge} reaches out to. */
export interface ChatContentPurgeDependencies {
  readonly kv: ConditionalTextValueStore | undefined;
  /** The durable event history; `undefined` when the Bureau keeps none. */
  readonly history: () => DurableEventHistory | undefined;
  /** The producer whose in-flight appends are awaited before an owner's events go. */
  readonly producer: () => DurableEventProducer | undefined;
  readonly audit: () => AuditTrail | undefined;
  /**
   * Whether a run has ended: it has no durable workflow, or its workflow is terminal. A run that
   * has not (another process still drives it, or it is being recovered) keeps its content, which
   * its own writers are still adding to, until it has. `undefined` without a durable engine.
   */
  readonly runEnded: ((runId: string) => Promise<boolean>) | undefined;
  /** Removes an ended run's durable workflow and checkpoints; `undefined` without a durable engine. */
  readonly purgeRun: ((runId: string) => Promise<void>) | undefined;
  /** Whether the chat has events still waiting in the session outbox to be recorded. */
  readonly hasUndrainedEvents: (sessionId: string, incarnation: string) => Promise<boolean>;
  /** The incarnation the session id holds now, or `undefined` when it holds none. */
  readonly currentIncarnation: (sessionId: string) => Promise<string | undefined>;
  readonly diagnose: DiagnosticSink;
}

/** The purge of deleted chats' content. */
export interface ChatContentPurge {
  /**
   * Writes the pending record, BEFORE the chat is deleted. Rejects when it cannot be written, so
   * the chat is not deleted without a way to finish its purge.
   */
  record(chat: DeletedChat): Promise<void>;
  /**
   * Removes the pending record of a delete that did not commit. Never rejects: a record left
   * behind is harmless (see the module comment).
   */
  forget(chat: Pick<DeletedChat, 'sessionId' | 'incarnation'>): Promise<void>;
  /**
   * Purges the chat's content, then removes its pending record. Rejects with the first failure,
   * leaving the record for {@link sweep}. Calls for the same chat share one pass.
   */
  run(chat: DeletedChat): Promise<void>;
  /** Finishes every owed purge whose chat is gone. Never rejects: a failure is diagnosed. */
  sweep(): Promise<number>;
}

function pendingKey(sessionId: string, incarnation: string): string {
  return `${PENDING_PREFIX}${encodeStorageKeyComponent(sessionId)}:${encodeStorageKeyComponent(incarnation)}`;
}

function parsePending(text: string): DeletedChat | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const { sessionId, incarnation, runIds } = value as Record<string, unknown>;
    if (
      typeof sessionId !== 'string' ||
      typeof incarnation !== 'string' ||
      !Array.isArray(runIds) ||
      !runIds.every((runId) => typeof runId === 'string')
    ) {
      return undefined;
    }
    return { sessionId, incarnation, runIds };
  } catch {
    return undefined;
  }
}

/**
 * A purge that finished everything it could while some runs of the chat had not ended. It is not
 * a failure to repair: the next pass purges those runs once they have.
 */
export class ChatRunsNotEndedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly runIds: readonly string[],
  ) {
    super(
      `Chat "${sessionId}" was deleted, but ${runIds.length} of its runs have not ended (${runIds.join(', ')}); their content is purged once they do`,
    );
    this.name = 'ChatRunsNotEndedError';
  }
}

/** Builds the {@link ChatContentPurge} over the Bureau's stores. */
export function createChatContentPurge(
  dependencies: ChatContentPurgeDependencies,
): ChatContentPurge {
  const { kv, diagnose } = dependencies;
  const inFlight = new Map<string, Promise<void>>();

  async function purgeContent(chat: DeletedChat): Promise<void> {
    // Events still in the session outbox are recorded by a later drain; purging now would leave
    // them to be written afterwards. The pending record stays and the sweep comes back.
    if (await dependencies.hasUndrainedEvents(chat.sessionId, chat.incarnation)) {
      throw new Error(
        `The session outbox of deleted chat "${chat.sessionId}" is not drained yet; its content is purged once it is`,
      );
    }
    const history = dependencies.history();
    const producer = dependencies.producer();
    const runIds = new Set<string>();
    const unended: string[] = [];
    for (const runId of chat.runIds) {
      if ((await dependencies.runEnded?.(runId)) === false) unended.push(runId);
      else runIds.add(runId);
    }
    for (const runId of runIds) {
      if (history !== undefined) {
        await producer?.waitForActiveWrites({ kind: 'run', id: runId });
        await history.purgeOwner({ kind: 'run', id: runId });
      }
      await kv?.deletePrefix(`${REMOVED_SURFACES_PREFIX}${encodeStorageKeyComponent(runId)}:`);
    }
    if (history !== undefined) {
      const owner = { kind: 'session', id: chat.sessionId } as const;
      await producer?.waitForActiveWrites(owner);
      // The `session.deleted` record stays: it is how the history of a deleted chat is told from
      // one that never existed, and it holds no content.
      const kept = deletionMarkerKindFor('session');
      await history.purgeOwner(owner, {
        incarnation: chat.incarnation,
        keepKinds: new Set(kept === undefined ? [] : [kept]),
      });
    }
    // After the events, so a failure here still leaves a purge owed. A workflow is removed last of
    // the run's records: nothing above reads it.
    for (const runId of runIds) await dependencies.purgeRun?.(runId);
    await dependencies.audit()?.redact(runIds);
    // Owed, not lost: the runs that have not ended keep their content, and the pending record
    // stays, until the pass that finds them ended.
    if (unended.length > 0) throw new ChatRunsNotEndedError(chat.sessionId, unended);
  }

  function run(chat: DeletedChat): Promise<void> {
    const key = pendingKey(chat.sessionId, chat.incarnation);
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;
    const pass = (async () => {
      await purgeContent(chat);
      await kv?.delete(key);
    })().finally(() => {
      if (inFlight.get(key) === pass) inFlight.delete(key);
    });
    inFlight.set(key, pass);
    return pass;
  }

  return {
    async record(chat) {
      if (kv === undefined) return;
      const value = JSON.stringify({
        sessionId: chat.sessionId,
        incarnation: chat.incarnation,
        runIds: [...new Set(chat.runIds)],
      });
      try {
        await kv.set(pendingKey(chat.sessionId, chat.incarnation), value);
      } catch (error: unknown) {
        // Nothing is deleted without a way to finish the purge: the chat is left for the caller to
        // delete again.
        throw new Error(
          `Could not record the content purge of chat "${chat.sessionId}" before deleting it; the chat was not deleted: ${serializeUnknownError(error)}`,
          { cause: error },
        );
      }
    },

    async forget(chat) {
      try {
        await kv?.delete(pendingKey(chat.sessionId, chat.incarnation));
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Could not remove the pending content purge of chat "${chat.sessionId}": ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
    },

    run,

    async sweep() {
      if (kv === undefined) return 0;
      let finished = 0;
      let keys: string[];
      try {
        keys = await kv.list(PENDING_PREFIX);
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Could not list the pending content purges of deleted chats: ${serializeUnknownError(error)}`,
          cause: error,
        });
        return 0;
      }
      for (const key of keys) {
        try {
          const text = await kv.get(key);
          if (text === null) continue;
          const chat = parsePending(text);
          if (chat === undefined) {
            diagnose({
              level: 'error',
              scope: 'durable-maintenance',
              message: `[bureau] A pending content purge of a deleted chat is unreadable and was left in place: ${key}`,
            });
            continue;
          }
          // The same incarnation still exists: its delete has not committed, so there is
          // nothing to purge yet.
          if ((await dependencies.currentIncarnation(chat.sessionId)) === chat.incarnation) {
            continue;
          }
          await run(chat);
          finished += 1;
        } catch (error: unknown) {
          diagnose({
            level: error instanceof ChatRunsNotEndedError ? 'warn' : 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Could not finish a pending content purge of a deleted chat; a later pass retries it: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
      }
      return finished;
    },
  };
}
