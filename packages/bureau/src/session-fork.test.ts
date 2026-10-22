/**
 * COR-1560 — `Bureau.forkSession` branches a session after a completed agent reply: the new session
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
  FORK_LEDGER_KEY_PREFIX,
  FORK_OPERATION_VERSION,
  SessionForkRefusedError,
} from './session-fork';
import { waitForRunState } from './test';
import { approvalToolbox } from './http/management/management-fixtures.test-support';
import { noopTool, OPUS_5, OPUS_5_5 } from './testing/model-override.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { startFileBureau } from './testing/agent-file-bureau.test-support';
import type { Bureau } from './types';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

type Behavior = 'complete' | 'fail-second-step' | 'hold-second-step';

/** An agent that thinks (a tool call and text), then answers, or fails or hangs at its second step. */
function twoStepAgent(behavior: Behavior = 'complete') {
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
    agents: { agent: options.agent ?? twoStepAgent() },
    stopWhen: stopWhen.noToolCalls(),
    storage:
      options.path === undefined ? { type: 'memory' } : { type: 'sqlite', path: options.path },
    durableExecution: true,
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

const ALICE = 'alice';

async function completedSession(
  bureau: Bureau<AgentDefinitions>,
  sessionId?: string,
  message = 'go',
) {
  const run = await bureau.createRun({
    message,
    agentName: 'agent',
    principal: ALICE,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  await waitForRunState(bureau, run.id);
  // The run's messages reach the stored session just after the run settles.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const stored = await bureau.getSession(run.sessionId);
    if (stored?.conversationHistory.ids.includes(`${run.id}:step:1`)) break;
    await Bun.sleep(10);
  }
  return run;
}

const finalAssistantOf = (runId: string) => `${runId}:step:1`;

const fork = (
  bureau: Pick<Bureau, 'forkSession'>,
  sessionId: string,
  throughMessageId: string,
  commandId = 'fork-1',
  owner = ALICE,
) => bureau.forkSession(sessionId, { owner, commandId, throughMessageId });

async function refusalOf(pending: Promise<unknown>): Promise<string> {
  const error = await pending.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof SessionForkRefusedError)) return `not a refusal: ${String(error)}`;
  return error.reason;
}

async function sessionCount(bureau: Bureau<AgentDefinitions>): Promise<number> {
  const sessions = await bureau.listSessions({ limit: 100 });
  return sessions.length;
}

describe('a fork after a completed reply', () => {
  it('shares the history through that reply, leaves the parent alone, and is owned by the caller', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const parentBefore = await bureau.getSession(run.sessionId);

    const result = await fork(bureau, run.sessionId, finalAssistantOf(run.id));

    expect(result.carriedOverride).toBeNull();
    const child = await bureau.getSession(result.contextId);
    const parent = await bureau.getSession(run.sessionId);
    expect(child?.conversationHistory.ids).toEqual(parentBefore?.conversationHistory.ids);
    expect(parent?.conversationHistory).toEqual(parentBefore?.conversationHistory);
    expect(parent?.metadata).toEqual(parentBefore?.metadata);
    expect(child?.metadata['sessionOwner']).toBe(ALICE);
  });

  it('records the lineage and lists the fork for its owner before it has a run', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);

    const result = await fork(bureau, run.sessionId, finalAssistantOf(run.id));

    const rows = await bureau.listSessions({ owner: ALICE });
    expect(rows.find((row) => row.id === result.contextId)).toMatchObject({
      parentContextId: run.sessionId,
      forkedFromMessageId: finalAssistantOf(run.id),
      owner: ALICE,
    });
  });

  it('never lets a message of a later run into the fork', async () => {
    const bureau = await openBureau();
    const first = await completedSession(bureau);
    const second = await completedSession(bureau, first.sessionId, 'and again');

    const result = await fork(bureau, first.sessionId, finalAssistantOf(first.id));

    const child = await bureau.getSession(result.contextId);
    const ids = child?.conversationHistory.ids ?? [];
    expect(ids.at(-1)).toBe(finalAssistantOf(first.id));
    expect(ids.some((id) => id.startsWith(second.id))).toBe(false);
    const parent = await bureau.getSession(first.sessionId);
    expect(parent?.conversationHistory.ids.some((id) => id.startsWith(second.id))).toBe(true);
  });

  it('can be run on: the fork continues from the shared history', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const result = await fork(bureau, run.sessionId, finalAssistantOf(run.id));

    const next = await completedSession(bureau, result.contextId, 'a different follow-up');

    const child = await bureau.getSession(result.contextId);
    expect(child?.conversationHistory.ids.at(-1)).toBe(finalAssistantOf(next.id));
    const parent = await bureau.getSession(run.sessionId);
    expect(parent?.conversationHistory.ids).not.toContain(finalAssistantOf(next.id));
  });
});

