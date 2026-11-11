/**
 * COR-2296 — regenerating a context's latest answer: the model is asked once, over the history
 * before the answer, with a toolbox that holds no tool, and only that answer is replaced. Every
 * refusal leaves the history as it was, a duplicate never asks the model again, and the receipt
 * the replacement commits completes the command for a retry after a crash.
 */
import {
  conversationThroughRun,
  createAgent,
  createAgentSession,
  createModelCatalog,
  GuardrailTripwireError,
  type AgentSession,
  type BackendDescriptor,
  type GenerateContext,
  type GenerateResponse,
  type RunRef,
  stopWhen,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { createTool } from 'armorer';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
} from 'conversationalist';
import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { BureauShuttingDownError } from './bureau-errors';
import { createBureau } from './create-bureau';
import { digestCommandPayload } from './command-ledger';
import { ModelPolicyDeniedError } from './file-agent-generate';
import type { BureauModelPolicyOptions } from './model-policy';
import {
  createRegenerateLedger,
  historyBeforeAnswer,
  parseRegenerateReceipt,
  receiptAnswersClaim,
  REGENERATE_OPERATION_VERSION,
  REGENERATE_RECEIPT_OUTBOX_NAMESPACE,
  regenerateReceiptPayload,
  replaceSessionAnswer,
  SessionRegenerateRefusedError,
} from './session-regenerate';
import { waitForCondition, waitForTaskState } from './test';
import { approvalToolbox } from './http/management/management-fixtures.test-support';
import { OPUS_5, OPUS_5_5 } from './testing/model-override.test-support';
import type { Bureau } from './types';
import { startTaskFrom } from './test/task-start-request.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const ALICE = 'alice';

/** What the agent answers when it is asked to regenerate, and what it counted. */
interface Script {
  /** The answer to a regeneration: a call whose toolbox holds no tool. */
  answer: (context: GenerateContext) => Promise<GenerateResponse>;
  /** How many regenerations asked the model. */
  regenerations: number;
  /** How many times the agent's one tool ran. */
  toolRuns: number;
  /** The history each regeneration was asked over. */
  readonly asked: ConversationHistory[];
  /** The model each regeneration's steering named. */
  readonly steered: Array<string | undefined>;
}

function newScript(
  answer: Script['answer'] = async () => ({ content: 'a better answer', toolCalls: [] }),
): Script {
  return { answer, regenerations: 0, toolRuns: 0, asked: [], steered: [] };
}

/**
 * An agent whose turn thinks (a tool call and text), then answers. A call with an empty toolbox
 * is a regeneration, and is answered by the script.
 */
function scriptedAgent(script: Script) {
  const noop = createTool({
    name: 'noop',
    description: 'Does nothing',
    input: z.object({}),
    execute: async () => {
      script.toolRuns += 1;
      return 'ok';
    },
  });
  return createAgent({
    name: 'agent',
    tools: { noop },
    allowedCandidates: [OPUS_5_5, OPUS_5],
    generate: async (context) => {
      const history = context.conversation.current;
      if (context.toolbox.tools().length === 0) {
        script.regenerations += 1;
        script.asked.push(history);
        script.steered.push(context.steering?.model);
        return script.answer(context);
      }
      const last = history.messages[history.ids.at(-1) ?? ''];
      if (last?.toolResult === undefined) {
        return {
          content: 'thinking',
          toolCalls: [{ id: `c-${history.ids.length}`, name: 'noop', arguments: {} }],
        };
      }
      return { content: `answer ${history.ids.length}`, toolCalls: [] };
    },
  });
}

