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
 * - each run's interactive surfaces (their summary and data);
 * - the chat's session input: the command records of its mailbox keep each payload inline until
 *   terminal retention, eight days on, so the mailbox is purged outright, with its open-input
 *   marker;
 * - the chat's A2A history (`bureau-a2a-task:v1:`), cleared here as well as by the A2A mount's
 *   `session.deleted` listener, which runs only where a mount does and swallows its failure;
 * - its reviews' records: the resolved-review records, the decision records and the secret
 *   answers (see `chat-review-purge.ts`);
 * - the memories its runs wrote, which `chat-memory-purge.ts` forgets;
 * - the managed assets it held that nothing else holds (`chat-asset-purge.ts`);
 * - the audit trail's entries of its runs, which hold the answer word for word, the arguments and
 *   results of every tool call, and what each review asked and was told. Those are kept, as proof
 *   that the runs happened, with their content redacted (see `redactAuditDetail`).
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
 * ## The late writers, and the second pass
 *
 * A run is purged once its workflow is terminal, but the process that drove it may still be writing
 * its last events: the `run.completed` event and audit entry follow the terminal workflow
 * asynchronously, and in another process nothing here awaits them. A write that landed after the
 * purge would bring the answer back. So a pass writes a tombstone for every ended run BEFORE it
 * deletes anything (`chat-content-tombstone.ts`), and every write of a run's content carries the
 * tombstone's absence as a precondition: a late audit entry is written with its content redacted,
 * and a late event is dropped. The session's own events come only through the session outbox,
 * which the purge waits for (`hasUndrainedEvents`), so the session owner needs no tombstone.
 *
 * What the fence cannot cover is a run the pass does not know about: one admitted to the chat by
 * another process between `chatRunIdsOf` and the delete's commit, or a child dispatched by a run
 * that had not ended. So every pass reads the chat's task records and the delegation topology
 * again, and a finished purge does not drop its pending record: it marks it settled, and the sweep
 * runs the whole purge a second time once {@link LATE_WRITE_GRACE_MILLISECONDS} have passed, and
 * only then drops the record. The second pass is for those admissions, which race the delete
 * itself; it is bounded in time and is not the guarantee against a late writer, which the fence is.
 *
 * One run's failure never stops the rest of the chat's purge: each run's steps are tried on their
 * own, the failures are collected, and the pass fails at the end with all of them, so the pending
 * record stays and the next pass retries only what is left.
 *
 * A pending record whose chat still exists under the same incarnation belongs to a delete that
 * has not committed (or never will); the sweep leaves it alone, and the delete that does commit
 * finishes it. A chat recreated under the same id has another incarnation: the purge removes only
 * what the deleted incarnation recorded, and never the new chat's events.
 */
import { encodeStorageKeyComponent } from '@lostgradient/storage';
import type { ConditionalTextValueStore } from '@lostgradient/storage';

import { createA2ATaskRecords } from './http/a2a-task-record';
import type { AuditTrail } from './audit-trail';
import {
  CHAT_CONTENT_TOMBSTONE_PREFIX,
  parseTombstone,
  runTombstoneKey,
  tombstoneValue,
} from './chat-content-tombstone';
import type { DurableEventHistory, DurableEventProducer } from './durable-event-history';
import { deletionMarkerKindFor } from './durable-event-history';
import type { ChatAsset } from './chat-asset-purge';
import { serializeUnknownError } from './serialization';
import type { DiagnosticSink } from './types';

/** The reserved key prefix of the records of purges that are owed. */
const PENDING_PREFIX = 'chat-content-purge-pending:v1:';

/** The prefix of the markers an interactive surface's removal leaves, one per run. */
const REMOVED_SURFACES_PREFIX = 'bureau-removed-surfaces:v1:';

/**
 * How long a finished purge waits before it runs a second time, to take a run admitted to the
 * chat, or a child dispatched, after the first pass read the chat's runs (see the module
 * comment). Far longer than a delete's commit window, and short enough that the record is gone
 * the same day. A late write of a run the pass knew about is fenced by its tombstone, not by this.
 */
