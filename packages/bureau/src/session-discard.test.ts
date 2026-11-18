/**
 * COR-2437 — discarding a context's last unfinished turn: the rows a stopped or failed run wrote
 * after the person's message are removed in one fenced commit, with a receipt and an audit entry;
 * every refusal leaves the history as it was, and a duplicate removes nothing more.
 */
import {
  conversationThroughRun,
  createAgent,
  createAgentSession,
  type AgentSession,
  type GenerateContext,
  type RunRef,
} from '@lostgradient/operative';
import { createTool } from 'armorer';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
  type Message,
} from 'conversationalist';
import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import {
  BureauShuttingDownError,
  ContextArchivedError,
  ContextHistoryChangedError,
} from './bureau-errors';
import { createBureau } from './create-bureau';
import { digestCommandPayload } from './command-ledger';
import {
  createDiscardLedger,
  DISCARD_AUDIT_TYPE,
  DISCARD_OPERATION_VERSION,
  DISCARD_RECEIPT_OUTBOX_NAMESPACE,
  DISCARDED_ROW_IDS_LIMIT,
  DISCARDED_ROWS_METADATA_KEY,
  discardedRowIdsOf,
  discardReceiptAnswersClaim,
  discardReceiptPayload,
  judgeDiscardableTurn,
  parseDiscardReceipt,
  removeSessionTurn,
  SessionDiscardRefusedError,
} from './session-discard';
import { waitForCondition, waitForTaskState } from './test';
import type { Bureau } from './bureau-types/facade';
import { startTaskFrom } from './test/task-start-request.ts';
import { createVendorCatalog } from './testing/vendor-catalog.test-support';
import { TASK_OWNER_LOST_FINISH_REASON } from './task-registry';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const ALICE = 'alice';
const CRAFTED = 'crafted';

/** One row of a crafted history. */
type Row = { readonly id: string; readonly role: Message['role']; readonly metadata?: object };

function historyOf(rows: readonly Row[], id = CRAFTED): ConversationHistory {
  const conversation = new Conversation(createConversationHistory({ id }));
  for (const row of rows) {
    conversation.appendMessages({
      role: row.role,
      content: row.id,
      id: row.id,
      ...(row.metadata === undefined ? {} : { metadata: row.metadata }),
    } as never);
  }
  return conversation.current;
}

/** A run ref of `runId` at `sequence`, with the boundary of `history` when it ended. */
function refOf(
  runId: string,
  sequence: number,
  status: RunRef['status'],
  history: ConversationHistory | undefined,
  userMessageId: string | undefined = `${runId}:input`,
): RunRef {
  const boundary =
    history === undefined
      ? undefined
      : (() => {
          const { ids, messages, ...conversation } = history;
          return { conversation, ids: [...ids], messages: { ...messages } };
        })();
  return {
    runId,
    sequence,
    status,
    startedAt: '2026-11-18T00:00:00.000Z',
    agentName: 'agent',
    ...(userMessageId === undefined ? {} : { userMessageId }),
    ...(boundary === undefined ? {} : { conversationBoundary: boundary }),
  };
}

const R0 = `${CRAFTED}:0`;
const R1 = `${CRAFTED}:1`;

/** A finished first turn, then a stopped second one that thought, called a tool and was asked a question. */
const FINISHED: readonly Row[] = [
  { id: `${R0}:input`, role: 'user' },
  { id: `${R0}:step:0`, role: 'assistant' },
];
const STOPPED: readonly Row[] = [
  { id: `${R1}:input`, role: 'user' },
  { id: `${R1}:step:0`, role: 'assistant' },
  { id: `${R1}:step:0:call:c-1`, role: 'tool-call' },
  { id: `${R1}:step:0:result:c-1`, role: 'tool-result' },
  { id: `${R1}:signal:ask:0`, role: 'user' },
  { id: `${R1}:step:1`, role: 'assistant' },
];