async function openBureau(script: Script, storage: Storage = new MemoryStorage()) {
  const bureau = await createBureau<AgentDefinitions>({
    agents: { agent: scriptedAgent(script) },
    storage,
    durable: true,
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

const regenerate = (
  bureau: Bureau<AgentDefinitions>,
  contextId: string,
  messageId: string,
  commandId = 'regenerate-1',
  signal?: AbortSignal,
) =>
  bureau.contexts.regenerate(contextId, {
    owner: ALICE,
    commandId,
    messageId,
    ...(signal === undefined ? {} : { signal }),
  });

async function refusalOf(pending: Promise<unknown>): Promise<string> {
  const error = await pending.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof SessionRegenerateRefusedError)) return `not a refusal: ${String(error)}`;
  return error.reason;
}

/** One row of a crafted run: its id and role, and the call it makes or answers. */
type CraftedRow = {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool-call' | 'tool-result';
  readonly content?: string;
  readonly call?: string;
};

/** A crafted run: its id, its rows, and whether it has ended. */
type CraftedRun = {
  readonly runId: string;
  readonly rows: readonly CraftedRow[];
  readonly live?: boolean;
};

const CRAFTED = 'crafted';
const R = 'run-crafted';
const ANSWER = `${R}:step:1`;

/** A finished turn: the user's message, a step that called a tool and got its result, an answer. */
const turn = (runId: string, text: string): CraftedRun => ({
  runId,
  rows: [
    { id: `${runId}:user`, role: 'user', content: text },
    { id: `${runId}:step:0`, role: 'assistant', content: 'thinking' },
    { id: `${runId}:step:0:call:c-1`, role: 'tool-call', call: 'c-1' },
    { id: `${runId}:step:0:result:c-1`, role: 'tool-result', call: 'c-1' },
    { id: `${runId}:step:1`, role: 'assistant', content: 'old answer' },
  ],
});

/** A session holding exactly `runs`' rows, with the registry's record of each run. */
async function craft(
  bureau: Bureau<AgentDefinitions>,
  runs: readonly CraftedRun[] = [turn(R, 'go')],
): Promise<AgentSession> {
  const conversation = new Conversation(createConversationHistory());
  for (const run of runs) {
    for (const row of run.rows) {
      conversation.appendMessages({
        role: row.role,
        content: row.content ?? '',
        id: row.id,
        ...(row.role === 'tool-call' && row.call !== undefined
          ? { toolCall: { id: row.call, name: 'noop', arguments: {} } }
          : {}),
        ...(row.role === 'tool-result' && row.call !== undefined
          ? { toolResult: { callId: row.call, outcome: 'success', content: 'ok' } }
          : {}),
      } as never);
    }
  }
  await bureau.internals.sessionStore!.save(
    createAgentSession({
      id: CRAFTED,
      agentName: 'agent',
      conversationHistory: conversation.current,
      metadata: { sessionOwner: ALICE },
      runs: [],
    }),
  );
  const saved = (await bureau.contexts.get(CRAFTED))!;
  for (const run of runs) {
    await bureau.internals.taskRegistry.recordAdmission({
      taskId: run.runId,
      contextId: CRAFTED,
      incarnation: saved.incarnation,
      agentName: 'agent',
      owner: ALICE,
      origin: { kind: 'api' },
      message: 'go',
    });
    if (run.live === true) continue;
    await bureau.internals.taskRegistry.recordSettled(run.runId, {
      at: new Date().toISOString(),
      status: 'completed',
      finishReason: 'stop-condition',
      message: null,
    });
  }
  return (await bureau.contexts.get(CRAFTED))!;
}

/** The regeneration ledger over the Bureau's own store, as a second process would read it. */
function ledgerOf(bureau: Bureau<AgentDefinitions>) {
  return createRegenerateLedger(bureau.internals.kv, {
    clock: { now: () => Date.now(), nowISO: () => new Date().toISOString() },
    identifiers: { next: () => crypto.randomUUID() },
  });
}

const identityOf = (requestId: string) => ({
  callerId: ALICE,
  target: CRAFTED,
  requestId,
  operationVersion: REGENERATE_OPERATION_VERSION,
});

/** Whether the session outbox still holds a regeneration receipt. */
async function receiptPending(bureau: Bureau<AgentDefinitions>): Promise<boolean> {
  const pending = await bureau.internals.sessionStore!.outbox.pending();
  return pending.some(
    (entry) =>
      entry.kind === 'session.attachment' &&
      entry.namespace === REGENERATE_RECEIPT_OUTBOX_NAMESPACE,
  );
}

describe('replaceSessionAnswer', () => {
  it('replaces the row in the live history and in a run’s boundary, so a fork through the run reads the new answer', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'session-1' }));
    conversation.appendUserMessage('hello');
    conversation.appendAssistantMessage('old answer');
    const history = conversation.current;
    const answerId = history.ids.at(-1)!;
    const { ids, messages, ...header } = history;
    const runs: RunRef[] = [
      {
        runId: 'session-1:0',
        sequence: 0,
        status: 'completed',
        startedAt: history.createdAt,
        agentName: 'agent',
        conversationBoundary: { conversation: header, ids: [...ids], messages: { ...messages } },
      },
    ];
    const session = {
      ...createAgentSession({ agentName: 'agent', conversationHistory: history }),
      runs,
    };
    const replacement = { ...history.messages[answerId]!, content: 'new answer' };

    const replaced = replaceSessionAnswer(
      session,
      answerId,
      replacement,
      '2026-11-11T00:00:00.000Z',
    );

    expect(replaced.conversationHistory.ids).toEqual(history.ids);
    expect(replaced.conversationHistory.messages[answerId]?.content).toBe('new answer');
    expect(replaced.conversationHistory.messages[history.ids[0]!]).toEqual(
      history.messages[history.ids[0]!],
    );
    // The fork through the run reads the boundary, not the live history: it must hold the new answer.
    expect(conversationThroughRun(replaced, 0).messages[answerId]?.content).toBe('new answer');
    // The session it was given is unchanged.
    expect(conversationThroughRun(session, 0).messages[answerId]?.content).toBe('old answer');
  });

  it('asks over the history before the answer, keeping every other row in order', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('hello');
    conversation.appendAssistantMessage('old answer');
    const history = conversation.current;

    const before = historyBeforeAnswer(history, history.ids.at(-1)!);

    expect(before.ids).toEqual(history.ids.slice(0, -1));
    expect(Object.keys(before.messages)).toEqual(history.ids.slice(0, -1));
  });
});