export const LATE_WRITE_GRACE_MILLISECONDS = 10 * 60_000;

/** What a chat's purge needs to know, fixed before the chat is deleted. */
export interface DeletedChat {
  readonly sessionId: string;
  readonly incarnation: string;
  /** Every run of the chat: those this process holds, those it attributed, and its task records. */
  readonly runIds: readonly string[];
  /**
   * Epoch milliseconds a purge of the chat finished, set once it has; the second pass, for a run
   * admitted after the first began, runs {@link LATE_WRITE_GRACE_MILLISECONDS} after it. Absent
   * while the first pass is owed.
   */
  readonly settledAt?: number | undefined;
  /**
   * The managed assets the chat held, named before it was deleted because its rows and claims are
   * gone by the time the purge runs. Absent in a record written before they were named.
   */
  readonly assets?: readonly ChatAsset[] | undefined;
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
  /**
   * The runs delegated to, directly or through other children, by the given runs, not counting
   * those. A chat's children hold its words (their input and their outcome), so they go with it;
   * read on every pass, so a child dispatched after the delete began is found. `undefined`
   * without a durable Bureau.
   */
  readonly descendantsOf: ((runIds: readonly string[]) => Promise<string[]>) | undefined;
  /**
   * Removes what a run keeps outside its workflow and events: its catalog recovery record (which
   * holds the run's `input`), its child record (which holds its outcome) and its peer call
   * records. Called last, deepest child first, so a pass that fails partway can still find the
   * children it has left. `undefined` without a durable Bureau.
   */
  readonly purgeRunRecords: ((runId: string) => Promise<void>) | undefined;
  /**
   * Removes the records of the reviews of ended runs, other than their audit entries: resolved
   * reviews, decision records and secret answers (`chat-review-purge.ts`).
   */
  readonly purgeReviews: ((runIds: ReadonlySet<string>) => Promise<void>) | undefined;
  /**
   * Forgets the memories the chat's runs wrote (`chat-memory-purge.ts`); `undefined` without
   * governed memory.
   */
  readonly purgeMemories:
    ((sessionId: string, runIds: ReadonlySet<string>) => Promise<void>) | undefined;
  /**
   * Deletes the managed assets the chat held that nothing else holds (`chat-asset-purge.ts`);
   * `undefined` without an asset service.
   */
  readonly purgeAssets: ((assets: readonly ChatAsset[]) => Promise<void>) | undefined;
  /** Removes an ended run's interactive surfaces; `undefined` without a surface store. */
  readonly purgeSurfaces: ((runId: string) => Promise<void>) | undefined;
  /**
   * Removes the session input of a deleted incarnation that no run will read again: its mailbox,
   * payloads included, and its open-input marker; `undefined` without a durable mailbox.
   */
  readonly purgeSessionInput:
    ((sessionId: string, incarnation: string) => Promise<void>) | undefined;
  /**
   * The task ids recorded for the chat's incarnation, read on every pass so a run admitted after
   * the delete began is found by the next pass. `undefined` without a task registry.
   */
  readonly taskIdsOf:
    ((sessionId: string, incarnation: string) => Promise<readonly string[]>) | undefined;
  /**
   * Removes the command-ledger entries of commands on the runs: the receipts of A2A sends,
   * `tasks.respond` commands and run creations, whose claims and results keep what the command
   * carried. `undefined` without a KV store.
   */
  readonly purgeLedgers: ((runIds: ReadonlySet<string>) => Promise<void>) | undefined;
  /**
   * Drops the text of the runs' task settlements (a failure message, a catalog task's answer);
   * the records themselves stay. `undefined` without a task registry.
   */
  readonly redactTaskRecords: ((runIds: ReadonlySet<string>) => Promise<void>) | undefined;
  /** Whether the chat has events still waiting in the session outbox to be recorded. */
  readonly hasUndrainedEvents: (sessionId: string, incarnation: string) => Promise<boolean>;
  /** The incarnation the session id holds now, or `undefined` when it holds none. */
  readonly currentIncarnation: (sessionId: string) => Promise<string | undefined>;
  /** Epoch milliseconds, from the Bureau's clock. */
  readonly now: () => number;
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
   * Removes the pending record of a delete that did not commit, when the chat still exists under
   * the incarnation; a chat that is gone keeps its record, because a delete that committed
   * (this one's, or another process's that won the race) owes its purge. Never rejects: a record
   * left behind is harmless (see the module comment).
   */
  forget(chat: Pick<DeletedChat, 'sessionId' | 'incarnation'>): Promise<void>;
  /**
   * Purges the chat's content, then removes its pending record. Rejects with the first failure,
   * leaving the record for {@link sweep}. Calls for the same chat share one pass.
   */
  run(chat: DeletedChat): Promise<void>;
  /** Finishes every owed purge whose chat is gone. Never rejects: a failure is diagnosed. */
  sweep(): Promise<number>;
  /**
   * Drops the tombstones of runs purged before `cutoffMs`, and resolves how many went. Called
   * with the audit trail's retention cutoff, because an entry or event older than it is pruned
   * anyway (see `chat-content-tombstone.ts`).
   */
  pruneTombstones(cutoffMs: number): Promise<number>;
}

