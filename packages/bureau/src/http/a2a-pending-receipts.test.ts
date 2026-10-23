/**
 * A continuation whose receipt could not be recorded (COR-903): after a crash between the
 * command's effect and `ledger.complete`, the retry finishes by the path the claim recorded,
 * whatever the task's revision or the command's deadline say by then.
 */
import { Message, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage, principalFromApiKey, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createCommandLedger } from '../command-ledger.ts';
import { waitForCondition } from '../test';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import { createBureauAgentCard } from './a2a-agent-card.ts';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import {
  A2A_SEND_LEDGER_KEY_PREFIX,
  type A2ASendClaim,
  type A2ASendLedger,
  type A2ASendResult,
  BureauA2AUser,
  createBureauA2ARequestHandler,
} from './a2a-request-handler.ts';
import { createA2ATaskRecords } from './a2a-task-record.ts';
import { buildBureauHandlerHost } from './create-bureau-handler.ts';
import { openBureau } from './management/management-fixtures.test-support.ts';
import { respondToTask } from './management/tasks-respond-operation.ts';

function parksThenAnswers(): GenerateFunction {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1
      ? {
          content: '',
          toolCalls: [
            {
              id: 'wait-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'human-response', prompt: 'Which?' },
            },
          ],
        }
      : { content: 'done', toolCalls: [] };
  };
}

function userMessage(messageId: string, text: string, taskId = '', receipts?: object): Message {
  return Message.fromJSON({
    messageId,
    taskId,
    role: 'ROLE_USER',
    parts: [{ text }],
    ...(receipts === undefined ? {} : { metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: receipts } }),
  });
}

/** A parked task, an answer whose receipt write fails after it took effect, and a way to retry. */
async function withCrashedAnswer(
  body: (run: {
    parkedId: string;
    revision: string;
    skewClock: (milliseconds: number) => void;
    answer: (receipts: object) => Promise<{ failed: unknown; message: Message }>;
    retry: (message: Message) => Promise<any>;
    failNextComplete: () => void;
    bureau: Awaited<ReturnType<typeof openBureau>>['bureau'];
    completed: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const opened = await openBureau({
    agents: { asker: createAgent({ name: 'asker', generate: parksThenAnswers() }) },
    publish: ['asker'],
    humanInput: true,
  });
  try {
    const base = createDefaultRuntimeServices();
    let skew = 0;
    const runtime = { ...base, clock: { ...base.clock, now: () => base.clock.now() + skew } };
    const inner = createCommandLedger<A2ASendClaim, A2ASendResult>({
      kv: textValueStore(new MemoryStorage()),
      keyPrefix: A2A_SEND_LEDGER_KEY_PREFIX,
      clock: base.clock,
      nextConflictId: () => base.identifiers.next('conflict'),
    });
    let failNextComplete = false;
    const ledger: A2ASendLedger = {
      ...inner,
      async complete(entry, result) {
        if (failNextComplete) {
          failNextComplete = false;
          throw new Error('the ledger write failed');
        }
        return inner.complete(entry, result);
      },
    };
    const host = buildBureauHandlerHost(opened.bureau, ['asker']);
    const card = createBureauAgentCard({
      catalogName: 'asker',
      displayName: undefined,
      description: undefined,
      definitionRevision: 1,
      skillDescriptors: undefined,
      security: undefined,
      durableHistory: true,
    });
    const handler = createBureauA2ARequestHandler({
      agentName: 'asker',
      card: () => ({ ...card, supportedInterfaces: [], signatures: [] }),
      bureau: opened.bureau,
      records: createA2ATaskRecords(textValueStore(new MemoryStorage())),
      ledger,
      runtime,
      respond: (principal, input) => respondToTask(host, principal, input),
    });
    const principal = principalFromApiKey({ subject: 'alice', scopes: [] });
    const context = () =>
      new ServerCallContext({
        user: new BureauA2AUser(principal),
        requestedVersion: '1.0',
        requestedExtensions: [COMMAND_RECEIPTS_EXTENSION_URI],
      });
    const send = (message: Message) =>
      handler.sendMessage(
        { tenant: '', message, configuration: undefined, metadata: undefined },
        context(),
      );

    const parked: any = await send(userMessage('m-start', 'start'));
    expect(parked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const revision = parked.metadata?.[COMMAND_RECEIPTS_EXTENSION_URI]?.revision;
    expect(typeof revision).toBe('string');

    await body({
      parkedId: parked.id,
      revision,
      skewClock: (milliseconds) => {
        skew += milliseconds;
      },
      answer: async (receipts) => {
        const message = userMessage('m-answer', 'blue', parked.id, receipts);
        failNextComplete = true;
        return { failed: await rejectionOf(send(message)), message };
      },
      retry: send,
      failNextComplete: () => {
        failNextComplete = true;
      },
      bureau: opened.bureau,
      completed: () =>
        waitForCondition(async () => {
          const view = await opened.bureau.tasks.get(parked.id);
          return view?.status === 'completed';
        }, 'the answered task never completed'),
    });
  } finally {
    await opened.dispose();
  }
}

describe('a retried continuation whose claim was left pending', () => {
  it('completes rather than refusing the expectedRevision its own effect made stale', async () => {
    await withCrashedAnswer(async (run) => {
      const { failed, message } = await run.answer({ expectedRevision: run.revision });
      expect((failed as Error).message).toBe('the ledger write failed');
      await run.completed();

      const retried = await run.retry(message);
      expect(retried.id).toBe(run.parkedId);
      expect(
        retried.history.filter((entry: Message) => entry.messageId === 'm-answer'),
      ).toHaveLength(1);
    });
  });

  it('records its answer as applied, not expired, when the retry comes after the deadline', async () => {
    await withCrashedAnswer(async (run) => {
      const deadline = new Date(Date.now() + 60_000).toISOString();
      const { failed, message } = await run.answer({ deadline });
      expect((failed as Error).message).toBe('the ledger write failed');
      await run.completed();

      run.skewClock(120_000);
      const retried = await run.retry(message);
      expect(retried.id).toBe(run.parkedId);
      expect(retried.metadata?.[COMMAND_RECEIPTS_EXTENSION_URI]?.receipt.state).not.toBe('expired');
      expect(
        retried.history.filter((entry: Message) => entry.messageId === 'm-answer'),
      ).toHaveLength(1);
    });
  });
});

describe('a send whose deadline has already passed', () => {
  const past = { deadline: '2000-01-01T00:00:00Z' };

  it('records one expired task, however many times its lost receipt is retried', async () => {
    await withCrashedAnswer(async (run) => {
      const message = userMessage('m-late', 'too late', '', past);
      run.failNextComplete();
      const failed = await rejectionOf(run.retry(message));
      expect((failed as Error).message).toBe('the ledger write failed');
      const retried = await run.retry(message);
      const again = await run.retry(message);

      expect(again.id).toBe(retried.id);
      const listed = await run.bureau.tasks.enumerate({ agentName: 'asker', limit: 50, offset: 0 });
      const expired = listed.tasks.filter((task) => task.finishReason === 'deadline-exceeded');
      expect(expired.map((task) => task.id)).toEqual([retried.id]);
    });
  });

  it('is refused like any other send when its message holds no text', async () => {
    await withCrashedAnswer(async (run) => {
      const empty = Message.fromJSON({
        messageId: 'm-empty',
        taskId: '',
        role: 'ROLE_USER',
        parts: [{ data: { not: 'text' } }],
        metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: past },
      });
      const refused = await rejectionOf(run.retry(empty));
      expect((refused as Error).message).toMatch(/text part/);
    });
  });
});