describe('the regeneration receipt', () => {
  const identity = identityOf('command');
  const result = {
    contextId: CRAFTED,
    messageId: ANSWER,
    incarnation: 'incarnation-1',
    previousRevision: 3,
    revision: 4,
  };

  it('round-trips through the outbox payload and answers only the claim it was made for', () => {
    const receipt = parseRegenerateReceipt(
      regenerateReceiptPayload({ identity, payloadDigest: 'digest', result }),
    );

    expect(receipt).toEqual({ identity, payloadDigest: 'digest', result });
    const claim = { incarnation: 'incarnation-1', revision: 3 };
    expect(receiptAnswersClaim(receipt!, identity, 'digest', claim)).toBe(true);
    expect(receiptAnswersClaim(receipt!, identity, 'other-digest', claim)).toBe(false);
    expect(receiptAnswersClaim(receipt!, identityOf('another'), 'digest', claim)).toBe(false);
    expect(receiptAnswersClaim(receipt!, identity, 'digest', { ...claim, revision: 2 })).toBe(
      false,
    );
    expect(
      receiptAnswersClaim(receipt!, identity, 'digest', { ...claim, incarnation: 'other' }),
    ).toBe(false);
  });

  it('reads a payload that is not a receipt as none', () => {
    expect(parseRegenerateReceipt({ identity, payloadDigest: 'digest' })).toBeUndefined();
    expect(parseRegenerateReceipt('a receipt')).toBeUndefined();
    expect(
      parseRegenerateReceipt({
        identity,
        payloadDigest: 'digest',
        result: { ...result, revision: -1 },
      }),
    ).toBeUndefined();
  });
});