describe('the command identifier', () => {
  it('answers an exact retry with the original result and creates nothing more', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const first = await fork(bureau, run.sessionId, finalAssistantOf(run.id));
    const count = await sessionCount(bureau);

    const retry = await fork(bureau, run.sessionId, finalAssistantOf(run.id));

    expect(retry).toEqual(first);
    expect(await sessionCount(bureau)).toBe(count);
  });

  it('answers the same command with another message as a conflict, and creates nothing', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const second = await completedSession(bureau, run.sessionId, 'again');
    await fork(bureau, run.sessionId, finalAssistantOf(run.id));
    const count = await sessionCount(bureau);

    const reason = await refusalOf(fork(bureau, run.sessionId, finalAssistantOf(second.id)));

    expect(reason).toBe('command-conflict');
    expect(await sessionCount(bureau)).toBe(count);
  });

  it('answers an exact retry after a restart with the original result, forking once', async () => {
    const path = createTemporaryPath('fork-restart', '.sqlite');
    cleanups.push(() => removeTemporaryPath(path));
    const bureau = await openBureau({ path });
    const run = await completedSession(bureau);
    const first = await fork(bureau, run.sessionId, finalAssistantOf(run.id));
    await bureau.dispose();

    const restarted = await openBureau({ path });
    const retry = await fork(restarted, run.sessionId, finalAssistantOf(run.id));

    expect(retry).toEqual(first);
    expect(await sessionCount(restarted)).toBe(2);
  });
});

