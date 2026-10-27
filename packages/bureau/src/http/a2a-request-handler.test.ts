/**
 * Bureau's A2A request handler driven directly (COR-903): a send whose effect was admitted keeps
 * its claim even when recording the receipt fails, and its retry finishes it by the same path.
 */
import { Message, Role, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage, principalFromApiKey, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createCommandLedger } from '../command-ledger.ts';
import { waitForCondition } from '../test';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import { createBureauAgentCard } from './a2a-agent-card.ts';
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
import { respondToTask } from './management/tasks-respond-operation.ts';
import { openBureau } from './management/management-fixtures.test-support.ts';

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

function userMessage(messageId: string, text: string, taskId = ''): Message {
  return Message.fromJSON({
    messageId,
    taskId,
    role: 'ROLE_USER',
    parts: [{ text }],
  });
}

describe('a continuation whose receipt could not be recorded', () => {
  it('keeps its claim, and its retry finishes the answer instead of refusing or rerouting it', async () => {
    const opened = await openBureau({
      agents: { asker: createAgent({ name: 'asker', generate: parksThenAnswers() }) },
      publish: ['asker'],
    });
    try {
      const runtime = createDefaultRuntimeServices();
      const inner = createCommandLedger<A2ASendClaim, A2ASendResult>({
        kv: textValueStore(new MemoryStorage()),
        keyPrefix: A2A_SEND_LEDGER_KEY_PREFIX,
        clock: runtime.clock,
        nextConflictId: () => runtime.identifiers.next('conflict'),
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
        durableHistory: false,
        pushNotifications: false,
      });
      const handler = createBureauA2ARequestHandler({
        publicUrl: 'http://localhost',
        agentName: 'asker',
        card: () => ({ ...card, supportedInterfaces: [], signatures: [] }),
        bureau: opened.bureau,
        records: createA2ATaskRecords(textValueStore(new MemoryStorage())),
        ledger,
        respond: (principal, input) => respondToTask(host, principal, input),
      });
      const principal = principalFromApiKey({ subject: 'alice', scopes: [] });
      const context = () =>
        new ServerCallContext({ user: new BureauA2AUser(principal), requestedVersion: '1.0' });
      const send = (message: Message) =>
        handler.sendMessage(
          { tenant: '', message, configuration: undefined, metadata: undefined },
          context(),
        );

      const parked = await send(userMessage('m-start', 'start'));
      if (!('status' in parked)) throw new Error('expected a task');
      expect(parked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);

      failNextComplete = true;
      const answer = userMessage('m-answer', 'blue', parked.id);
      const failed = await rejectionOf(send(answer));
      expect((failed as Error).message).toBe('the ledger write failed');
      // The answer took effect: the task finishes.
      await waitForCondition(async () => {
        const view = await opened.bureau.internals.taskRegistry.get(parked.id);
        return view?.status === 'completed';
      }, 'the answered task never completed');

      const retried = await send(answer);
      if (!('status' in retried)) throw new Error('expected a task');
      expect(retried.id).toBe(parked.id);
      expect(retried.history.filter((entry) => entry.messageId === 'm-answer')).toHaveLength(1);
      expect(Role[retried.history[1]?.role ?? 0]).toBe('ROLE_USER');
    } finally {
      await opened.dispose();
    }
  });
});

describe('a completed task whose reply this instance cannot read yet', () => {
  it('folds the reply into the history once it can be read, rather than never', async () => {
    const opened = await openBureau({
      agents: {
        asker: createAgent({
          name: 'asker',
          generate: async () => ({ content: 'the reply', toolCalls: [] }),
        }),
      },
      publish: ['asker'],
    });
    try {
      let hidden = true;
      // The same Bureau, seen from an instance the run's reply has not reached yet.
      const bureau = Object.create(opened.bureau, {
        tasks: {
          value: {
            ...opened.bureau.tasks,
            detail: (id: string) => (hidden ? undefined : opened.bureau.tasks.detail(id)),
            events: (...args: Parameters<typeof opened.bureau.tasks.events>) =>
              hidden
                ? Promise.resolve({ events: [], hasMore: false, nextCursor: undefined })
                : opened.bureau.tasks.events(...args),
          },
        },
      }) as typeof opened.bureau;
      const runtime = createDefaultRuntimeServices();
      const host = buildBureauHandlerHost(opened.bureau, ['asker']);
      const card = createBureauAgentCard({
        catalogName: 'asker',
        displayName: undefined,
        description: undefined,
        definitionRevision: 1,
        skillDescriptors: undefined,
        security: undefined,
        durableHistory: false,
        pushNotifications: false,
      });
      const handler = createBureauA2ARequestHandler({
        publicUrl: 'http://localhost',
        agentName: 'asker',
        card: () => ({ ...card, supportedInterfaces: [], signatures: [] }),
        bureau,
        records: createA2ATaskRecords(textValueStore(new MemoryStorage())),
        ledger: createCommandLedger<A2ASendClaim, A2ASendResult>({
          kv: textValueStore(new MemoryStorage()),
          keyPrefix: A2A_SEND_LEDGER_KEY_PREFIX,
          clock: runtime.clock,
          nextConflictId: () => runtime.identifiers.next('conflict'),
        }),
        respond: (principal, input) => respondToTask(host, principal, input),
      });
      const principal = principalFromApiKey({ subject: 'alice', scopes: [] });
      const context = () =>
        new ServerCallContext({ user: new BureauA2AUser(principal), requestedVersion: '1.0' });

      const sent = await handler.sendMessage(
        {
          tenant: '',
          message: userMessage('m-1', 'hello'),
          configuration: undefined,
          metadata: undefined,
        },
        context(),
      );
      if (!('status' in sent)) throw new Error('expected a task');
      // The settlement recorded no answer for a session run, so this read has no reply.
      expect(sent.history.map((entry) => entry.messageId)).toEqual(['m-1']);

      hidden = false;
      const later = await handler.getTask({ tenant: '', id: sent.id }, context());

      expect(later.history.map((entry) => entry.parts[0]?.content)).toEqual([
        { $case: 'text', value: 'hello' },
        { $case: 'text', value: 'the reply' },
      ]);
    } finally {
      await opened.dispose();
    }
  });
});