describe('a regeneration of the latest answer', () => {
  it('asks the model once with no tool, runs no tool, asks for no approval, and replaces only the answer', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    const run = await startTaskFrom(bureau, { input: 'go', agentName: 'agent', principal: ALICE });
    await waitForTaskState(bureau, run.id);
    const answer = `${run.id}:step:1`;
    await waitForCondition(async () => {
      const record = await bureau.internals.taskRegistry.record(run.id);
      const stored = await bureau.contexts.get(run.contextId);
      return record?.settled !== undefined && stored?.conversationHistory.ids.at(-1) === answer;
    }, 'the answer is stored');
    const before = (await bureau.contexts.get(run.contextId))!;
    const toolRuns = script.toolRuns;

    const result = await regenerate(bureau, run.contextId, answer);

    expect(script.regenerations).toBe(1);
    expect(script.toolRuns).toBe(toolRuns);
    expect(bureau.reviews.list()).toEqual([]);
    expect(script.asked[0]?.ids).toEqual(before.conversationHistory.ids.slice(0, -1));
    const after = (await bureau.contexts.get(run.contextId))!;
    expect(after.conversationHistory.ids).toEqual(before.conversationHistory.ids);
    for (const id of before.conversationHistory.ids.slice(0, -1)) {
      expect(after.conversationHistory.messages[id]).toEqual(
        before.conversationHistory.messages[id],
      );
    }
    expect(after.conversationHistory.messages[answer]?.content).toBe('a better answer');
    expect(result).toEqual({
      contextId: run.contextId,
      messageId: answer,
      incarnation: before.incarnation,
      previousRevision: before.revision,
      revision: after.revision,
    });
  });

  it('keeps every user, tool-call and tool-result row, and a fork through the answer reads the new one', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    const before = await craft(bureau);

    const result = await regenerate(bureau, CRAFTED, ANSWER);

    const after = (await bureau.contexts.get(CRAFTED))!;
    expect(result).toEqual({
      contextId: CRAFTED,
      messageId: ANSWER,
      incarnation: before.incarnation,
      previousRevision: before.revision,
      revision: before.revision + 1,
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.conversationHistory.ids).toEqual(before.conversationHistory.ids);
    for (const id of before.conversationHistory.ids.slice(0, -1)) {
      expect(after.conversationHistory.messages[id]).toEqual(
        before.conversationHistory.messages[id],
      );
    }
    expect(after.conversationHistory.messages[ANSWER]?.content).toBe('a better answer');
    expect(script.asked[0]?.ids).toEqual(before.conversationHistory.ids.slice(0, -1));

    const forked = await bureau.contexts.fork(CRAFTED, {
      owner: ALICE,
      commandId: 'fork-after-regenerate',
      throughMessageId: ANSWER,
    });
    const child = (await bureau.contexts.get(forked.contextId))!;
    expect(child.conversationHistory.messages[ANSWER]?.content).toBe('a better answer');
  });

  it('commits a receipt the drain completes the command from, then acknowledges', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    await craft(bureau);

    const result = await regenerate(bureau, CRAFTED, ANSWER);

    await waitForCondition(
      async () => !(await receiptPending(bureau)),
      'the receipt is acknowledged',
    );
    const stored = await ledgerOf(bureau).read(identityOf('regenerate-1'));
    expect(stored?.state).toBe('completed');
    expect(stored?.state === 'completed' ? stored.result : undefined).toEqual(result);
  });

  it('asks the model the context is steered to now', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    await craft(bureau);
    const steered = await bureau.contexts.steer(CRAFTED, {
      id: 'switch',
      principal: ALICE,
      requestedValue: { target: 'model', override: OPUS_5.model, provider: OPUS_5.provider },
    });
    expect(steered.outcome).toBe('accepted');

    await regenerate(bureau, CRAFTED, ANSWER);

    expect(script.steered).toEqual([OPUS_5.model]);
  });
});