describe('a message that is not a branch point', () => {
  it('refuses a message the history does not hold, and one of another session, creating nothing', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const other = await completedSession(bureau);
    const count = await sessionCount(bureau);

    expect(await refusalOf(fork(bureau, run.sessionId, 'no-such-message', 'a'))).toBe(
      'message-not-found',
    );
    expect(await refusalOf(fork(bureau, run.sessionId, finalAssistantOf(other.id), 'b'))).toBe(
      'message-not-found',
    );
    expect(await sessionCount(bureau)).toBe(count);
  });

  it('refuses a message that is not an assistant step: a user message, a result row, an earlier step', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const session = await bureau.getSession(run.sessionId);
    const ids = session!.conversationHistory.ids;
    const count = await sessionCount(bureau);

    expect(ids[0]).toBeDefined();
    for (const [index, id] of [
      ids[0]!,
      `${run.id}:step:0:result:c-1`,
      `${run.id}:step:0:call:c-1`,
      `${run.id}:step:0`,
    ].entries()) {
      expect(await refusalOf(fork(bureau, run.sessionId, id, `c-${index}`))).toBe(
        'not-a-branch-point',
      );
    }
    expect(await sessionCount(bureau)).toBe(count);
  });

  it('refuses an assistant step whose run has no task record, as not a branch point', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    await bureau.tasks.remove(run.id);

    expect(await refusalOf(fork(bureau, run.sessionId, finalAssistantOf(run.id)))).toBe(
      'not-a-branch-point',
    );
  });

  it('refuses an assistant step whose run belongs to another context', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    const stranger = await completedSession(bureau);
    // A row that names the other session's run sits in this session's history.
    const session = (await bureau.getSession(run.sessionId))!;
    const conversation = new Conversation(session.conversationHistory);
    conversation.appendMessages({
      role: 'assistant',
      content: 'planted',
      id: `${stranger.id}:step:9`,
    } as never);
    await bureau.sessionStore!.save({ ...session, conversationHistory: conversation.current });

    expect(await refusalOf(fork(bureau, run.sessionId, `${stranger.id}:step:9`))).toBe(
      'not-a-branch-point',
    );
  });

  it('refuses the final message of a run that errored, and of one that was aborted', async () => {
    const failing = await openBureau({ agent: twoStepAgent('fail-second-step') });
    const errored = await completedSession(failing);
    const holding = await openBureau({ agent: twoStepAgent('hold-second-step') });
    const run = await holding.createRun({
      message: 'go',
      agentName: 'agent',
      principal: ALICE,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    holding.abortRun(run.id);
    await waitForRunState(holding, run.id);

    expect(await refusalOf(fork(failing, errored.sessionId, `${errored.id}:step:0`))).toBe(
      'branch-from-errored-run',
    );
    expect(await refusalOf(fork(holding, run.sessionId, `${run.id}:step:0`))).toBe(
      'branch-from-aborted-run',
    );
    expect(await sessionCount(failing)).toBe(1);
    expect(await sessionCount(holding)).toBe(1);
  });

  it('refuses a fork while the run still has a pending approval', async () => {
    const charges: number[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {},
      generate: async () => ({
        content: 'charging',
        toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 100 } }],
      }),
      toolbox: approvalToolbox(charges),
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    cleanups.push(() => bureau.dispose());
    const run = await bureau.createRun({ message: 'go', principal: ALICE });
    await waitForRunState(bureau, run.id);

    expect(await refusalOf(fork(bureau, run.sessionId, `${run.id}:step:0`))).toBe(
      'branch-with-pending-approval',
    );
    expect(await sessionCount(bureau)).toBe(1);
  });

  it('refuses a fork when the final assistant message has a tool call with no result', async () => {
    const bureau = await openBureau();
    const runId = 'run-crafted';
    const conversation = new Conversation(createConversationHistory());
    conversation.appendMessages({ role: 'user', content: 'go', id: 'user-1' } as never);
    conversation.appendMessages({
      role: 'assistant',
      content: 'calling',
      id: `${runId}:step:0`,
    } as never);
    conversation.appendMessages({
      role: 'tool-call',
      content: '',
      id: `${runId}:step:0:call:c-1`,
      toolCall: { id: 'c1', name: 'noop', arguments: {} },
    } as never);
    const session = createAgentSession({
      id: 'crafted',
      agentName: 'agent',
      conversationHistory: conversation.current,
      metadata: { sessionOwner: ALICE },
      runs: [],
    });
    await bureau.sessionStore!.save(session);
    const saved = (await bureau.getSession('crafted'))!;
    await bureau.tasks.recordAdmission({
      taskId: runId,
      contextId: 'crafted',
      incarnation: saved.incarnation,
      agentName: 'agent',
      owner: ALICE,
      message: 'go',
    });
    await bureau.tasks.recordSettled(runId, {
      at: new Date().toISOString(),
      status: 'completed',
      finishReason: 'stop-condition',
      message: null,
    });

    expect(await refusalOf(fork(bureau, 'crafted', `${runId}:step:0`))).toBe(
      'branch-with-unresolved-tool-call',
    );
    expect(await sessionCount(bureau)).toBe(1);
  });
});

