/**
 * COR-1934 — a chat delete purges the chat's content from a persistent store and redacts the
 * answer text in its audit entries, over SQLite. Every case scans every key before and after.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  type GenerateFunction,
  createAgent,
  createAgentSession,
  stopWhen,
} from '@lostgradient/operative';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import type { AgentDefinitions } from './agent-catalog';
import { LATE_WRITE_GRACE_MILLISECONDS } from './chat-content-purge';
import { RunContentPurgedError } from './chat-content-tombstone';
import { createBureau } from './create-bureau';
import { createDurableEventHistory } from './durable-event-history';
import { type BureauStorageFixture, createSqliteStorageFixture } from './test/storage-fixtures';
import { startTaskFrom } from './test/task-start-request.ts';
import type { Bureau, BureauDiagnostic } from './types';

/** What the chat that is deleted is asked and answers; every other chat gets other text. */
const ANSWER = 'ANSWER-SENTINEL-4f1c';
const INPUT = 'INPUT-SENTINEL-77ab';
const OTHER_ANSWER = 'other-answer-9d02';
const OTHER_INPUT = 'other-input-c31e';
const PENDING_PREFIX = 'chat-content-purge-pending:v1:';
const REMOVED_SURFACES_PREFIX = 'bureau-removed-surfaces:v1:';

/**
 * The keys a deleted chat's run may still have: its audit entries (redacted), its task record
 * (status and cleanup, history cleared by COR-1481), and the engine's tags and tombstones, which
 * hold ids and counters and no text (`wf-gen:` and `wf-owner-epoch:` are permanently retained by
 * Weft).
 */
const RUN_KEYS_THAT_STAY = [
  'audit:v1:',
  'chat-content-purge-tombstone:v1:',
  'bureau-task:v1:',
  'bureau-task-context:v1:',
  'wf-gen:',
  'wf-owner-epoch:',
];

/** Every key of the store with its value read as text, binary included, so a sentinel is found anywhere. */
async function scan(fixture: BureauStorageFixture): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for await (const [key, value] of fixture.storage.scan('')) {
    entries.set(key, Buffer.from(value).toString('latin1'));
  }
  return entries;
}

/** The keys whose name or value holds `needle`. */
function holding(entries: Map<string, string>, needle: string): string[] {
  return [...entries]
    .filter(([key, value]) => key.includes(needle) || value.includes(needle))
    .map(([key]) => key);
}

/** The keys that belong to a chat or to one of its runs, for comparing a chat before and after. */
function entriesOf(
  entries: Map<string, string>,
  sessionId: string,
  runId: string,
): Map<string, string> {
  const run = new RegExp(`${runId}(?!\\d)`);
  return new Map(
    [...entries].filter(
      ([key]) =>
        run.test(key) ||
        key.includes(`:${sessionId}:`) ||
        key.endsWith(`:${sessionId}`) ||
        key.includes(`session%3A${sessionId}:`),
    ),
  );
}

interface Harness {
  /** What the Bureau reported to its diagnostic sink. */
  readonly diagnostics: BureauDiagnostic[];
  readonly bureau: Bureau;
  readonly fixture: BureauStorageFixture;
  /** Starts a chat and waits for its first run to settle; returns the run's id. */
  chat(contextId: string, input?: string): Promise<string>;
  /** Lets the late-write grace pass and runs a maintenance pass, which makes the second purge. */
  afterGrace(): Promise<void>;
}

async function withBureau(
  generate: GenerateFunction,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const runtime = createManualRuntimeServices({ origin: '2026-10-13T00:00:00.000Z' });
  const fixture = createSqliteStorageFixture({ runtime });
  const diagnostics: BureauDiagnostic[] = [];
  const bureau = await createBureau<AgentDefinitions>({
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    agents: { default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }) },
    runtime,
    storage: fixture.storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
  try {
    await body({
      diagnostics,
      bureau,
      fixture,
      async afterGrace() {
        runtime.setTime(runtime.clock.now() + LATE_WRITE_GRACE_MILLISECONDS);
        await bureau.maintain();
      },
      async chat(contextId, input = OTHER_INPUT) {
        const run = await startTaskFrom(bureau, {
          agentName: 'default',
          input,
          contextId,
          principal: 'alice',
        });
        await waitUntil(() => bureau.tasks.detail(run.id)?.status === 'completed', {
          message: `run ${run.id} of ${contextId} never completed`,
        });
        return run.id;
      },
    });
  } finally {
    await bureau.dispose();
    await fixture.dispose();
  }
}

