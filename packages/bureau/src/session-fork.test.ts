/**
 * COR-1560 — `BureauContexts.fork` branches a session after a completed agent reply: the new session
 * shares the history through that reply, is owned by the caller, records where it came from, and
 * keeps the parent's model choice. A `commandId` makes it idempotent across restarts, and a crash
 * between its steps never forks twice.
 */
import { createAgent, createAgentSession, stopWhen } from '@lostgradient/operative';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';
import { createConversationHistory, Conversation } from 'conversationalist';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { createCommandLedger, digestCommandPayload } from './command-ledger';
import {
  createForkLedger,
  FORK_LEDGER_KEY_PREFIX,
  FORK_OPERATION_VERSION,
  type ForkLedgerClaim,
  SessionForkRefusedError,
} from './session-fork';
import { waitForCondition, waitForTaskState } from './test';
import { approvalToolbox } from './http/management/management-fixtures.test-support';
import { noopTool, OPUS_5, OPUS_5_5 } from './testing/model-override.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { startFileBureau } from './testing/agent-file-bureau.test-support';
import type { Bureau, BureauContexts } from './types';
import { startTaskFrom } from './test/task-start-request.ts';
import { MemoryStorage } from '@lostgradient/storage';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

type Behavior = 'complete' | 'fail-second-step' | 'hold-second-step';

