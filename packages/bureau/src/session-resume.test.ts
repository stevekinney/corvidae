/**
 * COR-2437 — resuming a context's last stopped turn: a continuation run starts on the stored
 * conversation with no message from the person, after a hidden row that names the stopped run.
 * Every refusal starts nothing; a repeated command answers the run it started, after a restart
 * too; and a resume racing a discard, another resume or a new message leaves one winner.
 */
import {
  createAgent,
  createAgentSession,
  type AgentSession,
  type GenerateContext,
  stopWhen,
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
import { BureauShuttingDownError, ContextArchivedError } from './bureau-errors';
import { createBureau } from './create-bureau';
import {
  judgeResumableTurn,
  SessionResumeRefusedError,
  startedContinuation,
} from './session-resume';
import { SessionDiscardRefusedError } from './session-discard';
import { waitForCondition, waitForTaskState } from './test';
import type { Bureau } from './bureau-types/facade';
import { startTaskFrom } from './test/task-start-request.ts';
import { createVendorCatalog } from './testing/vendor-catalog.test-support';
import { approvalToolbox } from './http/management/management-fixtures.test-support';
import { TASK_OWNER_LOST_FINISH_REASON } from './task-registry';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const ALICE = 'alice';

/** What the continuations of the newest agent were asked over: the rows the model is sent. */
let continuedOver: string[][] = [];
/** Settles once the newest agent's first run reaches its second step, which waits to be stopped. */
let secondStep = Promise.withResolvers<void>();

/**
 * An agent whose first step calls a tool; its second fails, finishes, or waits to be stopped. A
 * step that answers a continuation row records the rows the model is sent and finishes the turn.
 */
function agentThat(second: 'waits' | 'fails' | 'finishes' | 'continuation-waits') {
  secondStep = Promise.withResolvers<void>();
  continuedOver = [];
  return createAgent({
    name: 'agent',
    tools: {
      noop: createTool({
        name: 'noop',
        description: 'Does nothing',
        input: z.object({}),
        execute: async () => 'ok',
      }),
    },
    generate: async (context: GenerateContext) => {
      const history = context.conversation.current;
      const lastId = history.ids.at(-1) ?? '';
      if (lastId.endsWith(':continuation')) {
        continuedOver.push(history.ids.filter((id) => history.messages[id]?.hidden !== true));
        if (second === 'continuation-waits') {
          secondStep.resolve();
          await new Promise<void>((_resolve, reject) => {
            const signal = context.signal;
            if (signal === undefined) throw new Error('A step of a run is given its signal.');
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return { content: 'and so the answer goes on.', toolCalls: [] };
      }
      if (history.messages[lastId]?.toolResult === undefined) {
        return { content: 'thinking', toolCalls: [{ id: 'c-1', name: 'noop', arguments: {} }] };
      }
      if (second === 'fails') throw new Error('the model failed');
      if (second === 'finishes') return { content: 'done', toolCalls: [] };
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

async function openBureau(
  agent: ReturnType<typeof createAgent>,
  storage: Storage = new MemoryStorage(),
) {
  const bureau = await createBureau<AgentDefinitions>({
    models: { catalog: createVendorCatalog().descriptors },
    agents: { agent },
    storage,
    durable: true,
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

const resume = (
  bureau: Bureau<AgentDefinitions>,
  contextId: string,
  runId: string,
  commandId = 'resume-1',
) => bureau.contexts.resumeTurn(contextId, { owner: ALICE, commandId, runId });

async function refusalOf(pending: Promise<unknown>): Promise<string> {
  const error = await pending.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (error instanceof SessionResumeRefusedError) return error.reason;
  if (error instanceof SessionDiscardRefusedError) return `discard:${error.reason}`;
  return `not a refusal: ${String(error)}`;
}

/** Waits until the run's end is in its task record and the chat records it. */
async function untilEnded(bureau: Bureau<AgentDefinitions>, contextId: string, runId: string) {
  await waitForTaskState(bureau, runId);
  await waitForCondition(async () => {
    const record = await bureau.internals.taskRegistry.record(runId);
    const session = await bureau.contexts.get(contextId);
    return record?.settled !== undefined && session?.metadata['lastRunId'] === runId;
  }, 'the run has ended and the chat records it');
  return (await bureau.contexts.get(contextId))!;
}

/** The tasks of a context, newest first. */
async function tasksOf(bureau: Bureau<AgentDefinitions>, contextId: string): Promise<string[]> {
  const page = await bureau.internals.taskRegistry.enumerate({ contextId, limit: 20, offset: 0 });
  return page.tasks.map((task) => task.id);
}

/** A turn the person stopped while its second step waited, its first step done. */
async function stoppedTurn(bureau: Bureau<AgentDefinitions>) {
  const run = await startTaskFrom(bureau, { input: 'go', agentName: 'agent', principal: ALICE });
  await secondStep.promise;
  await bureau.tasks.cancel(run.id);
  return { run, before: await untilEnded(bureau, run.contextId, run.id) };
}

describe('a resumed turn', () => {
  it('goes on as a continuation run over the stored conversation, ending in the partial reply, with no message from the person', async () => {
    const bureau = await openBureau(agentThat('waits'));
    const { run, before } = await stoppedTurn(bureau);

    const result = await resume(bureau, run.contextId, run.id);

    expect(result.resumedRunId).toBe(run.id);
    expect(result.runId).not.toBe(run.id);
    const after = await untilEnded(bureau, run.contextId, result.runId);
    // The transcript: everything the stopped run kept, the hidden continuation row, then the new
    // run's own rows. Nothing of the stopped run was rewritten, and no row is the person's.
    const kept = before.conversationHistory.ids;
    expect(after.conversationHistory.ids.slice(0, kept.length)).toEqual([...kept]);
    expect(after.conversationHistory.ids[kept.length]).toBe(`${run.id}:continuation`);
    const marker = after.conversationHistory.messages[`${run.id}:continuation`];
    expect(marker?.hidden).toBe(true);
    expect(marker?.metadata?.['bureau:continuationOf']).toBe(run.id);
    const added = after.conversationHistory.ids.slice(kept.length + 1);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((id) => id.startsWith(`${result.runId}:step:`))).toBe(true);
    expect(after.conversationHistory.messages[added.at(-1)!]?.content).toBe(
      'and so the answer goes on.',
    );
    // The model was sent the history as it stood: the partial turn is its last part.
    expect(continuedOver).toEqual([[...kept]]);
    // The stopped run's task still says it was stopped; the continuation is the chat's newest.
    const stopped = await bureau.tasks.get(run.id);
    expect(stopped?.status).toBe('canceled');
    expect(await tasksOf(bureau, run.contextId)).toEqual([result.runId, run.id]);
  });

  it('goes on after a run that failed on a cause worth trying again', async () => {
    const bureau = await openBureau(agentThat('fails'));
    const run = await startTaskFrom(bureau, { input: 'go', agentName: 'agent', principal: ALICE });
    await untilEnded(bureau, run.contextId, run.id);

    const result = await resume(bureau, run.contextId, run.id);

    expect(result.resumedRunId).toBe(run.id);
    await untilEnded(bureau, run.contextId, result.runId);
  });

  it('answers a repeated command with the run it started and starts no second, before and after a restart', async () => {
    const storage = new MemoryStorage();
    const first = await openBureau(agentThat('waits'), storage);
    const { run } = await stoppedTurn(first);
    const started = await resume(first, run.contextId, run.id);
    await untilEnded(first, run.contextId, started.runId);

    expect(await resume(first, run.contextId, run.id)).toEqual(started);
    // Another command for the same turn finds it already went on; the same one for another run is a conflict.
    expect(await refusalOf(resume(first, run.contextId, run.id, 'resume-2'))).toBe(
      'not-latest-turn',
    );
    expect(await refusalOf(resume(first, run.contextId, 'another-run'))).toBe('command-conflict');
    await cleanups.pop()!();

    const restarted = await openBureau(agentThat('finishes'), storage);
    await restarted.recovery();
    expect(await resume(restarted, run.contextId, run.id)).toEqual(started);
    expect(await tasksOf(restarted, run.contextId)).toEqual([started.runId, run.id]);
  });

  it('replays an empty continuation’s recorded run, not a later normal run', () => {
    const stoppedRun = 'stopped';
    const continuationRun = 'continuation';
    const laterRun = 'later';
    const ids = [
      'person',
      `${stoppedRun}:step:0`,
      `${stoppedRun}:continuation`,
      'later-person',
      `${laterRun}:step:0`,
    ];
    const nextId = () => {
      const id = ids.shift();
      if (id === undefined) throw new Error('test supplied too few message identifiers');
      return id;
    };
    const environment = { randomId: nextId };
    const conversation = new Conversation(
      createConversationHistory({ id: 'replay' }, environment),
      environment,
    );
    conversation.appendMessages(
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'partial' },
      {
        role: 'user',
        content: 'Continue the answer from where it stopped.',
        hidden: true,
        metadata: {
          'bureau:continuationOf': stoppedRun,
          'bureau:continuationCommand': 'resume-1',
          'bureau:continuationOwner': ALICE,
          'bureau:continuationRun': continuationRun,
        },
      },
      { role: 'user', content: 'a later normal turn' },
      { role: 'assistant', content: 'later answer' },
    );
    const session = createAgentSession({
      id: 'replay',
      agentName: 'agent',
      conversationHistory: conversation.current,
      metadata: { lastRunId: laterRun },
    });

    expect(startedContinuation(session, stoppedRun, 'resume-1', ALICE)).toEqual({
      kind: 'started',
      runId: continuationRun,
    });
  });
});

describe('a resume racing', () => {
  it('another resume starts one continuation', async () => {
    const bureau = await openBureau(agentThat('waits'));
    const { run } = await stoppedTurn(bureau);

    const outcomes = await Promise.allSettled([
      resume(bureau, run.contextId, run.id, 'resume-a'),
      resume(bureau, run.contextId, run.id, 'resume-b'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    await waitForCondition(async () => {
      const tasks = await tasksOf(bureau, run.contextId);
      return tasks.length === 2;
    }, 'one continuation');
    expect(await tasksOf(bureau, run.contextId)).toHaveLength(2);
  });

  it('a discard leaves one winner', async () => {
    const bureau = await openBureau(agentThat('waits'));
    const { run } = await stoppedTurn(bureau);

    const [resumed, discarded] = await Promise.allSettled([
      resume(bureau, run.contextId, run.id),
      bureau.contexts.discardTurn(run.contextId, {
        owner: ALICE,
        commandId: 'discard-1',
        runId: run.id,
      }),
    ]);

    expect(
      [resumed.status, discarded.status].filter((status) => status === 'fulfilled'),
    ).toHaveLength(1);
    const session = (await bureau.contexts.get(run.contextId))!;
    const hasMarker = session.conversationHistory.ids.includes(`${run.id}:continuation`);
    expect(hasMarker).toBe(resumed.status === 'fulfilled');
  });

  it('a new message leaves one turn: a message that lands first refuses the resume', async () => {
    const bureau = await openBureau(agentThat('waits'));
    const { run } = await stoppedTurn(bureau);
    secondStep = Promise.withResolvers<void>();

    const message = await startTaskFrom(bureau, {
      input: 'something else',
      agentName: 'agent',
      principal: ALICE,
      contextId: run.contextId,
    });

    expect(await refusalOf(resume(bureau, run.contextId, run.id))).toBe('not-latest-turn');
    const session = (await bureau.contexts.get(run.contextId))!;
    expect(session.conversationHistory.ids).not.toContain(`${run.id}:continuation`);
    await bureau.tasks.cancel(message.id);
  });
});

describe('a resume refused', () => {
  it('while the turn is going, and once it finished', async () => {
    const bureau = await openBureau(agentThat('waits'));
    const run = await startTaskFrom(bureau, { input: 'go', agentName: 'agent', principal: ALICE });
    await secondStep.promise;
    expect(await refusalOf(resume(bureau, run.contextId, run.id))).toBe('turn-running');
    await bureau.tasks.cancel(run.id);

    const finishing = await openBureau(agentThat('finishes'));
    const finished = await startTaskFrom(finishing, {
      input: 'go',
      agentName: 'agent',
      principal: ALICE,
    });
    await untilEnded(finishing, finished.contextId, finished.id);
    expect(await refusalOf(resume(finishing, finished.contextId, finished.id))).toBe(
      'turn-finished',
    );
    expect(await tasksOf(finishing, finished.contextId)).toEqual([finished.id]);
  });

  it('while the turn waits on an approval', async () => {
    const charges: number[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      models: { catalog: createVendorCatalog().descriptors },
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
    await waitForCondition(
      () => bureau.reviews.list().some((review) => review.runId === run.id),
      'the approval is waiting',
    );

    expect(await refusalOf(resume(bureau, run.contextId, run.id))).toBe('turn-awaiting-person');
    expect(charges).toEqual([]);
  });

  it('for a recovering run, a failure it would meet again, a later run, a run it lacks, and the archive', async () => {
    const bureau = await openBureau(agentThat('finishes'));
    const conversation = new Conversation(createConversationHistory({ id: 'crafted' }));
    conversation.appendUserMessage('go');
    await bureau.internals.sessionStore!.save(
      createAgentSession({
        id: 'crafted',
        agentName: 'agent',
        conversationHistory: conversation.current,
        metadata: { sessionOwner: ALICE },
      }),
    );
    const saved = (await bureau.contexts.get('crafted'))!;
    const admit = (taskId: string) =>
      bureau.internals.taskRegistry.recordAdmission({
        taskId,
        contextId: 'crafted',
        incarnation: saved.incarnation,
        agentName: 'agent',
        owner: ALICE,
        origin: { kind: 'api' },
        message: 'go',
      });
    await admit('crafted-earlier');
    await admit('crafted-last');
    const settle = (finishReason: string) =>
      bureau.internals.taskRegistry.recordSettled('crafted-last', {
        at: new Date().toISOString(),
        status: 'failed',
        finishReason,
        message: null,
      });

    await settle(TASK_OWNER_LOST_FINISH_REASON);
    expect(await refusalOf(resume(bureau, 'crafted', 'crafted-last'))).toBe('turn-recovering');
    await settle('tripwire');
    expect(await refusalOf(resume(bureau, 'crafted', 'crafted-last'))).toBe('run-not-resumable');
    expect(await refusalOf(resume(bureau, 'crafted', 'crafted-earlier'))).toBe('not-latest-turn');
    expect(await refusalOf(resume(bureau, 'crafted', 'no-such-run'))).toBe('run-not-found');
    await bureau.contexts.archive('crafted');
    const archived = await resume(bureau, 'crafted', 'crafted-last').catch(
      (error: unknown) => error,
    );
    expect(archived).toBeInstanceOf(ContextArchivedError);
    expect(await tasksOf(bureau, 'crafted')).toEqual(['crafted-last', 'crafted-earlier']);
  });

  it('answers a context it does not hold and a shutting-down Bureau', async () => {
    const bureau = await openBureau(agentThat('waits'));
    const { run } = await stoppedTurn(bureau);
    const missing = await resume(bureau, 'no-such-context', run.id).catch(
      (error: unknown) => error,
    );
    expect((missing as { code?: string }).code).toBe('NOT_FOUND');
    await bureau.shutdown();
    const closed = await resume(bureau, run.contextId, run.id).catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(BureauShuttingDownError);
  });
});

describe('which turn may go on', () => {
  const R = 'crafted:run';
  type Row = {
    readonly id: string;
    readonly role: string;
    readonly call?: string;
    readonly metadata?: object;
  };
  const sessionOf = (rows: readonly Row[], status = 'aborted'): AgentSession => {
    const conversation = new Conversation(createConversationHistory({ id: 'crafted' }));
    for (const row of rows) {
      conversation.appendMessages({
        role: row.role,
        content: row.id,
        id: row.id,
        ...(row.metadata === undefined ? {} : { metadata: row.metadata }),
        ...(row.role === 'tool-call'
          ? { toolCall: { id: row.call, name: 'noop', arguments: {} } }
          : {}),
        ...(row.role === 'tool-result'
          ? { toolResult: { callId: row.call, outcome: 'success', content: 'ok' } }
          : {}),
      } as never);
    }
    const history: ConversationHistory = conversation.current;
    return createAgentSession({
      id: 'crafted',
      agentName: 'agent',
      conversationHistory: history,
      metadata: { lastRunId: R, lastRunStatus: status },
    });
  };
  const reasonOf = (session: AgentSession) => {
    const judged = judgeResumableTurn(session, R);
    return judged.ok ? 'resumable' : judged.reason;
  };
  const turn: Row[] = [
    { id: 'person', role: 'user' },
    { id: `${R}:step:0`, role: 'assistant' },
    { id: `${R}:step:0:call:c-1`, role: 'tool-call', call: 'c-1' },
    { id: `${R}:step:0:result:c-1`, role: 'tool-result', call: 'c-1' },
    { id: `${R}:step:1`, role: 'assistant' },
  ];

  it('is a stopped or failed turn whose calls all have their answers', () => {
    expect(reasonOf(sessionOf(turn))).toBe('resumable');
    expect(reasonOf(sessionOf(turn, 'error'))).toBe('resumable');
  });

  it('refuses a turn stopped inside a call, one a follow-up reached, one that went on, and one with no rows', () => {
    expect(reasonOf(sessionOf(turn.slice(0, 3)))).toBe('turn-interrupted-call');
    expect(
      reasonOf(
        sessionOf([
          ...turn,
          { id: 'follow', role: 'user', metadata: { sessionInputCommandId: 'x' } },
        ]),
      ),
    ).toBe('follow-up-delivered');
    expect(
      reasonOf(sessionOf([...turn, { id: `${R}:continuation`, role: 'user', metadata: {} }])),
    ).toBe('not-latest-turn');
    expect(reasonOf(sessionOf(turn.slice(0, 1)))).toBe('nothing-to-resume');
    expect(reasonOf(sessionOf(turn, 'completed'))).toBe('turn-finished');
    expect(reasonOf(sessionOf(turn, 'running'))).toBe('turn-running');
  });
});
