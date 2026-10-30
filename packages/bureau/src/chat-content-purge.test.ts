/**
 * COR-1934 — the pending record, the sweep and the guards of a deleted chat's content purge, over
 * stubs, so each cell of the lifecycle is a case: a run that has not ended, events still in the
 * session outbox, a chat that still exists, and a chat recreated under the same id.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import type { AuditTrail } from './audit-trail';
import {
  ChatPurgeIncompleteError,
  ChatRunsNotEndedError,
  createChatContentPurge,
  LATE_WRITE_GRACE_MILLISECONDS,
} from './chat-content-purge';
import { CHAT_CONTENT_TOMBSTONE_PREFIX, runTombstoneKey } from './chat-content-tombstone';
import { A2A_TASK_RECORD_KEY_PREFIX, createA2ATaskRecords } from './http/a2a-task-record';
import type { DurableEventHistory, DurableEventProducer } from './durable-event-history';
import type { BureauDiagnostic } from './types';

const PENDING_PREFIX = 'chat-content-purge-pending:v1:';

interface Calls {
  readonly events: string[];
  readonly redacted: string[][];
  readonly workflows: string[];
  readonly surfaces: string[];
  readonly reviews: string[][];
  readonly sessionInput: string[];
  readonly records: string[];
  readonly ledgers: string[][];
  readonly settlements: string[][];
}

function setup(
  options: {
    ended?: (runId: string) => boolean;
    descendants?: () => Record<string, string[]>;
    taskIds?: () => string[];
    purgeRun?: (runId: string) => Promise<void>;
    undrained?: () => boolean;
    incarnation?: () => string | undefined;
  } = {},
) {
  const kv = textValueStore(new MemoryStorage());
  const calls: Calls = {
    events: [],
    redacted: [],
    workflows: [],
    surfaces: [],
    reviews: [],
    sessionInput: [],
    records: [],
    ledgers: [],
    settlements: [],
  };
  const clock = { now: 1_000 };
  const diagnostics: BureauDiagnostic[] = [];
  const history = {
    async purgeOwner(
      owner: { kind: string; id: string },
      purgeOptions?: { incarnation?: string | undefined; keepKinds?: ReadonlySet<string> },
    ) {
      calls.events.push(
        `${owner.kind}:${owner.id}${purgeOptions?.incarnation === undefined ? '' : `@${purgeOptions.incarnation}`}${purgeOptions?.keepKinds?.has('session.deleted') === true ? '+keep' : ''}`,
      );
      return 0;
    },
  } as unknown as DurableEventHistory;
  const producer = {
    async waitForActiveWrites() {},
  } as unknown as DurableEventProducer;
  const audit = {
    async redact(runIds: ReadonlySet<string>) {
      calls.redacted.push([...runIds]);
      return runIds.size;
    },
  } as unknown as AuditTrail;
  const purge = createChatContentPurge({
    kv,
    history: () => history,
    producer: () => producer,
    audit: () => audit,
    runEnded: async (runId) => options.ended?.(runId) ?? true,
    purgeRun: async (runId) => {
      await options.purgeRun?.(runId);
      calls.workflows.push(runId);
    },
    taskIdsOf: async () => options.taskIds?.() ?? [],
    purgeLedgers: async (runIds) => {
      calls.ledgers.push([...runIds]);
    },
    redactTaskRecords: async (runIds) => {
      calls.settlements.push([...runIds]);
    },
    descendantsOf: async (parents) =>
      parents.flatMap((parent) => options.descendants?.()[parent] ?? []),
    purgeRunRecords: async (runId) => {
      calls.records.push(runId);
    },
    purgeSurfaces: async (runId) => {
      calls.surfaces.push(runId);
    },
    purgeReviews: async (runIds) => {
      calls.reviews.push([...runIds]);
    },
    purgeSessionInput: async (sessionId, incarnation) => {
      calls.sessionInput.push(`${sessionId}@${incarnation}`);
    },
    now: () => clock.now,
    hasUndrainedEvents: async () => options.undrained?.() ?? false,
    currentIncarnation: async () =>
      options.incarnation === undefined ? undefined : options.incarnation(),
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { kv, calls, diagnostics, purge, clock };
}

const CHAT = { sessionId: 'chat-1', incarnation: 'one', runIds: ['run-1', 'run-2', 'run-1'] };

describe('createChatContentPurge (COR-1934)', () => {
  it('purges each run once and the chat of its incarnation, keeping its deletion marker, then settles the record', async () => {
    const { kv, calls, purge } = setup();
    await purge.record(CHAT);
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);

    await purge.run(CHAT);

    expect(calls.events).toEqual(['run:run-1', 'run:run-2', 'session:chat-1@one+keep']);
    expect(calls.workflows).toEqual(['run-1', 'run-2']);
    expect(calls.surfaces).toEqual(['run-1', 'run-2']);
    expect(calls.redacted).toEqual([['run-1', 'run-2']]);
    expect(calls.reviews).toEqual([['run-1', 'run-2']]);
    expect(calls.sessionInput).toEqual(['chat-1@one']);
    // The record stays, settled, for the second pass.
    const [key] = await kv.list(PENDING_PREFIX);
    expect(JSON.parse((await kv.get(key!))!)).toMatchObject({ settledAt: 1_000 });
  });

  it('runs the whole purge a second time once the grace has passed, and then drops the record', async () => {
    const { kv, calls, purge, clock } = setup({ incarnation: () => undefined });
    await purge.record(CHAT);
    await purge.run(CHAT);
    expect(calls.workflows).toHaveLength(2);

    // Before the grace the sweep leaves a settled record alone.
    clock.now += LATE_WRITE_GRACE_MILLISECONDS - 1;
    expect(await purge.sweep()).toBe(0);
    expect(calls.workflows).toHaveLength(2);
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);

    clock.now += 1;
    expect(await purge.sweep()).toBe(1);
    expect(calls.workflows).toEqual(['run-1', 'run-2', 'run-1', 'run-2']);
    expect(calls.redacted).toEqual([
      ['run-1', 'run-2'],
      ['run-1', 'run-2'],
    ]);
    expect(calls.sessionInput).toEqual(['chat-1@one', 'chat-1@one']);
    expect(await kv.list(PENDING_PREFIX)).toEqual([]);
    expect(await purge.sweep()).toBe(0);
  });

  it('purges the runs the chat delegated to with it, and removes their records last, the deepest first', async () => {
    const { calls, purge } = setup({ descendants: () => ({ 'run-1': ['child-1'], 'run-2': [] }) });
    await purge.record(CHAT);

    await purge.run(CHAT);

    expect(calls.events).toEqual([
      'run:run-1',
      'run:run-2',
      'run:child-1',
      'session:chat-1@one+keep',
    ]);
    expect(calls.workflows).toEqual(['run-1', 'run-2', 'child-1']);
    expect(calls.redacted).toEqual([['run-1', 'run-2', 'child-1']]);
    expect(calls.records).toEqual(['child-1', 'run-2', 'run-1']);
  });

  it('covers a child in the second pass although the first removed the records that led to it', async () => {
    let linked = true;
    const { calls, purge, clock } = setup({
      descendants: () => (linked ? { 'run-1': ['child-1'] } : {}),
      incarnation: () => undefined,
    });
    await purge.record(CHAT);
    await purge.run(CHAT);
    expect(calls.workflows).toEqual(['run-1', 'run-2', 'child-1']);

    // The first pass removed the child's record, so the topology no longer names it.
    linked = false;
    clock.now += LATE_WRITE_GRACE_MILLISECONDS;
    expect(await purge.sweep()).toBe(1);

    expect(calls.workflows.slice(3)).toEqual(['run-1', 'run-2', 'child-1']);
    expect(calls.redacted.at(-1)).toEqual(['run-1', 'run-2', 'child-1']);
  });

  it('keeps every record while a child has not ended, so a retry still finds it', async () => {
    const { calls, purge } = setup({
      descendants: () => ({ 'run-1': ['child-1'] }),
      ended: (runId) => runId !== 'child-1',
      incarnation: () => undefined,
    });
    await purge.record(CHAT);

    expect(await purge.run(CHAT).catch((reason: unknown) => reason)).toBeInstanceOf(
      ChatRunsNotEndedError,
    );

    // No run's records go while a run below it could still be waiting: they are how a retry finds it.
    expect(calls.records).toEqual([]);
    expect(calls.workflows).not.toContain('child-1');
  });

  it('clears the chat’s A2A history itself, for the incarnation that was deleted only', async () => {
    const { kv, purge } = setup();
    const records = createA2ATaskRecords(kv);
    const message = [{ messageId: 'm-1', parts: [{ text: 'A2A words' }] }];
    for (const [taskId, incarnation] of [
      ['task-old', 'one'],
      ['task-new', 'two'],
    ] as const) {
      await records.create({
        recordVersion: 1,
        taskId,
        contextId: 'chat-1',
        incarnation,
        history: message,
        replyRecorded: false,
      });
    }
    await purge.record(CHAT);

    await purge.run(CHAT);

    const cleared = await records.read('task-old');
    const kept = await records.read('task-new');
    expect(cleared?.history).toEqual([]);
    expect(kept?.history).toEqual(message);
    expect(await kv.list(A2A_TASK_RECORD_KEY_PREFIX)).toHaveLength(2);
  });

  it('purges the runs that have ended, keeps the record, and finishes once the rest have', async () => {
    let ended = false;
    const { kv, calls, diagnostics, purge } = setup({
      ended: (runId) => runId !== 'run-2' || ended,
      incarnation: () => undefined,
    });
    await purge.record(CHAT);

    const error = await purge.run(CHAT).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatRunsNotEndedError);
    expect(calls.events).toEqual(['run:run-1', 'session:chat-1@one+keep']);
    expect(calls.workflows).toEqual(['run-1']);
    expect(calls.redacted).toEqual([['run-1']]);
    // What belongs to the chat as a whole waits for its last run: a live run still reads its input.
    expect(calls.sessionInput).toEqual([]);
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);

    // The sweep reports it as a warning, not an error, and comes back.
    expect(await purge.sweep()).toBe(0);
    expect(diagnostics.map((entry) => entry.level)).toEqual(['warn']);
    ended = true;
    expect(await purge.sweep()).toBe(1);
    // Each pass purges what has ended again, which is idempotent; the last also takes run-2.
    expect(calls.workflows).toEqual(['run-1', 'run-1', 'run-1', 'run-2']);
    expect(calls.sessionInput).toEqual(['chat-1@one']);
    // Settled now: the second pass is owed.
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);
  });

  it('purges nothing while events of the chat are still in the session outbox', async () => {
    let undrained = true;
    const { kv, calls, purge } = setup({
      undrained: () => undrained,
      incarnation: () => undefined,
    });
    await purge.record(CHAT);

    expect(await purge.sweep()).toBe(0);
    expect(calls.events).toEqual([]);
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);

    undrained = false;
    expect(await purge.sweep()).toBe(1);
    expect(calls.events).toHaveLength(3);
  });

  it('leaves the record of a chat that still exists under its incarnation, and purges it when another holds the id', async () => {
    let incarnation: string | undefined = 'one';
    const { kv, calls, purge } = setup({ incarnation: () => incarnation });
    await purge.record(CHAT);

    // Its delete has not committed: nothing is purged and the record stays for the delete that does.
    expect(await purge.sweep()).toBe(0);
    expect(calls.events).toEqual([]);
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);

    // The id was deleted and used again: the old incarnation's content goes, the new one's stays.
    incarnation = 'two';
    expect(await purge.sweep()).toBe(1);
    expect(calls.events).toEqual(['run:run-1', 'run:run-2', 'session:chat-1@one+keep']);
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);
  });

  it('shares one pass between concurrent calls for the same chat', async () => {
    const { calls, purge } = setup();
    await purge.record(CHAT);

    await Promise.all([purge.run(CHAT), purge.run(CHAT)]);

    expect(calls.workflows).toEqual(['run-1', 'run-2']);
  });

  it('refuses to record when the store cannot, and forgets the record of a chat that still exists', async () => {
    const { kv, purge } = setup({ incarnation: () => 'one' });
    const set = kv.set.bind(kv);
    kv.set = async () => {
      throw new Error('injected');
    };
    const refusal = await purge.record(CHAT).catch((reason: unknown) => reason);
    expect(String(refusal)).toContain('the chat was not deleted');
    kv.set = set;

    await purge.record(CHAT);
    await purge.forget(CHAT);
    expect(await kv.list(PENDING_PREFIX)).toEqual([]);
  });

  it('keeps the record when the chat is gone, because a delete that committed owes its purge', async () => {
    // A delete that lost the race to another process, or one that failed after it committed.
    const { kv, purge } = setup({ incarnation: () => undefined });
    await purge.record(CHAT);

    await purge.forget(CHAT);
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);

    // The id is used again by another incarnation: still the old delete's record.
    const recreated = setup({ incarnation: () => 'two' });
    await recreated.purge.record(CHAT);
    await recreated.purge.forget(CHAT);
    expect(await recreated.kv.list(PENDING_PREFIX)).toHaveLength(1);
  });

  it('leaves an unreadable record in place and reports it', async () => {
    const { kv, diagnostics, purge } = setup();
    await kv.set(`${PENDING_PREFIX}garbage`, '{not json');

    expect(await purge.sweep()).toBe(0);

    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);
    expect(diagnostics.map((entry) => entry.level)).toEqual(['error']);
  });
});

describe('the fence and the failure isolation of a pass (COR-1934)', () => {
  it('writes every ended run’s tombstone before anything goes, and finishes the other runs when one fails', async () => {
    const seen: string[] = [];
    const { kv, calls, purge } = setup({
      purgeRun: async (runId) => {
        seen.push(...(await kv.list(CHAT_CONTENT_TOMBSTONE_PREFIX)));
        if (runId === 'run-1') throw new Error('injected: engine down');
      },
    });
    await purge.record(CHAT);

    const failure = await purge.run(CHAT).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChatPurgeIncompleteError);
    expect((failure as ChatPurgeIncompleteError).failures.map((entry) => entry.runId)).toEqual([
      'run-1',
    ]);
    // Both tombstones were in place before the first workflow was touched.
    expect(new Set(seen)).toEqual(new Set([runTombstoneKey('run-1'), runTombstoneKey('run-2')]));
    // The failure stopped nothing else: the other run's workflow, the audit redaction and the
    // ledgers were all done, and the record stays unsettled for the next pass.
    expect(calls.workflows).toEqual(['run-2']);
    expect(calls.redacted).toEqual([['run-1', 'run-2']]);
    expect(calls.ledgers).toEqual([['run-1', 'run-2']]);
    expect(calls.settlements).toEqual([['run-1', 'run-2']]);
    const [key] = await kv.list(PENDING_PREFIX);
    expect(JSON.parse((await kv.get(key!))!)).not.toHaveProperty('settledAt');
  });

  it('reads the chat’s task records on every pass, so a run admitted after the delete began is purged too', async () => {
    const admitted: string[] = [];
    const { calls, purge, kv } = setup({ taskIds: () => admitted });
    await purge.record(CHAT);
    await purge.run(CHAT);
    expect(calls.workflows).toEqual(['run-1', 'run-2']);

    // Another process admitted a run to the chat while the delete was committing.
    admitted.push('run-3');
    const [key] = await kv.list(PENDING_PREFIX);
    const settled = JSON.parse((await kv.get(key!))!) as { settledAt: number };
    await purge.run({ ...CHAT, settledAt: settled.settledAt });

    expect(calls.workflows).toEqual(['run-1', 'run-2', 'run-1', 'run-2', 'run-3']);
    expect(await kv.get(runTombstoneKey('run-3'))).not.toBeNull();
  });

  it('keeps a tombstone’s first purge time, and prunes tombstones older than the cutoff', async () => {
    const { kv, purge, clock } = setup();
    await purge.record(CHAT);
    await purge.run(CHAT);
    const first = JSON.parse((await kv.get(runTombstoneKey('run-1')))!) as { purgedAt: number };
    expect(first.purgedAt).toBe(1_000);
    clock.now = 5_000;
    await purge.run({ ...CHAT, settledAt: 1_000 });
    expect(JSON.parse((await kv.get(runTombstoneKey('run-1')))!)).toEqual({
      runId: 'run-1',
      purgedAt: 1_000,
    });

    expect(await purge.pruneTombstones(1_000)).toBe(0);
    expect(await purge.pruneTombstones(1_001)).toBe(2);
    expect(await kv.list(CHAT_CONTENT_TOMBSTONE_PREFIX)).toEqual([]);
  });

  it('keeps the records that lead to a run whose own step failed, and names a child it found in the pending record before failing', async () => {
    const { kv, calls, purge } = setup({
      descendants: () => ({ 'run-2': ['child-1'] }),
      purgeRun: async (runId) => {
        if (runId === 'child-1') throw new Error('injected: engine down');
      },
    });
    await purge.record(CHAT);

    const failure = await purge.run(CHAT).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChatPurgeIncompleteError);
    // The child's own records stay, so the pass that retries it can find it; the others go.
    expect(calls.records).toEqual(['run-2', 'run-1']);
    // And the record now names the child, whether or not those records survive.
    const [key] = await kv.list(PENDING_PREFIX);
    expect(JSON.parse((await kv.get(key!))!)).toEqual({
      sessionId: 'chat-1',
      incarnation: 'one',
      runIds: ['run-1', 'run-2', 'child-1'],
    });
  });
});