/** An agent that thinks (a tool call and text), then answers, or fails or hangs at its second step. */
function twoStepAgent(behavior: Behavior = 'complete', onSecondStep?: () => void) {
  return createAgent({
    name: 'two-step',
    tools: { noop: noopTool },
    allowedCandidates: [OPUS_5_5, OPUS_5],
    generate: async (context) => {
      const history = context.conversation.current;
      const last = history.messages[history.ids.at(-1) ?? ''];
      if (last?.toolResult === undefined) {
        return {
          content: 'thinking',
          toolCalls: [{ id: `c-${history.ids.length}`, name: 'noop', arguments: {} }],
        };
      }
      onSecondStep?.();
      if (behavior === 'fail-second-step') throw new Error('the model failed');
      if (behavior === 'hold-second-step') {
        await new Promise<never>((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      return { content: `answer ${history.ids.length}`, toolCalls: [] };
    },
  });
}

async function openBureau(
  options: { agent?: ReturnType<typeof twoStepAgent>; path?: string } = {},
) {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      agent: options.agent ?? twoStepAgent(),
    },
    storage:
      options.path === undefined ? { type: 'memory' } : { type: 'sqlite', path: options.path },
    durable: true,
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

const ALICE = 'alice';

/** Waits until the stored session holds `messageId`; a run's messages arrive just after it settles. */
async function waitForStoredMessage(
  bureau: Bureau<AgentDefinitions>,
  sessionId: string,
  messageId: string,
) {
  await waitForCondition(async () => {
    const stored = await bureau.contexts.get(sessionId);
    return stored?.conversationHistory.ids.includes(messageId) === true;
  }, `message ${messageId} stored`);
}

async function completedSession(
  bureau: Bureau<AgentDefinitions>,
  sessionId?: string,
  message = 'go',
  lastStep = 1,
) {
  const run = await startTaskFrom(bureau, {
    input: message,
    agentName: 'agent',
    principal: ALICE,
    ...(sessionId === undefined ? {} : { contextId: sessionId }),
  });
  await waitForTaskState(bureau, run.id);
  await waitForStoredMessage(bureau, run.contextId, `${run.id}:step:${lastStep}`);
  return run;
}

const finalAssistantOf = (runId: string) => `${runId}:step:1`;

const fork = (
  bureau: { readonly contexts: Pick<BureauContexts, 'fork'> },
  sessionId: string,
  throughMessageId: string,
  commandId = 'fork-1',
  owner = ALICE,
) => bureau.contexts.fork(sessionId, { owner, commandId, throughMessageId });

async function refusalOf(pending: Promise<unknown>): Promise<string> {
  const error = await pending.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof SessionForkRefusedError)) return `not a refusal: ${String(error)}`;
  return error.reason;
}

/** Records the claim a first attempt of `commandId` made, as if it died before forking. */
async function claimFork(
  bureau: Bureau<AgentDefinitions>,
  run: { id: string; contextId: string },
  commandId: string,
  claim: ForkLedgerClaim,
) {
  const ledger = createForkLedger(bureau.internals.kv, {
    clock: { now: () => Date.now(), nowISO: () => new Date().toISOString() },
    identifiers: { next: () => crypto.randomUUID() },
  });
  await ledger.claim(
    {
      callerId: ALICE,
      target: run.contextId,
      requestId: commandId,
      operationVersion: FORK_OPERATION_VERSION,
    },
    digestCommandPayload({ throughMessageId: `${run.id}:step:0` }),
    claim,
  );
}

async function sessionCount(bureau: Bureau<AgentDefinitions>): Promise<number> {
  const sessions = await bureau.contexts.list({ limit: 100 });
  return sessions.length;
}

describe('a fork after a completed reply', () => {
  it('shares the history through that reply, leaves the parent alone, and is owned by the caller', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const parentBefore = await bureau.contexts.get(run.contextId);

    const result = await fork(bureau, run.contextId, finalAssistantOf(run.id));

    expect(result.carriedOverride).toBeNull();
    const child = await bureau.contexts.get(result.contextId);
    const parent = await bureau.contexts.get(run.contextId);
    expect(child?.conversationHistory.ids).toEqual(parentBefore?.conversationHistory.ids);
    expect(parent?.conversationHistory).toEqual(parentBefore?.conversationHistory);
    expect(parent?.metadata).toEqual(parentBefore?.metadata);
    expect(child?.metadata['sessionOwner']).toBe(ALICE);
  });

  it('records the lineage and lists the fork for its owner before it has a run', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);

    const result = await fork(bureau, run.contextId, finalAssistantOf(run.id));

    const rows = await bureau.contexts.list({ owner: ALICE });
    expect(rows.find((row) => row.id === result.contextId)).toMatchObject({
      parentContextId: run.contextId,
      forkedFromMessageId: finalAssistantOf(run.id),
      owner: ALICE,
    });
  });

  it('never lets a message of a later run into the fork', async () => {
    const bureau = await openBureau();
    const first = await completedSession(bureau);
    const second = await completedSession(bureau, first.contextId, 'and again');

    const result = await fork(bureau, first.contextId, finalAssistantOf(first.id));

    const child = await bureau.contexts.get(result.contextId);
    const ids = child?.conversationHistory.ids ?? [];
    expect(ids.at(-1)).toBe(finalAssistantOf(first.id));
    expect(ids.some((id) => id.startsWith(second.id))).toBe(false);
    const parent = await bureau.contexts.get(first.contextId);
    expect(parent?.conversationHistory.ids.some((id) => id.startsWith(second.id))).toBe(true);
  });

  it('can be run on: the fork continues from the shared history', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const result = await fork(bureau, run.contextId, finalAssistantOf(run.id));

    const next = await completedSession(bureau, result.contextId, 'a different follow-up');

    const child = await bureau.contexts.get(result.contextId);
    expect(child?.conversationHistory.ids.at(-1)).toBe(finalAssistantOf(next.id));
    const parent = await bureau.contexts.get(run.contextId);
    expect(parent?.conversationHistory.ids).not.toContain(finalAssistantOf(next.id));
  });
});

describe('the command identifier', () => {
  it('answers an exact retry with the original result and creates nothing more', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const first = await fork(bureau, run.contextId, finalAssistantOf(run.id));
    const count = await sessionCount(bureau);

    const retry = await fork(bureau, run.contextId, finalAssistantOf(run.id));

    expect(retry).toEqual(first);
    expect(await sessionCount(bureau)).toBe(count);
  });

  it('answers the same command with another message as a conflict, and creates nothing', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const second = await completedSession(bureau, run.contextId, 'again');
    await fork(bureau, run.contextId, finalAssistantOf(run.id));
    const count = await sessionCount(bureau);

    const reason = await refusalOf(fork(bureau, run.contextId, finalAssistantOf(second.id)));

    expect(reason).toBe('command-conflict');
    expect(await sessionCount(bureau)).toBe(count);
  });

  it('answers an exact retry after a restart with the original result, forking once', async () => {
    const path = createTemporaryPath('fork-restart', '.sqlite');
    cleanups.push(() => removeTemporaryPath(path));
    const bureau = await openBureau({ path });
    const run = await completedSession(bureau);
    const first = await fork(bureau, run.contextId, finalAssistantOf(run.id));
    await bureau.dispose();

    const restarted = await openBureau({ path });
    const retry = await fork(restarted, run.contextId, finalAssistantOf(run.id));

    expect(retry).toEqual(first);
    expect(await sessionCount(restarted)).toBe(2);
  });
});