function sessionOf(
  rows: readonly Row[],
  last: Partial<Pick<RunRef, 'status' | 'userMessageId'>> & { readonly legacy?: boolean } = {},
): AgentSession {
  const history = historyOf(rows);
  const status = last.status ?? 'aborted';
  // The marker the run's terminal save leaves: a running run has left none of its own yet.
  const marker =
    status === 'running'
      ? { lastRunId: R0, lastRunStatus: 'completed' }
      : { lastRunId: R1, lastRunStatus: status };
  return {
    ...createAgentSession({
      id: CRAFTED,
      agentName: 'agent',
      conversationHistory: history,
      metadata: marker,
    }),
    runs: [
      refOf(R0, 0, 'completed', historyOf(FINISHED)),
      refOf(
        R1,
        1,
        status,
        status === 'running' ? undefined : history,
        last.legacy === true ? undefined : (last.userMessageId ?? `${R1}:input`),
      ),
    ],
  };
}

describe('which turn may be discarded', () => {
  it('is everything the last run wrote after the person’s message, its questions’ answers included', () => {
    expect(judgeDiscardableTurn(sessionOf([...FINISHED, ...STOPPED]), R1)).toEqual({
      ok: true,
      removed: STOPPED.slice(1).map((row) => row.id),
    });
    expect(
      judgeDiscardableTurn(sessionOf([...FINISHED, ...STOPPED], { status: 'error' }), R1).ok,
    ).toBe(true);
  });

  it('starts the turn of a Bureau run, which keeps no ref and names the person’s message by the conversation, at its first row', () => {
    const rows = [
      ...FINISHED,
      { id: 'conversation-1-message', role: 'user' as const },
      ...STOPPED.slice(1),
    ];
    expect(judgeDiscardableTurn({ ...sessionOf(rows), runs: [] }, R1)).toEqual({
      ok: true,
      removed: STOPPED.slice(1).map((row) => row.id),
    });
    expect(judgeDiscardableTurn(sessionOf(rows, { legacy: true }), R1)).toEqual({
      ok: true,
      removed: STOPPED.slice(1).map((row) => row.id),
    });
  });

  it('refuses each turn it must keep, for its own reason', () => {
    const stopped = [...FINISHED, ...STOPPED];
    const reasonOf = (session: AgentSession, runId = R1) => {
      const judged = judgeDiscardableTurn(session, runId);
      return judged.ok ? 'discardable' : judged.reason;
    };
    // A run whose end the chat does not record (here, one it never held) counts as going.
    expect(reasonOf(sessionOf(stopped), 'elsewhere:0')).toBe('turn-running');
    expect(reasonOf(sessionOf(stopped), R0)).toBe('not-latest-turn');
    expect(reasonOf(sessionOf(stopped, { status: 'running' }))).toBe('turn-running');
    expect(reasonOf(sessionOf(stopped, { status: 'completed' }))).toBe('turn-finished');
    expect(
      reasonOf(
        sessionOf([
          ...stopped,
          { id: 'follow-up', role: 'user', metadata: { sessionInputCommandId: 'x' } },
        ]),
      ),
    ).toBe('follow-up-delivered');
    expect(reasonOf(sessionOf([...stopped, { id: 'stranger', role: 'assistant' }]))).toBe(
      'not-latest-turn',
    );
    expect(reasonOf(sessionOf([...FINISHED, STOPPED[0]!]))).toBe('nothing-to-discard');
  });
});