function pendingKey(sessionId: string, incarnation: string): string {
  return `${PENDING_PREFIX}${encodeStorageKeyComponent(sessionId)}:${encodeStorageKeyComponent(incarnation)}`;
}

function pendingValue(chat: DeletedChat): string {
  return JSON.stringify({
    sessionId: chat.sessionId,
    incarnation: chat.incarnation,
    runIds: [...new Set(chat.runIds)],
    ...(chat.settledAt === undefined ? {} : { settledAt: chat.settledAt }),
    ...(chat.assets === undefined ? {} : { assets: chat.assets }),
  });
}

function parseAssets(value: unknown): ChatAsset[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const assets: ChatAsset[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { assetId, ownerId } = entry as Record<string, unknown>;
    if (typeof assetId !== 'string' || typeof ownerId !== 'string') return undefined;
    assets.push({ assetId, ownerId });
  }
  return assets;
}

function parsePending(text: string): DeletedChat | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const { sessionId, incarnation, runIds, settledAt, assets } = value as Record<string, unknown>;
    const parsedAssets = parseAssets(assets);
    if (
      typeof sessionId !== 'string' ||
      typeof incarnation !== 'string' ||
      !Array.isArray(runIds) ||
      !runIds.every((runId) => typeof runId === 'string')
    ) {
      return undefined;
    }
    return {
      sessionId,
      incarnation,
      runIds,
      ...(typeof settledAt === 'number' && Number.isFinite(settledAt) ? { settledAt } : {}),
      ...(parsedAssets === undefined ? {} : { assets: parsedAssets }),
    };
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

/**
 * A pass that could not finish every step: the failures, one per step, with the run each is
 * about. The pending record stays, and the next pass retries what is left.
 */
export class ChatPurgeIncompleteError extends Error {
  constructor(
    readonly sessionId: string,
    readonly failures: readonly { readonly runId: string | undefined; readonly error: unknown }[],
    /** Every run the pass found, children included, so the pending record can name them. */
    readonly covered: readonly string[],
  ) {
    super(
      `The content purge of deleted chat "${sessionId}" could not finish ${failures.length} of its steps: ${failures
        .map(
          ({ runId, error }) =>
            `${runId === undefined ? 'the chat' : `run "${runId}"`}: ${serializeUnknownError(error)}`,
        )
        .join('; ')}`,
    );
    this.name = 'ChatPurgeIncompleteError';
  }
}