/** The pending purge records in the store: a finished purge keeps its record until the second pass. */
async function pendingRecords(fixture: BureauStorageFixture): Promise<string[]> {
  const entries = await scan(fixture);
  return [...entries.keys()].filter((key) => key.startsWith(PENDING_PREFIX));
}

/** Whether `contexts.delete` removed the chat. */
async function deletedChat(bureau: Bureau, contextId: string): Promise<boolean> {
  const report = await bureau.contexts.delete(contextId);
  return report.deleted;
}

/** The messages of the error diagnostics a Bureau reported. */
function errorsOf(diagnostics: readonly BureauDiagnostic[]): string[] {
  return diagnostics.filter((entry) => entry.level === 'error').map((entry) => entry.message);
}

/** The first call, the chat that is deleted, answers `ANSWER`; every later one `OTHER_ANSWER`. */
function firstCallAnswers(): GenerateFunction {
  let calls = 0;
  return async () => {
    calls += 1;
    return { content: calls === 1 ? ANSWER : OTHER_ANSWER, toolCalls: [] };
  };
}

/** The audit entries of an owner, once the trail holds `count` of them. */
async function auditOf(bureau: Bureau, runId: string, count: number) {
  await waitUntil(
    async () => {
      const entries = await bureau.internals.auditTrail?.query({ runId });
      return entries?.length === count;
    },
    { message: `the audit trail never held ${count} entries for ${runId}` },
  );
  return (await bureau.internals.auditTrail?.query({ runId })) ?? [];
}

/**
 * Chats whose run ids are `…-run-1` and `…-run-10`: the first is deleted, and the tenth shares its
 * id prefix, so a purge by `idPrefix` alone would take it too.
 */
async function chatsWithPrefixNeighbour(harness: Harness) {
  const targetRunId = await harness.chat('chat-1', INPUT);
  for (let filler = 2; filler < 10; filler += 1) await harness.chat(`filler-${filler}`);
  const neighbourRunId = await harness.chat('chat-10');
  expect(neighbourRunId.startsWith(targetRunId)).toBe(true);
  return { targetRunId, neighbourRunId };
}