describe('the parent’s model choice', () => {
  const steer = (
    bureau: Pick<Bureau, 'submitSteeringCommand'>,
    sessionId: string,
    choice: { provider: string; model: string },
  ) =>
    bureau.submitSteeringCommand(sessionId, {
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
    const switched = await steer(bureau, run.sessionId, OPUS_5);
    expect(switched.outcome).toBe('accepted');

    const result = await fork(bureau, run.sessionId, finalAssistantOf(run.id), 'fork-9');

    expect(result.carriedOverride).toMatchObject({
      outcome: 'accepted',
      command: { id: 'fork-9:model', sessionId: result.contextId },
    });
    expect(await bureau.getSessionSteering(result.contextId)).toEqual({
      model: { provider: 'anthropic', model: 'claude-opus-5' },
      configVersion: 1,
    });
    // The parent keeps its own, and an exact retry returns the same pair.
    const parentSteering = await bureau.getSessionSteering(run.sessionId);
    expect(parentSteering?.model).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
    expect(await fork(bureau, run.sessionId, finalAssistantOf(run.id), 'fork-9')).toEqual(result);
  });

  it('carries nothing when the parent was never switched', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);

    const result = await fork(bureau, run.sessionId, finalAssistantOf(run.id));

    expect(result.carriedOverride).toBeNull();
    const forkSteering = await bureau.getSessionSteering(result.contextId);
    expect(forkSteering?.model).toBeNull();
  });

  it('survives a crash after the ledger recorded the contextId and before the fork existed', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    await steer(bureau, run.sessionId, OPUS_5);
    // The first attempt claimed the command, naming the contextId, and died.
    const ledger = createCommandLedger({
      kv: bureau.kv!,
      keyPrefix: FORK_LEDGER_KEY_PREFIX,
      clock: { now: () => Date.now(), nowISO: () => new Date().toISOString() },
      nextConflictId: () => crypto.randomUUID(),
    });
    await ledger.claim(
      {
        callerId: ALICE,
        target: run.sessionId,
        requestId: 'crash-1',
        operationVersion: FORK_OPERATION_VERSION,
      },
      digestCommandPayload({ throughMessageId: finalAssistantOf(run.id) }),
      { contextId: 'planned-fork', override: { provider: 'anthropic', model: 'claude-opus-5' } },
    );

    const result = await fork(bureau, run.sessionId, finalAssistantOf(run.id), 'crash-1');

    expect(result.contextId).toBe('planned-fork');
    expect(await sessionCount(bureau)).toBe(2);
    const planned = await bureau.getSessionSteering('planned-fork');
    expect(planned?.model?.model).toBe('claude-opus-5');
  });

  it('survives a crash after the fork existed and before the override was admitted, forking once', async () => {
    const bureau = await openBureau();
    const run = await completedSession(bureau);
    await steer(bureau, run.sessionId, OPUS_5);
    const ledger = createCommandLedger({
      kv: bureau.kv!,
      keyPrefix: FORK_LEDGER_KEY_PREFIX,
      clock: { now: () => Date.now(), nowISO: () => new Date().toISOString() },
      nextConflictId: () => crypto.randomUUID(),
    });
    await ledger.claim(
      {
        callerId: ALICE,
        target: run.sessionId,
        requestId: 'crash-2',
        operationVersion: FORK_OPERATION_VERSION,
      },
      digestCommandPayload({ throughMessageId: finalAssistantOf(run.id) }),
      { contextId: 'planned-fork', override: { provider: 'anthropic', model: 'claude-opus-5' } },
    );
    // The fork was made, then the process died.
    const { createSessionHandle } = await import('@lostgradient/operative');
    await createSessionHandle(run.sessionId, {
      store: bureau.sessionStore!,
      agentName: 'agent',
    }).fork({ throughMessageId: finalAssistantOf(run.id), id: 'planned-fork', owner: ALICE });
    const count = await sessionCount(bureau);

    const result = await fork(bureau, run.sessionId, finalAssistantOf(run.id), 'crash-2');

    expect(result.contextId).toBe('planned-fork');
    expect(await sessionCount(bureau)).toBe(count);
    const planned = await bureau.getSessionSteering('planned-fork');
    expect(planned?.model?.model).toBe('claude-opus-5');
    expect(await fork(bureau, run.sessionId, finalAssistantOf(run.id), 'crash-2')).toEqual(result);
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
    const run = await harness.bureau.createRun({
      message: 'go',
      agentName: 'picker',
      principal: ALICE,
    });
    await waitForRunState(harness.bureau, run.id);
    return { harness, run };
  }

  const switchTo = (
    harness: Awaited<ReturnType<typeof startPicker>>['harness'],
    sessionId: string,
  ) =>
    harness.bureau.submitSteeringCommand(sessionId, {
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
    const switched = await switchTo(harness, run.sessionId);
    expect(switched.outcome).toBe('accepted');

    const result = await harness.bureau.forkSession(run.sessionId, {
      owner: ALICE,
      commandId: 'file-fork',
      throughMessageId: `${run.id}:step:0`,
    });

    expect(result.carriedOverride).toMatchObject({ outcome: 'accepted' });
    const carried = await harness.bureau.getSessionSteering(result.contextId);
    expect(carried?.model).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
  });

  it('still forks when the carried override is no longer allowed, and the fork runs on the default', async () => {
    const { harness, run } = await startPicker();
    await switchTo(harness, run.sessionId);
    // The file is edited by hand: the model the session was switched to is no longer listed.
    await harness.put('picker.md', PICKER(`[${KNOWN_MODEL}]`));
    await harness.bureau.agents.refresh();
    const args = {
      owner: ALICE,
      commandId: 'file-fork-2',
      throughMessageId: `${run.id}:step:0`,
    };

    const result = await harness.bureau.forkSession(run.sessionId, args);

    expect(result.carriedOverride).toMatchObject({
      outcome: 'rejected',
      failure: { reason: 'model-not-allowed' },
    });
    const afterRefusal = await harness.bureau.getSessionSteering(result.contextId);
    expect(afterRefusal?.model).toBeNull();
    expect(await harness.bureau.forkSession(run.sessionId, args)).toEqual(result);
  });
});