describe('removeSessionTurn', () => {
  it('removes the turn from the live history and the run’s boundary, so a fork through the run reads it gone', () => {
    const session = sessionOf([...FINISHED, ...STOPPED]);
    const judged = judgeDiscardableTurn(session, R1);
    if (!judged.ok) throw new Error(judged.message);

    const removed = removeSessionTurn(session, R1, judged.removed, '2026-11-18T01:00:00.000Z');

    const kept = [...FINISHED, STOPPED[0]!].map((row) => row.id);
    expect(removed.conversationHistory.ids).toEqual(kept);
    expect(Object.keys(removed.conversationHistory.messages).toSorted()).toEqual(kept.toSorted());
    expect(conversationThroughRun(removed, 1).ids).toEqual(kept);
    // The earlier run's boundary, and the session it was given, are unchanged.
    expect(conversationThroughRun(removed, 0)).toEqual(conversationThroughRun(session, 0));
    expect(session.conversationHistory.ids).toHaveLength(FINISHED.length + STOPPED.length);
  });

  it('names the removed rows as discarded after those an earlier discard named, the oldest dropped past the limit', () => {
    const at = '2026-11-18T01:00:00.000Z';
    const session = sessionOf([...FINISHED, ...STOPPED]);
    // A chat stored before discards named their rows reads as one with none.
    expect(discardedRowIdsOf(session.metadata)).toEqual([]);
    const earlier = Array.from({ length: DISCARDED_ROW_IDS_LIMIT }, (_, index) => `old-${index}`);
    const named = {
      ...session,
      metadata: { ...session.metadata, [DISCARDED_ROWS_METADATA_KEY]: earlier },
    };

    const removed = removeSessionTurn(named, R1, ['new-0', 'new-1'], at);

    expect(discardedRowIdsOf(removed.metadata)).toEqual([...earlier.slice(2), 'new-0', 'new-1']);
    // A discard larger than the limit keeps every id of its own.
    const large = Array.from({ length: DISCARDED_ROW_IDS_LIMIT + 1 }, (_, index) => `n-${index}`);
    expect(discardedRowIdsOf(removeSessionTurn(named, R1, large, at).metadata)).toEqual(large);
  });
});

describe('the discard receipt', () => {
  const identity = {
    callerId: ALICE,
    target: CRAFTED,
    requestId: 'command',
    operationVersion: DISCARD_OPERATION_VERSION,
  };
  const result = {
    contextId: CRAFTED,
    runId: R1,
    removed: 5,
    incarnation: 'incarnation-1',
    previousRevision: 3,
    revision: 4,
  };

  it('round-trips through the outbox payload and answers only the claim it was made for', () => {
    const receipt = parseDiscardReceipt(
      discardReceiptPayload({ identity, payloadDigest: 'digest', result }),
    );
    expect(receipt?.result).toEqual(result);
    const claim = { incarnation: 'incarnation-1', revision: 3 };
    expect(discardReceiptAnswersClaim(receipt!, identity, 'digest', claim)).toBe(true);
    expect(discardReceiptAnswersClaim(receipt!, identity, 'other', claim)).toBe(false);
    expect(
      discardReceiptAnswersClaim(receipt!, identity, 'digest', { ...claim, revision: 2 }),
    ).toBe(false);
    expect(parseDiscardReceipt({ identity, payloadDigest: 'digest', result: {} })).toBeUndefined();
  });
});

/** Settles once the newest stoppable agent's run reaches its second step, which waits to be stopped. */
let secondStep = Promise.withResolvers<void>();
/** The rows each model call of the newest agent was asked over. */
let askedOver: string[][] = [];

/**
 * An agent whose first step thinks and calls a tool, and whose second waits until the run is
 * stopped. `fail` makes the first step throw instead.
 */