describe('a regeneration refused before the model is asked', () => {
  it('refuses a user row, an earlier step, and a message the context does not hold', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    const before = await craft(bureau);

    expect(await refusalOf(regenerate(bureau, CRAFTED, `${R}:user`, 'user'))).toBe(
      'not-a-branch-point',
    );
    expect(await refusalOf(regenerate(bureau, CRAFTED, `${R}:step:0`, 'earlier'))).toBe(
      'not-a-branch-point',
    );
    expect(await refusalOf(regenerate(bureau, CRAFTED, 'no-such-message', 'missing'))).toBe(
      'message-not-found',
    );
    expect(script.regenerations).toBe(0);
    expect(await bureau.contexts.get(CRAFTED)).toEqual(before);
  });

  it('refuses the answer of an earlier run once a later run answered', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    const before = await craft(bureau, [turn('run-1', 'one'), turn('run-2', 'two')]);

    expect(await refusalOf(regenerate(bureau, CRAFTED, 'run-1:step:1'))).toBe('not-latest-answer');
    expect(script.regenerations).toBe(0);
    expect(await bureau.contexts.get(CRAFTED)).toEqual(before);
  });

  it('refuses the answer of a run that has not ended', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    const before = await craft(bureau, [{ ...turn(R, 'go'), live: true }]);

    expect(await refusalOf(regenerate(bureau, CRAFTED, ANSWER))).toBe('not-a-branch-point');
    expect(script.regenerations).toBe(0);
    expect(await bureau.contexts.get(CRAFTED)).toEqual(before);
  });

  it('refuses an answer whose step has a tool call with no result', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    const before = await craft(bureau, [
      {
        runId: R,
        rows: [
          { id: `${R}:user`, role: 'user', content: 'go' },
          { id: `${R}:step:0`, role: 'assistant', content: 'calling' },
          { id: `${R}:step:0:call:c-1`, role: 'tool-call', call: 'c-1' },
        ],
      },
    ]);

    expect(await refusalOf(regenerate(bureau, CRAFTED, `${R}:step:0`))).toBe(
      'branch-with-unresolved-tool-call',
    );
    expect(script.regenerations).toBe(0);
    expect(await bureau.contexts.get(CRAFTED)).toEqual(before);
  });

  it('refuses an answer whose run still has a tool approval waiting', async () => {
    const charges: number[] = [];
    let generations = 0;
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => {
            generations += 1;
            return {
              content: 'charging',
              toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 100 } }],
            };
          },
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });
    cleanups.push(() => bureau.dispose());
    const run = await bureau.tasks.start('default', 'go', { principal: ALICE });
    await waitForTaskState(bureau, run.id);
    const before = await bureau.contexts.get(run.contextId);

    expect(
      await refusalOf(
        bureau.contexts.regenerate(run.contextId, {
          owner: ALICE,
          commandId: 'pending-approval',
          messageId: `${run.id}:step:0`,
        }),
      ),
    ).toBe('branch-with-pending-approval');
    expect(generations).toBe(1);
    expect(charges).toEqual([]);
    expect(await bureau.contexts.get(run.contextId)).toEqual(before);
  });

  it('refuses once the Bureau is shutting down, and asks no model', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    await craft(bureau);
    await bureau.shutdown();

    const error = await regenerate(bureau, CRAFTED, ANSWER).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(BureauShuttingDownError);
    expect(script.regenerations).toBe(0);
  });

  it('answers a context it does not hold as not found', async () => {
    const script = newScript();
    const bureau = await openBureau(script);

    const error = await regenerate(bureau, 'no-such-context', ANSWER).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({ code: 'NOT_FOUND' });
    expect(script.regenerations).toBe(0);
  });
});

