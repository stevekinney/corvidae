/**
 * COR-2437 — resuming a context's last stopped turn: what each kind of stop leaves, and the reason
 * each is refused. No path starts a run or writes the context.
 */
import {
  createAgent,
  createAgentSession,
  type GenerateContext,
  stopWhen,
} from '@lostgradient/operative';
import { createTool } from 'armorer';
import { Conversation, createConversationHistory } from 'conversationalist';
import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryStorage } from '@lostgradient/storage';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { BureauShuttingDownError, ContextArchivedError } from './bureau-errors';
import { createBureau } from './create-bureau';
import { SessionResumeRefusedError } from './session-resume';
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

/** Settles once the newest agent's run reaches its second step, which waits to be stopped. */
let secondStep = Promise.withResolvers<void>();

/** An agent whose first step calls a tool; its second fails, finishes, or waits to be stopped. */
function agentThat(second: 'waits' | 'fails' | 'finishes') {
  secondStep = Promise.withResolvers<void>();
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
      if (history.messages[history.ids.at(-1) ?? '']?.toolResult === undefined) {
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

async function openBureau(agent: ReturnType<typeof createAgent>) {
  const bureau = await createBureau<AgentDefinitions>({
    models: { catalog: createVendorCatalog().descriptors },
    agents: { agent },
    storage: new MemoryStorage(),
    durable: true,
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

const resume = (bureau: Bureau<AgentDefinitions>, contextId: string, runId: string) =>
  bureau.contexts.resumeTurn(contextId, { owner: ALICE, commandId: 'resume-1', runId });

async function refusalOf(pending: Promise<unknown>): Promise<string> {
  const error = await pending.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof SessionResumeRefusedError)) return `not a refusal: ${String(error)}`;
  return error.reason;
}

/** Waits until the run's end is in its task record. */
async function untilEnded(bureau: Bureau<AgentDefinitions>, runId: string): Promise<void> {
  await waitForTaskState(bureau, runId);
  await waitForCondition(async () => {
    const record = await bureau.internals.taskRegistry.record(runId);
    return record?.settled !== undefined;
  }, 'the run has ended');
}

/** How many tasks the context holds: a resume never starts one. */
async function taskCount(bureau: Bureau<AgentDefinitions>, contextId: string): Promise<number> {
  const page = await bureau.internals.taskRegistry.enumerate({ contextId, limit: 10, offset: 0 });
  return page.tasks.length;
}

describe('a resume refused for each kind of stop', () => {
  it('refuses a turn the person stopped, keeping its reply and starting nothing', async () => {
    const bureau = await openBureau(agentThat('waits'));
    const run = await startTaskFrom(bureau, { input: 'go', agentName: 'agent', principal: ALICE });
    await secondStep.promise;

    expect(await refusalOf(resume(bureau, run.contextId, run.id))).toBe('turn-running');
    await bureau.tasks.cancel(run.id);
    await untilEnded(bureau, run.id);
    const before = await bureau.contexts.get(run.contextId);

    expect(await refusalOf(resume(bureau, run.contextId, run.id))).toBe('run-not-resumable');
    expect(await bureau.contexts.get(run.contextId)).toEqual(before);
    expect(await taskCount(bureau, run.contextId)).toBe(1);
  });

  it('refuses a turn that failed, and one that finished', async () => {
    const failing = await openBureau(agentThat('fails'));
    const failed = await startTaskFrom(failing, {
      input: 'go',
      agentName: 'agent',
      principal: ALICE,
    });
    await untilEnded(failing, failed.id);
    expect(await refusalOf(resume(failing, failed.contextId, failed.id))).toBe('run-not-resumable');

    const finishing = await openBureau(agentThat('finishes'));
    const finished = await startTaskFrom(finishing, {
      input: 'go',
      agentName: 'agent',
      principal: ALICE,
    });
    await untilEnded(finishing, finished.id);
    expect(await refusalOf(resume(finishing, finished.contextId, finished.id))).toBe(
      'turn-finished',
    );
  });

  it('refuses a turn waiting on an approval: it goes on once the person answers', async () => {
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

  it('refuses a turn whose process stopped: the Bureau recovers it itself', async () => {
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
    for (const taskId of ['crafted-earlier', 'crafted-lost']) {
      await bureau.internals.taskRegistry.recordAdmission({
        taskId,
        contextId: 'crafted',
        incarnation: saved.incarnation,
        agentName: 'agent',
        owner: ALICE,
        origin: { kind: 'api' },
        message: 'go',
      });
    }
    await bureau.internals.taskRegistry.recordSettled('crafted-lost', {
      at: new Date().toISOString(),
      status: 'failed',
      finishReason: TASK_OWNER_LOST_FINISH_REASON,
      message: null,
    });

    expect(await refusalOf(resume(bureau, 'crafted', 'crafted-lost'))).toBe('turn-recovering');
    expect(await refusalOf(resume(bureau, 'crafted', 'crafted-earlier'))).toBe('not-latest-turn');
    expect(await refusalOf(resume(bureau, 'crafted', 'no-such-run'))).toBe('run-not-found');
  });

  it('answers a context it does not hold, an archived one, and a shutting-down Bureau', async () => {
    const bureau = await openBureau(agentThat('finishes'));
    const run = await startTaskFrom(bureau, { input: 'go', agentName: 'agent', principal: ALICE });
    await untilEnded(bureau, run.id);

    const missing = await resume(bureau, 'no-such-context', run.id).catch(
      (error: unknown) => error,
    );
    expect((missing as { code?: string }).code).toBe('NOT_FOUND');
    await bureau.contexts.archive(run.contextId);
    const archived = await resume(bureau, run.contextId, run.id).catch((error: unknown) => error);
    expect(archived).toBeInstanceOf(ContextArchivedError);
    await bureau.contexts.unarchive(run.contextId);
    await bureau.shutdown();
    const closed = await resume(bureau, run.contextId, run.id).catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(BureauShuttingDownError);
  });
});