function stoppableAgent(options: { readonly fail?: boolean; readonly finish?: boolean } = {}) {
  secondStep = Promise.withResolvers<void>();
  askedOver = [];
  const noop = createTool({
    name: 'noop',
    description: 'Does nothing',
    input: z.object({}),
    execute: async () => 'ok',
  });
  return createAgent({
    name: 'agent',
    tools: { noop },
    generate: async (context: GenerateContext) => {
      if (options.fail === true) throw new Error('the model failed');
      const history = context.conversation.current;
      askedOver.push([...history.ids]);
      const last = history.messages[history.ids.at(-1) ?? ''];
      if (last?.toolResult === undefined) {
        return {
          content: 'thinking',
          toolCalls: [{ id: `c-${history.ids.length}`, name: 'noop', arguments: {} }],
        };
      }
      if (options.finish === true) return { content: 'done', toolCalls: [] };
      secondStep.resolve();
      await new Promise<void>((_resolve, reject) => {
        const signal = context.signal;
        if (signal === undefined) throw new Error('A step of a run is given its signal.');
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return { content: 'never', toolCalls: [] };
    },
  });
}

async function openBureau(agent = stoppableAgent(), storage: Storage = new MemoryStorage()) {
  const bureau = await createBureau<AgentDefinitions>({
    models: { catalog: createVendorCatalog().descriptors },
    agents: { agent },
    storage,
    durable: true,
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

const discard = (
  bureau: Bureau<AgentDefinitions>,
  contextId: string,
  runId: string,
  commandId = 'discard-1',
) => bureau.contexts.discardTurn(contextId, { owner: ALICE, commandId, runId });

async function refusalOf(pending: Promise<unknown>): Promise<string> {
  const error = await pending.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof SessionDiscardRefusedError)) return `not a refusal: ${String(error)}`;
  return error.reason;
}

/** Whether the run's task record holds its end. */
async function hasSettled(bureau: Bureau<AgentDefinitions>, runId: string): Promise<boolean> {
  const record = await bureau.internals.taskRegistry.record(runId);
  return record?.settled !== undefined;
}

/** The status the task view of `runId` reads. */
async function statusOf(bureau: Bureau<AgentDefinitions>, runId: string) {
  const view = await bureau.tasks.get(runId);
  return view?.status;
}

/** Waits until the run's end is in its task record, then reads the context. */
async function untilEnded(bureau: Bureau<AgentDefinitions>, contextId: string, runId: string) {
  await waitForTaskState(bureau, runId);
  await waitForCondition(() => hasSettled(bureau, runId), 'the run has ended');
  // The run's terminal save, which writes its rows, records its end in the chat after that.
  await waitForCondition(async () => {
    const session = await bureau.contexts.get(contextId);
    return session?.metadata['lastRunId'] === runId;
  }, 'the chat records the run’s end');
  return (await bureau.contexts.get(contextId))!;
}

/** A turn the person stopped while its second step waited, its first step done. */
async function stoppedTurn(bureau: Bureau<AgentDefinitions>) {
  const run = await startTaskFrom(bureau, { input: 'go', agentName: 'agent', principal: ALICE });
  await secondStep.promise;
  await bureau.tasks.cancel(run.id);
  return { run, before: await untilEnded(bureau, run.contextId, run.id) };
}

describe('discarding a stopped turn', () => {
  it('removes what the run wrote, keeps the person’s message and the task record, and audits it', async () => {
    const bureau = await openBureau();
    const { run, before } = await stoppedTurn(bureau);
    const record = await bureau.internals.taskRegistry.record(run.id);
    const ids = before.conversationHistory.ids;
    const turnStart = ids.findIndex((id) => id.startsWith(`${run.id}:step:`));
    expect(turnStart).toBeGreaterThan(0);

    const result = await discard(bureau, run.contextId, run.id);

    const after = (await bureau.contexts.get(run.contextId))!;
    expect(after.conversationHistory.ids).toEqual(ids.slice(0, turnStart));
    expect(after.conversationHistory.messages[ids[turnStart - 1]!]?.role).toBe('user');
    expect(result).toEqual({
      contextId: run.contextId,
      runId: run.id,
      removed: ids.length - turnStart,
      incarnation: before.incarnation,
      previousRevision: before.revision,
      revision: after.revision,
    });
    // The task record still says how the run ended, which stays true.
    expect(await bureau.internals.taskRegistry.record(run.id)).toEqual(record);
    expect(await statusOf(bureau, run.id)).toBe('canceled');
    await waitForCondition(async () => {
      const audit = await bureau.internals.auditTrail?.query({ runId: run.id });
      return audit?.some((entry) => entry.type === DISCARD_AUDIT_TYPE) === true;
    }, 'the discard is audited');
    const audit = await bureau.internals.auditTrail!.query({ runId: run.id });
    const entry = audit.find((candidate) => candidate.type === DISCARD_AUDIT_TYPE);
    expect(entry?.principal).toBe(ALICE);
    expect(entry?.detail).toEqual({
      contextId: run.contextId,
      commandId: 'discard-1',
      removed: result.removed,
    });
  });

  it('answers an exact retry with the original result and removes nothing more, and another run under it as a conflict', async () => {
    const bureau = await openBureau();
    const { run } = await stoppedTurn(bureau);
    const first = await discard(bureau, run.contextId, run.id);
    const after = await bureau.contexts.get(run.contextId);

    expect(await discard(bureau, run.contextId, run.id)).toEqual(first);
    expect(await bureau.contexts.get(run.contextId)).toEqual(after);
    expect(await refusalOf(discard(bureau, run.contextId, 'another-run'))).toBe('command-conflict');
    // A new command for the same run finds nothing left to discard.
    expect(await refusalOf(discard(bureau, run.contextId, run.id, 'discard-2'))).toBe(
      'nothing-to-discard',
    );
  });

  it('commits a receipt the drain completes the command from, then acknowledges it', async () => {
    const bureau = await openBureau();
    const { run } = await stoppedTurn(bureau);
    const result = await discard(bureau, run.contextId, run.id);

    await waitForCondition(async () => {
      const pending = await bureau.internals.sessionStore!.outbox.pending();
      return !pending.some(
        (entry) =>
          entry.kind === 'session.attachment' &&
          entry.namespace === DISCARD_RECEIPT_OUTBOX_NAMESPACE,
      );
    }, 'the receipt is acknowledged');
    const ledger = createDiscardLedger(bureau.internals.kv, {
      clock: { now: () => Date.now(), nowISO: () => new Date().toISOString() },
      identifiers: { next: () => crypto.randomUUID() },
    });
    const stored = await ledger.read({
      callerId: ALICE,
      target: run.contextId,
      requestId: 'discard-1',
      operationVersion: DISCARD_OPERATION_VERSION,
    });
    expect(stored?.state === 'completed' ? stored.result : undefined).toEqual(result);
  });

  it('completes a pending command from the receipt its first attempt committed, and answers the retry from it', async () => {
    const bureau = await openBureau();
    const { run, before } = await stoppedTurn(bureau);
    const ledger = createDiscardLedger(bureau.internals.kv, {
      clock: { now: () => Date.now(), nowISO: () => new Date().toISOString() },
      identifiers: { next: () => crypto.randomUUID() },
    });
    const identity = {
      callerId: ALICE,
      target: run.contextId,
      requestId: 'crashed',
      operationVersion: DISCARD_OPERATION_VERSION,
    };
    const payloadDigest = digestCommandPayload({ runId: run.id });
    await ledger.claim(identity, payloadDigest, {
      incarnation: before.incarnation,
      revision: before.revision,
    });
    const judged = judgeDiscardableTurn(before, run.id);
    if (!judged.ok) throw new Error(judged.message);
    const result = {
      contextId: run.contextId,
      runId: run.id,
      removed: judged.removed.length,
      incarnation: before.incarnation,
      previousRevision: before.revision,
      revision: before.revision + 1,
    };
    // The first attempt committed the removal and its receipt, then stopped before completing.
    await bureau.internals.sessionStore!.update(
      run.contextId,
      (current) =>
        current === undefined
          ? undefined
          : removeSessionTurn(current, run.id, judged.removed, new Date().toISOString()),
      {
        outbox: [
          {
            namespace: DISCARD_RECEIPT_OUTBOX_NAMESPACE,
            payload: discardReceiptPayload({ identity, payloadDigest, result }),
          },
        ],
      },
    );

    await waitForCondition(async () => {
      const entry = await ledger.read(identity);
      return entry?.state === 'completed';
    }, 'the drain completes the command from its receipt');
    expect(await discard(bureau, run.contextId, run.id, 'crashed')).toEqual(result);
  });

  it('stays discarded after a restart and its recovery, and the same command answers the same', async () => {
    const storage = new MemoryStorage();
    const first = await openBureau(stoppableAgent(), storage);
    const { run } = await stoppedTurn(first);
    const result = await discard(first, run.contextId, run.id);
    const after = (await first.contexts.get(run.contextId))!;
    await waitForCondition(async () => {
      const pending = await first.internals.sessionStore!.outbox.pending();
      return !pending.some(
        (entry) =>
          entry.kind === 'session.attachment' &&
          entry.namespace === DISCARD_RECEIPT_OUTBOX_NAMESPACE,
      );
    }, 'the receipt is drained');
    await cleanups.pop()!();

    const restarted = await openBureau(stoppableAgent(), storage);
    // Boot recovery has classified and reattached what the first process left before this resolves.
    await restarted.recovery();

    const reread = await restarted.contexts.get(run.contextId);
    expect(reread?.conversationHistory.ids).toEqual(after.conversationHistory.ids);
    expect(await discard(restarted, run.contextId, run.id)).toEqual(result);
  });

  it('discards a turn that failed after it wrote a step', async () => {
    let calls = 0;
    const failing = createAgent({
      name: 'agent',
      tools: {
        noop: createTool({
          name: 'noop',
          description: 'Does nothing',
          input: z.object({}),
          execute: async () => 'ok',
        }),
      },
      generate: async () => {
        calls += 1;
        if (calls > 1) throw new Error('the model failed');
        return { content: 'thinking', toolCalls: [{ id: 'c-1', name: 'noop', arguments: {} }] };
      },
    });
    const bureau = await openBureau(failing);
    const run = await startTaskFrom(bureau, { input: 'go', agentName: 'agent', principal: ALICE });
    const before = await untilEnded(bureau, run.contextId, run.id);
    expect(await statusOf(bureau, run.id)).toBe('failed');
    expect(before.conversationHistory.ids.some((id) => id.startsWith(`${run.id}:step:`))).toBe(
      true,
    );

    const result = await discard(bureau, run.contextId, run.id);

    expect(result.removed).toBeGreaterThan(0);
    const after = (await bureau.contexts.get(run.contextId))!;
    expect(after.conversationHistory.ids.some((id) => id.startsWith(`${run.id}:step:`))).toBe(
      false,
    );
  });
});

// COR-2437 review: a run that starts while a discard commits must not write the discarded rows
// back, and its model must never read them.
describe('a discard racing a new message', () => {
  it('refuses a start that loaded the chat before the discard and saves after it, and the rows stay gone', async () => {
    const bureau = await openBureau();
    const { run, before } = await stoppedTurn(bureau);
    const sessions = bureau.internals.sessionStore!;
    const update = sessions.update.bind(sessions);
    let discarded: Promise<unknown> | undefined;
    // The discard commits between the start's read of the chat and its save.
    (sessions as { update: typeof sessions.update }).update = async (id, updater, options) => {
      if (discarded === undefined) {
        (sessions as { update: typeof sessions.update }).update = update;
        discarded = discard(bureau, run.contextId, run.id);
        await discarded;
      }
      return update(id, updater, options);
    };

    const start = await startTaskFrom(bureau, {
      input: 'something else',
      agentName: 'agent',
      principal: ALICE,
      contextId: run.contextId,
    }).catch((error: unknown) => error);

    expect(start).toBeInstanceOf(ContextHistoryChangedError);
    const removed = (await discarded) as { removed: number };
    expect(removed.removed).toBeGreaterThan(0);
    const after = (await bureau.contexts.get(run.contextId))!;
    expect(after.conversationHistory.ids.some((id) => id.startsWith(`${run.id}:step:`))).toBe(
      false,
    );
    expect(after.conversationHistory.ids.length).toBeLessThan(
      before.conversationHistory.ids.length,
    );
  });

  it('starts a message sent after the discard on the chat without the discarded rows', async () => {
    const bureau = await openBureau();
    const { run } = await stoppedTurn(bureau);
    await discard(bureau, run.contextId, run.id);
    secondStep = Promise.withResolvers<void>();

    const next = await startTaskFrom(bureau, {
      input: 'something else',
      agentName: 'agent',
      principal: ALICE,
      contextId: run.contextId,
    });
    await secondStep.promise;

    const during = (await bureau.contexts.get(run.contextId))!;
    expect(during.conversationHistory.ids.some((id) => id.startsWith(`${run.id}:step:`))).toBe(
      false,
    );
    expect(askedOver.at(-1)?.some((id) => id.startsWith(`${run.id}:step:`))).toBe(false);
    await bureau.tasks.cancel(next.id);
  });

  // A schedule's fire saves no start of its own: it reads the chat, and its first save is after its
  // first step. The discard here passes its check of the chat's runs before the fire is admitted,
  // and commits after the fire read the chat.
  it('refuses a schedule’s fire that read the chat before the discard committed, before its model is asked over the discarded reply', async () => {
    const bureau = await openBureau();
    const { run } = await stoppedTurn(bureau);
    const schedule = await bureau.schedules.create({
      agentName: 'agent',
      input: 'check in',
      spec: '1h',
      sessionId: run.contextId,
      principal: ALICE,
    });
    const sessions = bureau.internals.sessionStore!;
    const tasks = bureau.internals.taskRegistry;
    const update = sessions.update.bind(sessions);
    const bindIncarnation = tasks.bindIncarnation.bind(tasks);
    const fireRead = Promise.withResolvers<void>();
    const discardCommitted = Promise.withResolvers<void>();
    let fired: Promise<string> | undefined;
    // The fire binds its task to the chat right after it read it: it waits there for the discard.
    (tasks as { bindIncarnation: typeof tasks.bindIncarnation }).bindIncarnation = async (
      taskId,
      incarnation,
    ) => {
      (tasks as { bindIncarnation: typeof tasks.bindIncarnation }).bindIncarnation =
        bindIncarnation;
      fireRead.resolve();
      await discardCommitted.promise;
      return bindIncarnation(taskId, incarnation);
    };
    // The discard's write starts the fire and lets it read the chat before it commits.
    (sessions as { update: typeof sessions.update }).update = async (id, updater, options) => {
      (sessions as { update: typeof sessions.update }).update = update;
      fired = bureau.schedules.runNow(schedule!.id).then((started) => {
        const workflowId =
          started !== undefined && 'workflowId' in started ? started.workflowId : '';
        expect(workflowId).not.toBe('');
        return workflowId;
      });
      await fireRead.promise;
      return update(id, updater, options);
    };
    const askedBefore = askedOver.length;

    const discarded = await discard(bureau, run.contextId, run.id);
    discardCommitted.resolve();
    const afterDiscard = (await bureau.contexts.get(run.contextId))!;
    const workflowId = await fired!;
    let terminal:
      | { status: string; result?: { finishReason?: string; errorMessage?: string } }
      | null
      | undefined;
    // A fire whose model was asked waits in its second step, so either ends the wait.
    await waitForCondition(async () => {
      if (askedOver.length > askedBefore) return true;
      const state = await bureau.durableEngine()!.get(workflowId);
      if (state === null || state === undefined) return false;
      if (state.status === 'pending' || state.status === 'running') return false;
      terminal = state;
      return true;
    }, 'the fire has ended or asked its model');

    expect(discarded.removed).toBeGreaterThan(0);
    // Its model was never asked, so never over the discarded reply.
    expect(askedOver.slice(askedBefore)).toEqual([]);
    // The fire's outcome, in the schedule's words: its run ended on the refusal.
    expect(terminal?.result).toMatchObject({ finishReason: 'error', errorKind: 'policy' });
    expect(terminal?.result?.errorMessage).toContain('history-changed');
    await waitForCondition(() => hasSettled(bureau, workflowId), 'the fire’s task has ended');
    expect(await statusOf(bureau, workflowId)).toBe('failed');
    // The refused fire wrote nothing to the chat.
    const after = (await bureau.contexts.get(run.contextId))!;
    expect(after.conversationHistory.ids).toEqual(afterDiscard.conversationHistory.ids);
    // The schedule is not paused by it, and its next fire runs on the chat the discard left.
    secondStep = Promise.withResolvers<void>();
    const next = await bureau.schedules.runNow(schedule!.id);
    await secondStep.promise;
    expect(askedOver.at(-1)?.some((id) => id.startsWith(`${run.id}:step:`))).toBe(false);
    if (next !== undefined && 'workflowId' in next) await bureau.tasks.cancel(next.workflowId);
  });
});

// COR-2437 review: the discard ledger was never pruned, so its entries outlived their retention.
describe('the discard ledger', () => {
  it('is pruned by maintenance once an answered command is past its retention', async () => {
    const origin = Date.parse('2026-11-18T00:00:00.000Z');
    const runtime = createManualRuntimeServices({ origin: new Date(origin).toISOString() });
    const bureau = await createBureau<AgentDefinitions>({
      models: { catalog: createVendorCatalog().descriptors },
      agents: { agent: stoppableAgent() },
      runtime,
      storage: new MemoryStorage(),
      durable: true,
      durableOwnership: { ownership: 'none' },
      maintenance: 'manual',
    });
    cleanups.push(() => bureau.dispose());
    const ledger = createDiscardLedger(bureau.internals.kv, runtime);
    const identity = {
      callerId: ALICE,
      target: 'context-1',
      requestId: 'discard-old',
      operationVersion: DISCARD_OPERATION_VERSION,
    };
    const claimed = await ledger.claim(identity, 'digest', { incarnation: 'i', revision: 1 });
    if (claimed.outcome !== 'claimed') throw new Error('expected a fresh claim');
    await ledger.complete(claimed.entry, {
      contextId: 'context-1',
      runId: 'run-1',
      removed: 1,
      incarnation: 'i',
      previousRevision: 1,
      revision: 2,
    });

    runtime.setTime(origin + 2 * 86_400_000);
    await bureau.maintain();

    expect(await ledger.read(identity)).toBeUndefined();
  });
});

describe('a discard refused', () => {
  it('keeps a turn that finished normally', async () => {
    const bureau = await openBureau(stoppableAgent({ finish: true }));
    const run = await startTaskFrom(bureau, { input: 'go', agentName: 'agent', principal: ALICE });
    await waitForTaskState(bureau, run.id);
    const before = await untilEnded(bureau, run.contextId, run.id);

    expect(await refusalOf(discard(bureau, run.contextId, run.id))).toBe('turn-finished');
    expect(await bureau.contexts.get(run.contextId)).toEqual(before);
  });

  it('keeps a turn still going until it is cancelled', async () => {
    const bureau = await openBureau();
    const run = await startTaskFrom(bureau, { input: 'go', agentName: 'agent', principal: ALICE });
    await secondStep.promise;

    expect(await refusalOf(discard(bureau, run.contextId, run.id))).toBe('turn-running');
    await bureau.tasks.cancel(run.id);
    await untilEnded(bureau, run.contextId, run.id);
    // The refusal released the command: the same command discards once the turn has stopped.
    const discarded = await discard(bureau, run.contextId, run.id);
    expect(discarded.runId).toBe(run.id);
  });

  it('keeps a turn whose process stopped before it recorded its end', async () => {
    const bureau = await openBureau();
    const session = sessionOf([...FINISHED, ...STOPPED], { status: 'running' });
    await bureau.internals.sessionStore!.save({ ...session, metadata: { sessionOwner: ALICE } });
    const saved = (await bureau.contexts.get(CRAFTED))!;
    await bureau.internals.taskRegistry.recordAdmission({
      taskId: R1,
      contextId: CRAFTED,
      incarnation: saved.incarnation,
      agentName: 'agent',
      owner: ALICE,
      origin: { kind: 'api' },
      message: 'go',
    });
    await bureau.internals.taskRegistry.recordSettled(R1, {
      at: new Date().toISOString(),
      status: 'failed',
      finishReason: TASK_OWNER_LOST_FINISH_REASON,
      message: null,
    });

    // The ref still says running, and the record says only that its process went away.
    expect(await refusalOf(discard(bureau, CRAFTED, R1))).toBe('turn-outcome-unknown');
    expect(await bureau.contexts.get(CRAFTED)).toEqual(saved);
  });

  it('answers a context it does not hold, an archived one and a shutting-down Bureau', async () => {
    const bureau = await openBureau();
    const { run } = await stoppedTurn(bureau);

    expect(await refusalOf(discard(bureau, run.contextId, 'no-such-run'))).toBe('run-not-found');
    const missing = await discard(bureau, 'no-such-context', run.id).catch(
      (error: unknown) => error,
    );
    expect((missing as { code?: string }).code).toBe('NOT_FOUND');
    await bureau.contexts.archive(run.contextId);
    expect(
      await discard(bureau, run.contextId, run.id).catch((error: unknown) => error),
    ).toBeInstanceOf(ContextArchivedError);
    await bureau.contexts.unarchive(run.contextId);
    await bureau.shutdown();
    expect(
      await discard(bureau, run.contextId, run.id).catch((error: unknown) => error),
    ).toBeInstanceOf(BureauShuttingDownError);
  });
});