describe('a regeneration that leaves the history as it was', () => {
  it('refuses an answer that asks for a tool, and runs none', async () => {
    const script = newScript(async () => ({
      content: 'let me look',
      toolCalls: [{ id: 'c-9', name: 'noop', arguments: {} }],
    }));
    const bureau = await openBureau(script);
    const before = await craft(bureau);

    expect(await refusalOf(regenerate(bureau, CRAFTED, ANSWER))).toBe('answer-has-tool-calls');

    expect(script.regenerations).toBe(1);
    expect(script.toolRuns).toBe(0);
    expect(await bureau.contexts.get(CRAFTED)).toEqual(before);
    expect(await receiptPending(bureau)).toBe(false);
  });

  it('refuses a model that fails or answers no text, and releases the command for a retry', async () => {
    const script = newScript(async () => {
      throw new Error('the model failed');
    });
    const bureau = await openBureau(script);
    const before = await craft(bureau);

    expect(await refusalOf(regenerate(bureau, CRAFTED, ANSWER))).toBe('generation-failed');
    expect(await bureau.contexts.get(CRAFTED)).toEqual(before);

    script.answer = async () => ({ content: '   ', toolCalls: [] });
    expect(await refusalOf(regenerate(bureau, CRAFTED, ANSWER))).toBe('generation-failed');
    expect(await bureau.contexts.get(CRAFTED)).toEqual(before);

    // Each refusal released the command, so the same command tries again.
    script.answer = async () => ({ content: 'third time', toolCalls: [] });
    await regenerate(bureau, CRAFTED, ANSWER);
    expect(script.regenerations).toBe(3);
    const after = (await bureau.contexts.get(CRAFTED))!;
    expect(after.conversationHistory.messages[ANSWER]?.content).toBe('third time');
  });

  it('discards an answer that arrives after the request was aborted', async () => {
    const controller = new AbortController();
    const script = newScript(async () => {
      controller.abort();
      return { content: 'too late', toolCalls: [] };
    });
    const bureau = await openBureau(script);
    const before = await craft(bureau);

    expect(await refusalOf(regenerate(bureau, CRAFTED, ANSWER, 'aborted', controller.signal))).toBe(
      'aborted',
    );

    expect(script.regenerations).toBe(1);
    expect(await bureau.contexts.get(CRAFTED)).toEqual(before);
    expect(await receiptPending(bureau)).toBe(false);
  });

  it('does not ask the model for a request aborted before it began', async () => {
    const controller = new AbortController();
    controller.abort();
    const script = newScript();
    const bureau = await openBureau(script);
    const before = await craft(bureau);

    expect(
      await refusalOf(regenerate(bureau, CRAFTED, ANSWER, 'aborted-early', controller.signal)),
    ).toBe('aborted');

    expect(script.regenerations).toBe(0);
    expect(await bureau.contexts.get(CRAFTED)).toEqual(before);
  });

  it('loses to a change committed while the model answered, and never overwrites it', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    await craft(bureau);
    script.answer = async () => {
      await bureau.internals.sessionStore!.updateMetadata(CRAFTED, { touched: true });
      return { content: 'stale answer', toolCalls: [] };
    };

    expect(await refusalOf(regenerate(bureau, CRAFTED, ANSWER))).toBe('history-changed');

    const after = (await bureau.contexts.get(CRAFTED))!;
    expect(after.metadata['touched']).toBe(true);
    expect(after.conversationHistory.messages[ANSWER]?.content).toBe('old answer');
    expect(await receiptPending(bureau)).toBe(false);
  });

  it('never writes into a context deleted and created again while the model answered', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    const first = await craft(bureau);
    script.answer = async () => {
      await bureau.internals.sessionStore!.delete(CRAFTED);
      await bureau.internals.sessionStore!.save(
        createAgentSession({
          id: CRAFTED,
          agentName: 'agent',
          conversationHistory: first.conversationHistory,
          metadata: { sessionOwner: ALICE },
          runs: [],
        }),
      );
      return { content: 'answer for the old context', toolCalls: [] };
    };

    expect(await refusalOf(regenerate(bureau, CRAFTED, ANSWER))).toBe('history-changed');

    const recreated = (await bureau.contexts.get(CRAFTED))!;
    expect(recreated.incarnation).not.toBe(first.incarnation);
    expect(recreated.conversationHistory.messages[ANSWER]?.content).toBe('old answer');
  });
});