describe('a parent deleted while it is being branched', () => {
  it('refuses the command as message-not-found, creates nothing, never resurrects the parent, and answers a retry the same way', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const store = bureau.internals.sessionStore!;
    const load = store.load.bind(store);
    let loads = 0;
    // The parent is read once to check the branch point, and once more by the fork itself: the
    // deletion lands exactly between the two.
    store.load = async (id: string) => {
      loads += 1;
      if (id === run.contextId && loads === 2) await bureau.contexts.delete(run.contextId);
      return load(id);
    };

    const first = await refusalOf(fork(bureau, run.contextId, finalAssistantOf(run.id)));
    const retry = await refusalOf(fork(bureau, run.contextId, finalAssistantOf(run.id)));

    expect(first).toBe('message-not-found');
    expect(retry).toBe('message-not-found');
    expect(await bureau.contexts.get(run.contextId)).toBeUndefined();
    expect(await sessionCount(bureau)).toBe(0);
  });
});

describe('a message that is not a branch point', () => {
  it('refuses a message the history does not hold, and one of another session, creating nothing', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const other = await completedSession(bureau);
    const count = await sessionCount(bureau);

    expect(await refusalOf(fork(bureau, run.contextId, 'no-such-message', 'a'))).toBe(
      'message-not-found',
    );
    expect(await refusalOf(fork(bureau, run.contextId, finalAssistantOf(other.id), 'b'))).toBe(
      'message-not-found',
    );
    expect(await sessionCount(bureau)).toBe(count);
  });

  it('refuses a message that is not an assistant step: a user message, a result row, an earlier step', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const session = await bureau.contexts.get(run.contextId);
    const ids = session!.conversationHistory.ids;
    const count = await sessionCount(bureau);

    expect(ids[0]).toBeDefined();
    for (const [index, id] of [
      ids[0]!,
      `${run.id}:step:0:result:c-1`,
      `${run.id}:step:0:call:c-1`,
      `${run.id}:step:0`,
    ].entries()) {
      expect(await refusalOf(fork(bureau, run.contextId, id, `c-${index}`))).toBe(
        'not-a-branch-point',
      );
    }
    expect(await sessionCount(bureau)).toBe(count);
  });

  it('refuses an assistant step whose run has no task record, as not a branch point', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    await bureau.internals.taskRegistry.remove(run.id);

    expect(await refusalOf(fork(bureau, run.contextId, finalAssistantOf(run.id)))).toBe(
      'not-a-branch-point',
    );
  });

  it('refuses an assistant step whose run belongs to another context', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const stranger = await completedSession(bureau);
    // A row that names the other session's run sits in this session's history.
    const session = (await bureau.contexts.get(run.contextId))!;
    const conversation = new Conversation(session.conversationHistory);
    conversation.appendMessages({
      role: 'assistant',
      content: 'planted',
      id: `${stranger.id}:step:9`,
    } as never);
    await bureau.internals.sessionStore!.save({
      ...session,
      conversationHistory: conversation.current,
    });

    expect(await refusalOf(fork(bureau, run.contextId, `${stranger.id}:step:9`))).toBe(
      'not-a-branch-point',
    );
  });

  it('refuses the final message of a run that errored', async () => {
    const failing = await openBureau({ agent: twoStepAgent('fail-second-step') });
    const errored = await completedSession(failing, undefined, 'go', 0);

    expect(await refusalOf(fork(failing, errored.contextId, `${errored.id}:step:0`))).toBe(
      'branch-from-errored-run',
    );
    expect(await sessionCount(failing)).toBe(1);
  });

  it('refuses the final message of a run that was aborted', async () => {
    const entered = Promise.withResolvers<void>();
    const holding = await openBureau({
      agent: twoStepAgent('hold-second-step', () => entered.resolve()),
    });
    const run = await holding.tasks.start('agent', 'go', { principal: ALICE });
    await entered.promise;
    await holding.tasks.cancel(run.id);
    await waitForTaskState(holding, run.id);
    await waitForStoredMessage(holding, run.contextId, `${run.id}:step:0`);

    expect(await refusalOf(fork(holding, run.contextId, `${run.id}:step:0`))).toBe(
      'branch-from-aborted-run',
    );
    expect(await sessionCount(holding)).toBe(1);
  });

  it('refuses a fork while the run still has a pending approval', async () => {
    const charges: number[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({
            content: 'charging',
            toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 100 } }],
          }),
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

    expect(await refusalOf(fork(bureau, run.contextId, `${run.id}:step:0`))).toBe(
      'branch-with-pending-approval',
    );
    expect(await sessionCount(bureau)).toBe(1);
  });

  /** One row of a crafted run: its id and role, and the call it makes or answers. */
  type CraftedRow = {
    readonly id: string;
    readonly role: 'user' | 'assistant' | 'tool-call' | 'tool-result';
    readonly content?: string;
    readonly call?: string;
  };

  /** A session holding exactly `rows`, and the registry's record of its one completed run. */
  async function craftRun(bureau: Bureau<AgentDefinitions>, runId: string, rows: CraftedRow[]) {
    const conversation = new Conversation(createConversationHistory());
    for (const row of rows) {
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
    await bureau.internals.sessionStore!.save(
      createAgentSession({
        id: 'crafted',
        agentName: 'agent',
        conversationHistory: conversation.current,
        metadata: { sessionOwner: ALICE },
        runs: [],
      }),
    );
    const saved = (await bureau.contexts.get('crafted'))!;
    await bureau.internals.taskRegistry.recordAdmission({
      taskId: runId,
      contextId: 'crafted',
      incarnation: saved.incarnation,
      agentName: 'agent',
      owner: ALICE,
      message: 'go',
    });
    await bureau.internals.taskRegistry.recordSettled(runId, {
      at: new Date().toISOString(),
      status: 'completed',
      finishReason: 'stop-condition',
      message: null,
    });
  }

  const R = 'run-crafted';
  const user: CraftedRow = { id: 'user-1', role: 'user', content: 'go' };
  const step0: CraftedRow[] = [
    { id: `${R}:step:0`, role: 'assistant', content: 'thinking' },
    { id: `${R}:step:0:call:c-1`, role: 'tool-call', call: 'c-1' },
    { id: `${R}:step:0:result:c-1`, role: 'tool-result', call: 'c-1' },
  ];

  it('refuses a fork when the final assistant message has a tool call with no result', async () => {
    const bureau = await openBureau();
    await craftRun(bureau, R, [
      user,
      { id: `${R}:step:0`, role: 'assistant', content: 'calling' },
      { id: `${R}:step:0:call:c-1`, role: 'tool-call', call: 'c-1' },
    ]);

    expect(await refusalOf(fork(bureau, 'crafted', `${R}:step:0`))).toBe(
      'branch-with-unresolved-tool-call',
    );
    expect(await sessionCount(bureau)).toBe(1);
  });

  it('judges a run by its steps: an earlier step is not a branch point, and a final step that is only a tool call with no result is an unresolved one', async () => {
    const bureau = await openBureau();
    // Step 0 is text and an answered call. Step 1 is a tool call only, so the call's row carries the
    // step's own id, and it has no result.
    await craftRun(bureau, R, [
      user,
      ...step0,
      { id: `${R}:step:1`, role: 'tool-call', call: 'c-2' },
    ]);

    expect(await refusalOf(fork(bureau, 'crafted', `${R}:step:0`, 'through-0'))).toBe(
      'not-a-branch-point',
    );
    expect(await refusalOf(fork(bureau, 'crafted', `${R}:step:1`, 'through-1'))).toBe(
      'branch-with-unresolved-tool-call',
    );
    expect(await sessionCount(bureau)).toBe(1);
  });

  it('refuses a final step that has no text, even when its call was answered', async () => {
    const bureau = await openBureau();
    await craftRun(bureau, R, [
      user,
      ...step0,
      { id: `${R}:step:1`, role: 'tool-call', call: 'c-2' },
      { id: `${R}:step:1:result:c-2`, role: 'tool-result', call: 'c-2' },
    ]);

    expect(await refusalOf(fork(bureau, 'crafted', `${R}:step:1`))).toBe('not-a-branch-point');
    expect(await refusalOf(fork(bureau, 'crafted', `${R}:step:0`, 'through-0'))).toBe(
      'not-a-branch-point',
    );
  });

  it('counts the first call of a final step with text and a call under its own id', async () => {
    const bureau = await openBureau();
    await craftRun(bureau, R, [
      user,
      { id: `${R}:step:0`, role: 'assistant', content: 'calling' },
      { id: `${R}:step:0:call:c-1`, role: 'tool-call', call: 'c-1' },
      { id: `${R}:step:0:result:c-1`, role: 'tool-result', call: 'c-1' },
      { id: `${R}:step:1`, role: 'assistant', content: 'done' },
    ]);

    const result = await fork(bureau, 'crafted', `${R}:step:1`);

    const child = await bureau.contexts.get(result.contextId);
    expect(child?.conversationHistory.ids.at(-1)).toBe(`${R}:step:1`);
  });
});