/** Builds the {@link ChatContentPurge} over the Bureau's stores. */
export function createChatContentPurge(
  dependencies: ChatContentPurgeDependencies,
): ChatContentPurge {
  const { kv, diagnose } = dependencies;
  const inFlight = new Map<string, Promise<void>>();

  /** Writes the run's tombstone, unless one is there already: the first purge's time stands. */
  async function writeTombstone(runId: string): Promise<void> {
    if (kv === undefined) return;
    const key = runTombstoneKey(runId);
    await kv.conditionalBatch(
      [{ key, expectedValue: null }],
      [{ type: 'set', key, value: tombstoneValue({ runId, purgedAt: dependencies.now() }) }],
    );
  }

  /** Purges the chat's content; resolves every run it covered, those it delegated to included. */
  async function purgeContent(chat: DeletedChat): Promise<string[]> {
    // Events still in the session outbox are recorded by a later drain; purging now would leave
    // them to be written afterwards. The pending record stays and the sweep comes back.
    if (await dependencies.hasUndrainedEvents(chat.sessionId, chat.incarnation)) {
      throw new Error(
        `The session outbox of deleted chat "${chat.sessionId}" is not drained yet; its content is purged once it is`,
      );
    }
    const history = dependencies.history();
    const producer = dependencies.producer();
    const failures: { runId: string | undefined; error: unknown }[] = [];
    /** Runs one step of the purge; a failure is kept for the end and stops nothing else. */
    const step = async (runId: string | undefined, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error: unknown) {
        failures.push({ runId, error });
      }
    };
    const runIds = new Set<string>();
    const unended: string[] = [];
    // The chat's runs, read again on every pass: the record's, the task records' (a run admitted
    // after the delete began), and the runs they delegated to, the deepest last.
    const owned = [...new Set(chat.runIds)];
    for (const taskId of (await dependencies.taskIdsOf?.(chat.sessionId, chat.incarnation)) ?? []) {
      if (!owned.includes(taskId)) owned.push(taskId);
    }
    for (const descendant of (await dependencies.descendantsOf?.(owned)) ?? []) {
      if (!owned.includes(descendant)) owned.push(descendant);
    }
    for (const runId of owned) {
      if ((await dependencies.runEnded?.(runId)) === false) unended.push(runId);
      else runIds.add(runId);
    }
    // The fence first, before anything of a run goes: from here its late writers are refused.
    for (const runId of runIds) await writeTombstone(runId);
    for (const runId of runIds) {
      await step(runId, async () => {
        if (history !== undefined) {
          await producer?.waitForActiveWrites({ kind: 'run', id: runId });
          await history.purgeOwner({ kind: 'run', id: runId });
        }
      });
      await step(runId, async () => {
        // The surfaces first: their removal writes the marker the next line deletes.
        await dependencies.purgeSurfaces?.(runId);
        await kv?.deletePrefix(`${REMOVED_SURFACES_PREFIX}${encodeStorageKeyComponent(runId)}:`);
      });
    }
    await step(undefined, async () => {
      if (history === undefined) return;
      const owner = { kind: 'session', id: chat.sessionId } as const;
      await producer?.waitForActiveWrites(owner);
      // The `session.deleted` record stays: it is how the history of a deleted chat is told from
      // one that never existed, and it holds no content.
      const kept = deletionMarkerKindFor('session');
      await history.purgeOwner(owner, {
        incarnation: chat.incarnation,
        keepKinds: new Set(kept === undefined ? [] : [kept]),
      });
    });
    // After the events, so a failure here still leaves a purge owed. A workflow is removed last of
    // the run's records: nothing above reads it.
    for (const runId of runIds)
      await step(runId, () => dependencies.purgeRun?.(runId) ?? Promise.resolve());
    await step(undefined, async () => dependencies.audit()?.redact(runIds));
    await step(undefined, async () => dependencies.purgeReviews?.(runIds));
    await step(undefined, async () => dependencies.purgeMemories?.(chat.sessionId, runIds));
    await step(undefined, async () => dependencies.purgeLedgers?.(runIds));
    await step(undefined, async () => dependencies.redactTaskRecords?.(runIds));

    // What belongs to the chat as a whole is left while one of its runs is still live: that run
    // reads the chat's input and writes its A2A history until it ends.
    if (unended.length === 0) {
      // Last, and the deepest child first: these records are how a retry finds the children, so
      // none goes while a run below it could still be waiting, and a run whose own steps failed
      // keeps them, so the pass that retries it finds it again.
      const failed = new Set(failures.map((failure) => failure.runId));
      for (const runId of [...runIds].toReversed()) {
        if (failed.has(runId)) continue;
        await step(runId, () => dependencies.purgeRunRecords?.(runId) ?? Promise.resolve());
      }
      await step(undefined, async () => {
        if (kv !== undefined) {
          await createA2ATaskRecords(kv).clearContext(chat.sessionId, chat.incarnation);
        }
      });
      await step(undefined, async () =>
        dependencies.purgeSessionInput?.(chat.sessionId, chat.incarnation),
      );
      await step(undefined, async () => dependencies.purgeAssets?.(chat.assets ?? []));
    }
    if (failures.length > 0) throw new ChatPurgeIncompleteError(chat.sessionId, failures, owned);
    // Owed, not lost: the runs that have not ended keep their content, and the pending record
    // stays, until the pass that finds them ended.
    if (unended.length > 0) throw new ChatRunsNotEndedError(chat.sessionId, unended);
    return owned;
  }

  function run(chat: DeletedChat): Promise<void> {
    const key = pendingKey(chat.sessionId, chat.incarnation);
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;
    const pass = (async () => {
      let covered: string[];
      try {
        covered = await purgeContent(chat);
      } catch (error: unknown) {
        // A pass that found runs the record does not name (a child dispatched after the delete
        // began) writes them into the record before it fails, so the next pass starts from them
        // whether or not the records that led to them are still there.
        if (error instanceof ChatPurgeIncompleteError && kv !== undefined) {
          const named = new Set(chat.runIds);
          if (error.covered.some((runId) => !named.has(runId))) {
            await kv.set(key, pendingValue({ ...chat, runIds: error.covered }));
          }
        }
        throw error;
      }
      if (chat.settledAt === undefined) {
        // Settled, not dropped: the record is what brings the second pass. It names every run the
        // first covered, children included, because the first removes the records that led to them.
        await kv?.set(
          key,
          pendingValue({ ...chat, runIds: covered, settledAt: dependencies.now() }),
        );
      } else {
        // The second pass is the last: a record that is gone has nothing more to bring.
        await kv?.delete(key);
      }
    })().finally(() => {
      if (inFlight.get(key) === pass) inFlight.delete(key);
    });
    inFlight.set(key, pass);
    return pass;
  }

  return {
    async record(chat) {
      if (kv === undefined) return;
      try {
        await kv.set(pendingKey(chat.sessionId, chat.incarnation), pendingValue(chat));
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
        // Another process may have committed the delete this call lost, or this call's own may have
        // committed before it failed: the record is that delete's to finish. Only a chat that still
        // exists under the incarnation proves nobody's delete committed.
        if ((await dependencies.currentIncarnation(chat.sessionId)) !== chat.incarnation) return;
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
          // A purge that finished waits out the grace before its second pass.
          if (
            chat.settledAt !== undefined &&
            dependencies.now() - chat.settledAt < LATE_WRITE_GRACE_MILLISECONDS
          ) {
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

    async pruneTombstones(cutoffMs) {
      if (kv === undefined) return 0;
      let pruned = 0;
      for (const key of await kv.list(CHAT_CONTENT_TOMBSTONE_PREFIX)) {
        const text = await kv.get(key);
        if (text === null) continue;
        const tombstone = parseTombstone(text);
        // One this module cannot read is left: it fences nothing it should not.
        if (tombstone === undefined || tombstone.purgedAt >= cutoffMs) continue;
        if (await kv.conditionalBatch([{ key, expectedValue: text }], [{ type: 'delete', key }])) {
          pruned += 1;
        }
      }
      return pruned;
    },
  };
}