describe('a regeneration command', () => {
  it('answers an exact retry from the ledger without asking the model again, and another message under it as a conflict', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    await craft(bureau);
    const first = await regenerate(bureau, CRAFTED, ANSWER);
    const after = await bureau.contexts.get(CRAFTED);

    const retry = await regenerate(bureau, CRAFTED, ANSWER);
    const other = await refusalOf(regenerate(bureau, CRAFTED, `${R}:step:0`));

    expect(retry).toEqual(first);
    expect(other).toBe('command-conflict');
    expect(script.regenerations).toBe(1);
    expect(await bureau.contexts.get(CRAFTED)).toEqual(after);
  });

  it('shares one attempt between two concurrent duplicates', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const script = newScript(async () => {
      await gate;
      return { content: 'once', toolCalls: [] };
    });
    const bureau = await openBureau(script);
    await craft(bureau);

    const first = regenerate(bureau, CRAFTED, ANSWER);
    const second = regenerate(bureau, CRAFTED, ANSWER);
    await waitForCondition(() => script.regenerations === 1, 'the model is asked');
    release();
    const [one, two] = await Promise.all([first, second]);

    expect(one).toEqual(two);
    expect(script.regenerations).toBe(1);
  });

  it('answers a retry after a restart from the ledger, without asking the model', async () => {
    const storage = new MemoryStorage();
    const script = newScript();
    const before = await openBureau(script, storage);
    await craft(before);
    const first = await regenerate(before, CRAFTED, ANSWER);
    await waitForCondition(async () => !(await receiptPending(before)), 'the receipt is drained');
    await cleanups.pop()!();

    const restartedScript = newScript();
    const restarted = await openBureau(restartedScript, storage);
    const retry = await regenerate(restarted, CRAFTED, ANSWER);

    expect(retry).toEqual(first);
    expect(restartedScript.regenerations).toBe(0);
  });

  it('answers a duplicate whose first attempt is pending with no receipt as in doubt, never asking the model', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    const before = await craft(bureau);
    await ledgerOf(bureau).claim(
      identityOf('in-flight'),
      digestCommandPayload({ messageId: ANSWER }),
      { incarnation: before.incarnation, revision: before.revision },
    );

    expect(await refusalOf(regenerate(bureau, CRAFTED, ANSWER, 'in-flight'))).toBe(
      'command-in-doubt',
    );

    expect(script.regenerations).toBe(0);
    expect(await bureau.contexts.get(CRAFTED)).toEqual(before);
  });

  it('completes a pending command from the receipt its first attempt committed, then answers it without the model', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    const before = await craft(bureau);
    const ledger = ledgerOf(bureau);
    const identity = identityOf('crashed');
    const payloadDigest = digestCommandPayload({ messageId: ANSWER });
    await ledger.claim(identity, payloadDigest, {
      incarnation: before.incarnation,
      revision: before.revision,
    });
    const result = {
      contextId: CRAFTED,
      messageId: ANSWER,
      incarnation: before.incarnation,
      previousRevision: before.revision,
      revision: before.revision + 1,
    };
    // The first attempt committed its answer and receipt, then stopped before completing the ledger.
    await bureau.internals.sessionStore!.update(
      CRAFTED,
      (current) =>
        current === undefined
          ? undefined
          : replaceSessionAnswer(
              current,
              ANSWER,
              { ...current.conversationHistory.messages[ANSWER]!, content: 'committed answer' },
              new Date().toISOString(),
            ),
      {
        outbox: [
          {
            namespace: REGENERATE_RECEIPT_OUTBOX_NAMESPACE,
            payload: regenerateReceiptPayload({ identity, payloadDigest, result }),
          },
        ],
      },
    );

    await waitForCondition(
      async () => (await ledger.read(identity))?.state === 'completed',
      'the drain completes the command from its receipt',
    );
    await waitForCondition(
      async () => !(await receiptPending(bureau)),
      'the receipt is acknowledged',
    );
    const retry = await regenerate(bureau, CRAFTED, ANSWER, 'crashed');

    expect(retry).toEqual(result);
    expect(script.regenerations).toBe(0);
    const after = (await bureau.contexts.get(CRAFTED))!;
    expect(after.conversationHistory.messages[ANSWER]?.content).toBe('committed answer');
  });

  it('never completes a pending command from a receipt that names another payload', async () => {
    const script = newScript();
    const bureau = await openBureau(script);
    const before = await craft(bureau);
    const ledger = ledgerOf(bureau);
    const identity = identityOf('forged');
    const payloadDigest = digestCommandPayload({ messageId: ANSWER });
    await ledger.claim(identity, payloadDigest, {
      incarnation: before.incarnation,
      revision: before.revision,
    });
    await bureau.internals.sessionStore!.update(CRAFTED, (current) => current, {
      outbox: [
        {
          namespace: REGENERATE_RECEIPT_OUTBOX_NAMESPACE,
          payload: regenerateReceiptPayload({
            identity,
            payloadDigest: 'a-forged-digest',
            result: {
              contextId: CRAFTED,
              messageId: ANSWER,
              incarnation: before.incarnation,
              previousRevision: before.revision,
              revision: before.revision + 1,
            },
          }),
        },
      ],
    });

    await waitForCondition(async () => !(await receiptPending(bureau)), 'the receipt is drained');

    expect((await ledger.read(identity))?.state).toBe('pending');
    expect(await refusalOf(regenerate(bureau, CRAFTED, ANSWER, 'forged'))).toBe('command-in-doubt');
    expect(script.regenerations).toBe(0);
  });
});

const catalogRows = createModelCatalog().descriptors;

/** The default catalog's row for `choice`: the one row a fixed agent's generate reports. */
function catalogRow(choice: {
  readonly provider: string;
  readonly model: string;
}): BackendDescriptor {
  const found = catalogRows.find(
    (row) => row.provider === choice.provider && row.model === choice.model,
  );
  if (found === undefined)
    throw new Error(`The catalog has no ${choice.provider}/${choice.model}.`);
  return found;
}