describe('the parent’s model choice', () => {
  const steer = (
    bureau: { readonly contexts: Pick<BureauContexts, 'steer'> },
    sessionId: string,
    choice: { provider: string; model: string },
  ) =>
    bureau.contexts.steer(sessionId, {
      id: 'switch',
      principal: ALICE,
      requestedValue: {
        target: 'model',
        override: choice.model,
        provider: choice.provider,
      } as never,
    });

  it('is admitted on the fork as <commandId>:model, and the outcome is returned beside the contextId', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const switched = await steer(bureau, run.contextId, OPUS_5);
    expect(switched.outcome).toBe('accepted');

    const result = await fork(bureau, run.contextId, finalAssistantOf(run.id), 'fork-9');

    expect(result.carriedOverride).toMatchObject({
      outcome: 'accepted',
      command: { id: 'fork-9:model', sessionId: result.contextId },
    });
    expect(await bureau.contexts.steering(result.contextId)).toEqual({
      model: { provider: 'anthropic', model: 'claude-opus-5' },
      configVersion: 1,
    });
    // The parent keeps its own, and an exact retry returns the same pair.
    const parentSteering = await bureau.contexts.steering(run.contextId);
    expect(parentSteering?.model).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
    expect(await fork(bureau, run.contextId, finalAssistantOf(run.id), 'fork-9')).toEqual(result);
  });

  it('carries nothing when the parent was never switched', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);

    const result = await fork(bureau, run.contextId, finalAssistantOf(run.id));

    expect(result.carriedOverride).toBeNull();
    const forkSteering = await bureau.contexts.steering(result.contextId);
    expect(forkSteering?.model).toBeNull();
  });

  it('survives a crash after the ledger recorded the contextId and before the fork existed', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    await steer(bureau, run.contextId, OPUS_5);
    // The first attempt claimed the command, naming the contextId, and died.
    const ledger = createCommandLedger({
      kv: bureau.internals.kv!,
      keyPrefix: FORK_LEDGER_KEY_PREFIX,
      clock: { now: () => Date.now(), nowISO: () => new Date().toISOString() },
      nextConflictId: () => crypto.randomUUID(),
    });
    await ledger.claim(
      {
        callerId: ALICE,
        target: run.contextId,
        requestId: 'crash-1',
        operationVersion: FORK_OPERATION_VERSION,
      },
      digestCommandPayload({ throughMessageId: finalAssistantOf(run.id) }),
      { contextId: 'planned-fork', override: { provider: 'anthropic', model: 'claude-opus-5' } },
    );

    const result = await fork(bureau, run.contextId, finalAssistantOf(run.id), 'crash-1');

    expect(result.contextId).toBe('planned-fork');
    expect(await sessionCount(bureau)).toBe(2);
    const planned = await bureau.contexts.steering('planned-fork');
    expect(planned?.model?.model).toBe('claude-opus-5');
  });

  it('survives a crash after the fork existed and before the override was admitted, forking once', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    await steer(bureau, run.contextId, OPUS_5);
    const ledger = createCommandLedger({
      kv: bureau.internals.kv!,
      keyPrefix: FORK_LEDGER_KEY_PREFIX,
      clock: { now: () => Date.now(), nowISO: () => new Date().toISOString() },
      nextConflictId: () => crypto.randomUUID(),
    });
    await ledger.claim(
      {
        callerId: ALICE,
        target: run.contextId,
        requestId: 'crash-2',
        operationVersion: FORK_OPERATION_VERSION,
      },
      digestCommandPayload({ throughMessageId: finalAssistantOf(run.id) }),
      { contextId: 'planned-fork', override: { provider: 'anthropic', model: 'claude-opus-5' } },
    );
    // The fork was made, then the process died.
    const { createSessionHandle } = await import('@lostgradient/operative');
    await createSessionHandle(run.contextId, {
      store: bureau.internals.sessionStore!,
      agentName: 'agent',
    }).fork({ throughMessageId: finalAssistantOf(run.id), id: 'planned-fork', owner: ALICE });
    const count = await sessionCount(bureau);

    const result = await fork(bureau, run.contextId, finalAssistantOf(run.id), 'crash-2');

    expect(result.contextId).toBe('planned-fork');
    expect(await sessionCount(bureau)).toBe(count);
    const planned = await bureau.contexts.steering('planned-fork');
    expect(planned?.model?.model).toBe('claude-opus-5');
    expect(await fork(bureau, run.contextId, finalAssistantOf(run.id), 'crash-2')).toEqual(result);
  });
});