describe('contexts.delete purges the content of the chat (COR-1934)', () => {
  it('leaves nothing of a settled chat but redacted audit entries, and does not touch a second chat', async () => {
    await withBureau(firstCallAnswers(), async (harness) => {
      const { bureau, fixture } = harness;
      const { targetRunId, neighbourRunId } = await chatsWithPrefixNeighbour(harness);
      await bureau.maintain();
      const targetAuditBefore = await auditOf(bureau, targetRunId, 3);
      const neighbourAuditBefore = await auditOf(bureau, neighbourRunId, 3);
      // A marker a removed surface left, which only a surface removal writes.
      const surfaceMarker = `${REMOVED_SURFACES_PREFIX}${targetRunId}:generation-1`;
      await fixture.storage.put(surfaceMarker, new TextEncoder().encode('removed'));
      const before = await scan(fixture);
      // The content is where the issue says it is.
      expect(holding(before, ANSWER).filter((key) => key.startsWith('fleet-event:'))).not.toEqual(
        [],
      );
      expect(holding(before, ANSWER).filter((key) => key.startsWith('audit:v1:'))).not.toEqual([]);
      expect(
        [...before.keys()].filter((key) => key.startsWith('outbox-dedupe:session:chat-1:')),
      ).not.toEqual([]);
      const neighbourBefore = entriesOf(before, 'chat-10', neighbourRunId);
      expect(neighbourBefore.size).toBeGreaterThan(0);

      await bureau.contexts.delete('chat-1');
      await bureau.maintain();

      const after = await scan(fixture);
      expect(await bureau.contexts.get('chat-1')).toBeUndefined();
      // No answer or input text of the chat anywhere in the store, audit included.
      expect(holding(after, ANSWER)).toEqual([]);
      expect(holding(after, INPUT)).toEqual([]);
      // Of the chat's run only audit entries, the task record and engine ids and counters stay.
      const run = new RegExp(`${targetRunId}(?!\\d)`);
      const runKeys = [...after.keys()].filter((key) => run.test(key));
      expect(
        runKeys.filter((key) => !RUN_KEYS_THAT_STAY.some((prefix) => key.startsWith(prefix))),
      ).toEqual([]);
      expect(after.has(surfaceMarker)).toBe(false);
      // A finished purge keeps its record, settled, until the second pass; then it is gone.
      expect([...after.keys()].filter((key) => key.startsWith(PENDING_PREFIX))).toHaveLength(1);
      await harness.afterGrace();
      expect(await pendingRecords(harness.fixture)).toEqual([]);
      // Of the chat itself only the deletion marker, which holds no content.
      expect(
        [...after.keys()].filter((key) =>
          key.startsWith('fleet-event-by-workflow:session%3Achat-1:'),
        ),
      ).toHaveLength(1);
      expect(
        [...after.keys()].filter((key) => key.startsWith('outbox-dedupe:session:chat-1:')),
      ).toEqual([expect.stringContaining(':session.deleted:')]);

      // The audit entries stay, redacted in place: same kinds, ids, times and actor.
      const redacted = await auditOf(bureau, targetRunId, 3);
      expect(redacted).toHaveLength(targetAuditBefore.length);
      for (const [index, entry] of redacted.entries()) {
        const original = targetAuditBefore[index]!;
        expect({ ...entry, detail: undefined }).toEqual({ ...original, detail: undefined });
        if (entry.type === 'step.completed' || entry.type === 'run.completed') {
          expect(entry.detail).toMatchObject({ redacted: true });
          expect(JSON.stringify(entry.detail)).not.toContain(ANSWER);
        } else {
          expect(entry.detail).toEqual(original.detail);
        }
      }
      const deletion = await auditOf(bureau, 'session:chat-1', 1);
      expect(deletion[0]?.type).toBe('session.deleted');

      // The second chat, whose run id begins with the deleted one's, is untouched, byte for byte.
      expect(entriesOf(after, 'chat-10', neighbourRunId)).toEqual(neighbourBefore);
      expect(await auditOf(bureau, neighbourRunId, 3)).toEqual(neighbourAuditBefore);
      expect(await bureau.contexts.get('chat-10')).toBeDefined();
      expect(errorsOf(harness.diagnostics)).toEqual([]);
    });
  });

  it('purges a run by its exact id, so a neighbour whose id begins with it, created in the same millisecond, is untouched', async () => {
    await withBureau(firstCallAnswers(), async (harness) => {
      const { bureau } = harness;
      const { targetRunId, neighbourRunId } = await chatsWithPrefixNeighbour(harness);
      const engine = bureau.durableEngine()!;
      // A prefix purge could not tell the two apart when they were created in one millisecond;
      // the exact-id purge never reads a prefix, so the clock is held still to prove it.
      const target = await engine.get(targetRunId);
      const neighbour = await engine.get(neighbourRunId);
      expect(target?.createdAt).toBeDefined();
      expect(neighbour?.createdAt).toBeDefined();

      await bureau.contexts.delete('chat-1');
      await bureau.maintain();

      // Nothing of the neighbour went with it, and the target's workflow is gone.
      expect(await engine.get(neighbourRunId)).not.toBeNull();
      expect(await bureau.contexts.get('chat-10')).toBeDefined();
      expect(await bureau.tasks.detail(neighbourRunId)).toBeDefined();
      expect(await engine.get(targetRunId)).toBeNull();
      expect(errorsOf(harness.diagnostics)).toEqual([]);
    });
  });

  it('purges a chat with no run', async () => {
    await withBureau(firstCallAnswers(), async (harness) => {
      const { bureau, fixture, diagnostics } = harness;
      await bureau.internals.sessionStore!.save(
        createAgentSession({
          id: 'bare-chat',
          agentName: 'default',
          conversationHistory: createConversationHistory({ id: 'bare-chat' }),
          runs: [],
        }),
      );
      await bureau.maintain();
      const created = await scan(fixture);
      expect(
        [...created.keys()].filter((key) => key.startsWith('outbox-dedupe:session:bare-chat:')),
      ).not.toEqual([]);

      await bureau.contexts.delete('bare-chat');
      await bureau.maintain();

      const left = await scan(fixture);
      const after = [...left.keys()];
      expect(await bureau.contexts.get('bare-chat')).toBeUndefined();
      expect(after.filter((key) => key.startsWith('outbox-dedupe:session:bare-chat:'))).toEqual([
        expect.stringContaining(':session.deleted:'),
      ]);
      expect(
        after.filter((key) => key.startsWith('fleet-event-by-workflow:session%3Abare-chat:')),
      ).toHaveLength(1);
      expect(after.filter((key) => key.startsWith(PENDING_PREFIX))).toHaveLength(1);
      await harness.afterGrace();
      expect(await pendingRecords(fixture)).toEqual([]);
      expect(errorsOf(diagnostics)).toEqual([]);
    });
  });

  it('purges a chat whose run is in flight, once the delete has cancelled it and its last events are in', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const slow: GenerateFunction = async () => {
      calls += 1;
      if (calls === 1) return { content: OTHER_ANSWER, toolCalls: [] };
      await gate;
      return { content: ANSWER, toolCalls: [] };
    };
    await withBureau(slow, async (harness) => {
      const { bureau, fixture } = harness;
      const settledRunId = await harness.chat('settled-chat');
      const live = await startTaskFrom(bureau, {
        agentName: 'default',
        input: INPUT,
        contextId: 'live-chat',
        principal: 'alice',
      });
      await waitUntil(() => bureau.tasks.detail(live.id)?.status === 'running', {
        message: 'the run never started',
      });

      // The existing rule: the delete cancels the live run and awaits its terminal event, and the
      // content is purged after that, so the events that cancellation produced go too.
      const deleting = bureau.contexts.delete('live-chat');
      release();
      const report = await deleting;
      await bureau.maintain();

      expect(report.deleted).toBe(true);
      expect(report.tasks.map((task) => task.taskId)).toEqual([live.id]);
      const after = await scan(fixture);
      expect(await bureau.contexts.get('live-chat')).toBeUndefined();
      expect(holding(after, ANSWER)).toEqual([]);
      expect(holding(after, INPUT)).toEqual([]);
      const run = new RegExp(`${live.id}(?!\\d)`);
      expect(
        [...after.keys()].filter(
          (key) => run.test(key) && !RUN_KEYS_THAT_STAY.some((prefix) => key.startsWith(prefix)),
        ),
      ).toEqual([]);
      // A finished purge keeps its record, settled, until the second pass; then it is gone.
      expect([...after.keys()].filter((key) => key.startsWith(PENDING_PREFIX))).toHaveLength(1);
      await harness.afterGrace();
      expect(await pendingRecords(harness.fixture)).toEqual([]);
      expect(errorsOf(harness.diagnostics)).toEqual([]);
      // The other chat keeps its content.
      expect(holding(after, OTHER_ANSWER).length).toBeGreaterThan(0);
      expect(holding(after, settledRunId).some((key) => key.startsWith('fleet-event:'))).toBe(true);
    });
  });
});