/**
 * A Bureau whose agent, `agent`, is a code agent that serves `row` alone, under `modelPolicy`. Each
 * call it takes is recorded in `calls`.
 */
async function openFixedBureau(
  row: BackendDescriptor,
  modelPolicy: BureauModelPolicyOptions,
  calls: string[],
) {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      agent: createAgent({
        name: 'agent',
        generate: withBackendDescriptors(async () => {
          calls.push(row.model);
          return { content: 'a better answer', toolCalls: [] };
        }, [row]),
      }),
    },
    storage: new MemoryStorage(),
    durable: true,
    modelPolicy,
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

/** What `pending` rejected with, or `undefined` when it resolved. */
async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

describe('a regeneration under the Bureau’s invariants', () => {
  it('refuses a code agent whose model the policy forbids, and never calls the model', async () => {
    const calls: string[] = [];
    const bureau = await openFixedBureau(
      catalogRow(OPUS_5_5),
      { deployment: { deniedModels: [OPUS_5_5.model] }, policyRevision: 2 },
      calls,
    );
    const before = await craft(bureau);

    const error = await rejectionOf(regenerate(bureau, CRAFTED, ANSWER));

    expect(error).toBeInstanceOf(SessionRegenerateRefusedError);
    expect((error as SessionRegenerateRefusedError).reason).toBe('generation-failed');
    expect((error as Error).cause).toBeInstanceOf(ModelPolicyDeniedError);
    expect(calls).toEqual([]);
    expect(await bureau.contexts.get(CRAFTED)).toEqual(before);
    expect(await receiptPending(bureau)).toBe(false);
  });

  it('asks a code agent whose model the policy allows, once', async () => {
    const calls: string[] = [];
    const bureau = await openFixedBureau(
      catalogRow(OPUS_5_5),
      { bureau: { deniedModels: [OPUS_5.model] }, policyRevision: 3 },
      calls,
    );
    await craft(bureau);

    await regenerate(bureau, CRAFTED, ANSWER);

    expect(calls).toEqual([OPUS_5_5.model]);
    const after = (await bureau.contexts.get(CRAFTED))!;
    expect(after.conversationHistory.messages[ANSWER]?.content).toBe('a better answer');
  });

  it('refuses an answer the output guardrail halts, and stores nothing', async () => {
    const script = newScript(async () => ({
      content: 'Write to jane.doe@example.com for the details.',
      toolCalls: [],
    }));
    const bureau = await openBureau(script);
    const before = await craft(bureau);

    const error = await rejectionOf(regenerate(bureau, CRAFTED, ANSWER));

    expect(error).toBeInstanceOf(SessionRegenerateRefusedError);
    expect((error as SessionRegenerateRefusedError).reason).toBe('generation-failed');
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(GuardrailTripwireError);
    expect((cause as GuardrailTripwireError).guardrailName).toBe('output-pii');
    expect(script.regenerations).toBe(1);
    const after = (await bureau.contexts.get(CRAFTED))!;
    expect(after.conversationHistory).toEqual(before.conversationHistory);
    expect(await receiptPending(bureau)).toBe(false);
  });

  it('asks a first step’s answer again with the Bureau’s identity prompt, as the run asked it', async () => {
    const script = newScript();
    const bureau = await createBureau<AgentDefinitions>({
      agents: { agent: scriptedAgent(script) },
      storage: new MemoryStorage(),
      durable: true,
      identity: { resolve: async () => 'Corvidae identity prompt.' },
    });
    cleanups.push(() => bureau.dispose());
    const firstStep = `${R}:step:0`;
    await craft(bureau, [
      {
        runId: R,
        rows: [
          { id: `${R}:user`, role: 'user', content: 'go' },
          { id: firstStep, role: 'assistant', content: 'old answer' },
        ],
      },
    ]);

    await regenerate(bureau, CRAFTED, firstStep);

    expect(script.regenerations).toBe(1);
    const asked = Object.values(script.asked[0]?.messages ?? {});
    expect(
      asked.filter((message) => message.role === 'system').map((message) => message.content),
    ).toEqual(['Corvidae identity prompt.']);
    const after = (await bureau.contexts.get(CRAFTED))!;
    expect(after.conversationHistory.messages[firstStep]?.content).toBe('a better answer');
  });
});