describe('a parent whose model a policy profile chose', () => {
  const POLICY = {
    policyRevision: 1,
    users: { 'fast-tier': { exactOverride: { model: 'claude-opus-5' } } },
  };

  /** An opaque agent that records the model each of its steps was steered to. */
  async function openOpaque(durable: boolean) {
    const observed: Array<string | undefined> = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        agent: createAgent({
          name: 'opaque',
          generate: async (context) => {
            observed.push(context.steering?.model);
            return { content: 'answer', toolCalls: [] };
          },
        }),
      },
      storage: new MemoryStorage(),
      modelPolicy: POLICY,
      ...(durable ? { durable: true } : {}),
    });
    cleanups.push(() => bureau.dispose());
    const run = await bureau.tasks.start('agent', 'go', { principal: ALICE });
    await waitForTaskState(bureau, run.id);
    await waitForStoredMessage(bureau, run.contextId, `${run.id}:step:0`);
    return { bureau, run, observed };
  }

  const throughOf = (run: { id: string }) => `${run.id}:step:0`;

  it.each([
    ['a durable Bureau', true],
    ['an in-process Bureau', false],
  ])('carries the model onto the fork of %s, and the fork runs on it', async (_name, durable) => {
    const { bureau, run, observed } = await openOpaque(durable);
    const chosen = await bureau.contexts.steer(run.contextId, {
      id: 'by-policy',
      principal: ALICE,
      requestedValue: { target: 'model', policyRef: 'fast-tier' },
    });
    expect(chosen.outcome).toBe('accepted');

    const result = await fork(bureau, run.contextId, throughOf(run));

    expect(result.carriedOverride).toMatchObject({ outcome: 'accepted' });
    const steering = await bureau.contexts.steering(result.contextId);
    expect(steering?.model?.model).toBe('claude-opus-5');
    const next = await completedSession(bureau, result.contextId, 'again', 0);
    expect(next.contextId).toBe(result.contextId);
    expect(observed.at(-1)).toBe('claude-opus-5');
  });

  it('carries the policy request, as the parent made it, when a claim names it', async () => {
    const { bureau, run } = await openOpaque(true);
    await claimFork(bureau, run, 'policy-claim', {
      contextId: 'planned-fork',
      override: { provider: null, model: 'claude-opus-5', policyRef: 'fast-tier' },
    });

    const result = await fork(bureau, run.contextId, throughOf(run), 'policy-claim');

    expect(result.carriedOverride).toMatchObject({
      outcome: 'accepted',
      command: { requestedValue: { target: 'model', override: 'claude-opus-5' } },
    });
  });

  it('still forks when the policy now refuses the carried request, and says so', async () => {
    const { bureau, run } = await openOpaque(true);
    await claimFork(bureau, run, 'gone-claim', {
      contextId: 'planned-fork',
      override: { provider: null, model: 'claude-opus-5', policyRef: 'retired-profile' },
    });

    const result = await fork(bureau, run.contextId, throughOf(run), 'gone-claim');

    expect(result.carriedOverride).toMatchObject({
      outcome: 'rejected',
      failure: { reason: 'policy-denied' },
    });
    const created = await bureau.contexts.get(result.contextId);
    expect(created?.id).toBe('planned-fork');
  });

  it('forgets a policy request with its session: a command id reused after a delete carries what the new session asked for', async () => {
    // In-process, the submitted `policyRef` is kept beside the steering gate. Deleting the session
    // purges its ledger entries, so the same command id is free again; a fork of the next session
    // must carry that session's explicit choice, not the deleted session's policy.
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        agent: createAgent({
          name: 'picker',
          generate: async () => ({ content: 'answer', toolCalls: [] }),
          allowedCandidates: [OPUS_5_5, OPUS_5],
        }),
      },
      storage: new MemoryStorage(),
      modelPolicy: POLICY,
    });
    cleanups.push(() => bureau.dispose());
    const first = await completedSession(bureau, undefined, 'go', 0);
    const byPolicy = await bureau.contexts.steer(first.contextId, {
      id: 'm1',
      principal: ALICE,
      requestedValue: { target: 'model', policyRef: 'fast-tier' },
    });
    expect(byPolicy.outcome).toBe('accepted');
    await bureau.contexts.delete(first.contextId);

    const second = await completedSession(bureau, undefined, 'go', 0);
    const explicit = await bureau.contexts.steer(second.contextId, {
      id: 'm1',
      principal: ALICE,
      requestedValue: { target: 'model', override: OPUS_5_5.model, provider: OPUS_5_5.provider },
    });
    expect(explicit.outcome).toBe('accepted');

    const result = await fork(bureau, second.contextId, throughOf(second));

    const child = await bureau.contexts.steering(result.contextId);
    expect(child?.model?.model).toBe(OPUS_5_5.model);
  });

  it('reads a claim written before it could name a policy as an explicit override', async () => {
    const { bureau, run } = await openOpaque(true);
    await claimFork(bureau, run, 'old-claim', {
      contextId: 'planned-fork',
      override: { provider: 'anthropic', model: 'claude-opus-5' },
    });

    const result = await fork(bureau, run.contextId, throughOf(run), 'old-claim');

    // An explicit override for an opaque agent is refused, which is what an old claim meant.
    expect(result.carriedOverride).toMatchObject({
      outcome: 'rejected',
      failure: { reason: 'model-not-allowed' },
    });
    const created = await bureau.contexts.get(result.contextId);
    expect(created?.id).toBe('planned-fork');
  });
});