describe('a late write of the process that drove a deleted chat’s run (COR-1934)', () => {
  const LATE = 'LATE-WRITE-SENTINEL-5b9d';

  it('is fenced by the run’s tombstone: the audit entry is written redacted, and the event is dropped', async () => {
    await withBureau(firstCallAnswers(), async (harness) => {
      const { bureau, fixture } = harness;
      const runId = await harness.chat('chat-1', INPUT);
      const otherRunId = await harness.chat('chat-2');
      await bureau.maintain();
      await bureau.contexts.delete('chat-1');
      await bureau.maintain();
      expect(holding(await scan(fixture), ANSWER)).toEqual([]);

      // The process that drove the run writes its last audit entry and event after the purge
      // removed the run's workflow: another process's owner, whose terminal workflow was the
      // purge's signal.
      const trail = bureau.internals.auditTrail!;
      await trail.record({
        runId,
        type: 'run.completed',
        detail: { result: { content: LATE }, content: LATE, finishReason: 'stop' },
      });
      await trail.record({
        runId,
        type: 'tool.settled',
        detail: { toolName: 'lookup', result: LATE },
        dedupeKey: `late:${runId}:tool`,
      });
      await trail.record({ runId: otherRunId, type: 'run.completed', detail: { content: LATE } });

      const after = await scan(fixture);
      // The deleted chat's late entries are there, redacted as they were written, and another
      // chat's entry is not touched.
      const late = await trail.query({ runId });
      // The run's own entries (redacted by the purge) and the two late ones (redacted as written).
      expect(late.filter((entry) => entry.type === 'run.completed')).toHaveLength(2);
      const lateEntries = late.filter(
        (entry) => entry.type === 'tool.settled' || entry.type === 'run.completed',
      );
      expect(lateEntries).toHaveLength(3);
      expect(lateEntries.map((entry) => entry.detail)).toEqual(
        lateEntries.map(() => expect.objectContaining({ redacted: true })),
      );
      expect(holding(after, LATE).filter((key) => key.includes(runId))).toEqual([]);
      expect(holding(after, LATE).filter((key) => key.includes(otherRunId))).not.toEqual([]);
      expect(errorsOf(harness.diagnostics)).toEqual([]);
    });
  });

  it('from a second process over the same store is fenced the same way, with no second pass', async () => {
    await withBureau(firstCallAnswers(), async (harness) => {
      const { bureau, fixture } = harness;
      const runId = await harness.chat('chat-1', INPUT);
      const otherRunId = await harness.chat('chat-2');
      await bureau.maintain();
      await bureau.contexts.delete('chat-1');
      await bureau.maintain();

      // Another process: its own Bureau and history over the same storage, which awaited nothing
      // of the purge.
      const runtime = createManualRuntimeServices({ origin: '2026-10-13T01:00:00.000Z' });
      const diagnostics: BureauDiagnostic[] = [];
      const other = await createBureau<AgentDefinitions>({
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        agents: {
          default: createAgent({ generate: firstCallAnswers(), stopWhen: stopWhen.noToolCalls() }),
        },
        runtime,
        storage: fixture.storage,
        durable: true,
        durableOwnership: { ownership: 'none' },
      });
      const history = createDurableEventHistory(fixture.storage, runtime);
      try {
        await other.internals.auditTrail!.record({
          runId,
          type: 'run.completed',
          detail: { result: { content: LATE }, content: LATE },
        });
        const dropped = await rejectionOf(
          history.record({ kind: 'run', id: runId }, 'run.completed', { content: LATE }),
        );
        expect(dropped).toBeInstanceOf(RunContentPurgedError);
        await history.record({ kind: 'run', id: otherRunId }, 'run.completed', { content: LATE });
      } finally {
        await history.dispose();
        await other.dispose();
      }

      const after = await scan(fixture);
      expect(holding(after, LATE).filter((key) => key.includes(runId))).toEqual([]);
      expect(
        [...after.keys()].filter((key) =>
          key.startsWith(`fleet-event-by-workflow:run%3A${runId}:`),
        ),
      ).toEqual([]);
      // The other run's late event landed, in clear.
      expect(
        [...after].filter(([, value]) => value.includes(LATE) && value.includes(otherRunId)),
      ).not.toEqual([]);
      expect(errorsOf(harness.diagnostics)).toEqual([]);
      expect(errorsOf(diagnostics)).toEqual([]);
      // The second pass still runs, for a run admitted after the delete began, and then the
      // record is dropped; the tombstone stays, for the audit retention to prune.
      await harness.afterGrace();
      expect(await pendingRecords(fixture)).toEqual([]);
      const settled = await scan(fixture);
      expect(
        [...settled.keys()].filter((key) => key.startsWith('chat-content-purge-tombstone:v1:')),
      ).toHaveLength(1);
    });
  });
});