describe('a file agent’s fork', () => {
  const PICKER = (models: string) =>
    agentFileText({ model: KNOWN_MODEL, models, tools: '[lookup-order]' });

  async function startPicker() {
    const harness = await startFileBureau();
    cleanups.push(() => harness.dispose());
    await harness.put('picker.md', PICKER(`[${KNOWN_MODEL}, anthropic/claude-opus-5]`));
    await harness.bureau.agents.refresh();
    const run = await harness.bureau.tasks.start('picker', 'go', { principal: ALICE });
    await waitForTaskState(harness.bureau, run.id);
    return { harness, run };
  }

  const switchTo = (
    harness: Awaited<ReturnType<typeof startPicker>>['harness'],
    sessionId: string,
  ) =>
    harness.bureau.contexts.steer(sessionId, {
      id: 'switch',
      principal: ALICE,
      requestedValue: {
        target: 'model',
        override: 'claude-opus-5',
        provider: 'anthropic',
      } as never,
    });

  it('carries the parent’s model override to the fork', async () => {
    const { harness, run } = await startPicker();
    const switched = await switchTo(harness, run.contextId);
    expect(switched.outcome).toBe('accepted');

    const result = await harness.bureau.contexts.fork(run.contextId, {
      owner: ALICE,
      commandId: 'file-fork',
      throughMessageId: `${run.id}:step:0`,
    });

    expect(result.carriedOverride).toMatchObject({ outcome: 'accepted' });
    const carried = await harness.bureau.contexts.steering(result.contextId);
    expect(carried?.model).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
  });

  it('still forks when the carried override is no longer allowed, and the fork runs on the default', async () => {
    const { harness, run } = await startPicker();
    await switchTo(harness, run.contextId);
    // The file is edited by hand: the model the session was switched to is no longer listed.
    await harness.put('picker.md', PICKER(`[${KNOWN_MODEL}]`));
    await harness.bureau.agents.refresh();
    const args = {
      owner: ALICE,
      commandId: 'file-fork-2',
      throughMessageId: `${run.id}:step:0`,
    };

    const result = await harness.bureau.contexts.fork(run.contextId, args);

    expect(result.carriedOverride).toMatchObject({
      outcome: 'rejected',
      failure: { reason: 'model-not-allowed' },
    });
    const afterRefusal = await harness.bureau.contexts.steering(result.contextId);
    expect(afterRefusal?.model).toBeNull();
    expect(await harness.bureau.contexts.fork(run.contextId, args)).toEqual(result);
  });
});