describe('a chat delete that fails after the chat is gone (COR-1934)', () => {
  it('leaves the chat unlisted and the purge owed, and finishes it on the next maintenance pass', async () => {
    await withBureau(firstCallAnswers(), async (harness) => {
      const { bureau, fixture } = harness;
      const runId = await harness.chat('chat-1', INPUT);
      await harness.chat('chat-2');
      await bureau.maintain();
      const trail = bureau.internals.auditTrail!;
      const redact = trail.redact.bind(trail);
      let failing = true;
      trail.redact = async (runIds) => {
        if (failing) throw new Error('injected: audit store down');
        return redact(runIds);
      };

      // The purge fails after the event history has been purged, and the delete itself stands.
      expect(await deletedChat(bureau, 'chat-1')).toBe(true);

      expect(errorsOf(harness.diagnostics).join('\n')).toContain('injected: audit store down');
      let during = await scan(fixture);
      expect(await bureau.contexts.get('chat-1')).toBeUndefined();
      expect(
        [...during.keys()].filter((key) =>
          key.startsWith(`fleet-event-by-workflow:run%3A${runId}:`),
        ),
      ).toEqual([]);
      expect([...during.keys()].filter((key) => key.startsWith(PENDING_PREFIX))).toHaveLength(1);
      expect(holding(during, ANSWER).filter((key) => key.startsWith('audit:v1:'))).not.toEqual([]);

      // Deleting it again finds nothing: only the pending record can finish the purge.
      expect(await deletedChat(bureau, 'chat-1')).toBe(false);

      failing = false;
      harness.diagnostics.length = 0;
      await bureau.maintain();
      expect(errorsOf(harness.diagnostics)).toEqual([]);
      during = await scan(fixture);
      // A finished purge keeps its record, settled, until the second pass; then it is gone.
      expect([...during.keys()].filter((key) => key.startsWith(PENDING_PREFIX))).toHaveLength(1);
      await harness.afterGrace();
      expect(await pendingRecords(harness.fixture)).toEqual([]);
      expect(holding(during, ANSWER)).toEqual([]);
      expect(await bureau.contexts.get('chat-2')).toBeDefined();
    });
  });

  it('retries an event purge that failed partway, and the second chat stays whole', async () => {
    await withBureau(firstCallAnswers(), async (harness) => {
      const { bureau, fixture } = harness;
      await harness.chat('chat-1', INPUT);
      const otherRunId = await harness.chat('chat-2');
      await bureau.maintain();
      const otherBefore = entriesOf(await scan(fixture), 'chat-2', otherRunId);
      const storage = fixture.storage;
      const batch = storage.batch.bind(storage);
      let failing = true;
      storage.batch = async (operations) => {
        if (failing && operations.some((operation) => operation.key.startsWith('fleet-event'))) {
          throw new Error('injected: event store down');
        }
        return batch(operations);
      };

      await bureau.contexts.delete('chat-1');
      expect(errorsOf(harness.diagnostics).join('\n')).toContain('injected: event store down');
      expect(await bureau.contexts.get('chat-1')).toBeUndefined();
      const stuck = await scan(fixture);
      expect([...stuck.keys()].filter((key) => key.startsWith(PENDING_PREFIX))).toHaveLength(1);
      expect(holding(stuck, ANSWER).filter((key) => key.startsWith('fleet-event:'))).not.toEqual(
        [],
      );

      failing = false;
      harness.diagnostics.length = 0;
      await bureau.maintain();
      expect(errorsOf(harness.diagnostics)).toEqual([]);

      const after = await scan(fixture);
      // A finished purge keeps its record, settled, until the second pass; then it is gone.
      expect([...after.keys()].filter((key) => key.startsWith(PENDING_PREFIX))).toHaveLength(1);
      await harness.afterGrace();
      expect(await pendingRecords(harness.fixture)).toEqual([]);
      expect(holding(after, ANSWER)).toEqual([]);
      expect(entriesOf(after, 'chat-2', otherRunId)).toEqual(otherBefore);
    });
  });

  it('refuses the delete, and removes nothing, when the purge cannot be recorded first', async () => {
    await withBureau(firstCallAnswers(), async (harness) => {
      const { bureau, fixture } = harness;
      await harness.chat('chat-1', INPUT);
      await bureau.maintain();
      const kv = bureau.internals.kv!;
      const set = kv.set.bind(kv);
      kv.set = async (key: string, value: string) => {
        if (key.startsWith(PENDING_PREFIX)) throw new Error('injected: pending store down');
        return set(key, value);
      };
      const before = await scan(fixture);

      expect(String(await rejectionOf(bureau.contexts.delete('chat-1')))).toContain('injected');

      expect(await bureau.contexts.get('chat-1')).toBeDefined();
      expect(holding(await scan(fixture), ANSWER)).toEqual(holding(before, ANSWER));
      kv.set = set;
      expect(await deletedChat(bureau, 'chat-1')).toBe(true);
      await bureau.maintain();
      expect(holding(await scan(fixture), ANSWER)).toEqual([]);
    });
  });

  it('stays owed when the engine declines to purge a run’s workflow, and finishes once it does', async () => {
    await withBureau(firstCallAnswers(), async (harness) => {
      const { bureau, fixture } = harness;
      const runId = await harness.chat('chat-1', INPUT);
      await bureau.maintain();
      // A finalizer still owed: the engine refuses to purge the workflow, and answers `false`.
      const owed = `wf-teardown-needed:${encodeURIComponent(runId)}`;
      await bureau.internals.kv!.set(owed, '1');

      expect(await deletedChat(bureau, 'chat-1')).toBe(true);

      expect(errorsOf(harness.diagnostics).join('\n')).toContain(
        `The durable workflow of run "${runId}" was not purged`,
      );
      const stuck = await scan(fixture);
      expect(stuck.has(`wf:${runId}`)).toBe(true);
      const [pending] = await pendingRecords(fixture);
      // Not settled: the pass failed, so the first pass is still owed.
      expect(JSON.parse(stuck.get(pending!)!)).not.toHaveProperty('settledAt');

      await bureau.internals.kv!.delete(owed);
      harness.diagnostics.length = 0;
      await bureau.maintain();
      expect(errorsOf(harness.diagnostics)).toEqual([]);
      const after = await scan(fixture);
      expect(after.has(`wf:${runId}`)).toBe(false);
      expect(holding(after, ANSWER)).toEqual([]);
      await harness.afterGrace();
      expect(await pendingRecords(fixture)).toEqual([]);
    });
  });

  it('does not purge a chat whose delete did not commit', async () => {
    await withBureau(firstCallAnswers(), async (harness) => {
      const { bureau, fixture } = harness;
      await harness.chat('chat-1', INPUT);
      await bureau.maintain();
      const store = bureau.internals.sessionStore!;
      const remove = store.delete.bind(store);
      store.delete = async () => {
        throw new Error('injected: session store down');
      };

      expect(String(await rejectionOf(bureau.contexts.delete('chat-1')))).toContain('injected');
      await bureau.maintain();
      store.delete = remove;

      expect(await bureau.contexts.get('chat-1')).toBeDefined();
      expect(
        holding(await scan(fixture), ANSWER).filter((key) => key.startsWith('fleet-event:')),
      ).not.toEqual([]);
      // The next delete that commits finishes the purge, with nothing left owed.
      await bureau.contexts.delete('chat-1');
      await bureau.maintain();
      const after = await scan(fixture);
      expect(holding(after, ANSWER)).toEqual([]);
      // A finished purge keeps its record, settled, until the second pass; then it is gone.
      expect([...after.keys()].filter((key) => key.startsWith(PENDING_PREFIX))).toHaveLength(1);
      await harness.afterGrace();
      expect(await pendingRecords(harness.fixture)).toEqual([]);
    });
  });
});
