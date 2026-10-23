/**
 * The pinned `@a2a-js/sdk@1.3.0` client against `createBureauHandler`'s A2A mount (COR-903):
 * it discovers the card, sends a message, reads the task, and cancels work still running.
 */
import { type Message, Role, type Task, TaskState } from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import {
  answering,
  openBureau,
  parkingUntilAborted,
} from './management/management-fixtures.test-support.ts';

const PUBLIC_URL = 'http://localhost';

function userMessage(text: string): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function asTask(result: Message | Task): Task {
  if (!('status' in result)) throw new Error('expected a task');
  return result;
}

describe('the A2A mount with the @a2a-js/sdk client', () => {
  it('discovers the card, completes a task, reads it back, and cancels running work', async () => {
    const opened = await openBureau({
      agents: {
        asker: createAgent({ name: 'asker', description: 'Answers.', generate: answering('done') }),
        waiter: createAgent({
          name: 'waiter',
          description: 'Waits.',
          generate: parkingUntilAborted,
        }),
      },
      publish: ['asker', 'waiter'],
      handlerOptions: { publicUrl: PUBLIC_URL },
    });
    try {
      // The card is public; every JSON-RPC call carries the caller’s API key. The SDK resolves the
      // card relative to the agent URL, so the URL ends in a slash.
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('X-API-Key', 'alice-key');
        return opened.handler(new Request(input, { ...init, headers }));
      }) as typeof fetch;
      const factory = new ClientFactory(
        ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
          transports: [new JsonRpcTransportFactory({ fetchImpl })],
          cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
        }),
      );
      const asker = await factory.createFromUrl(`${PUBLIC_URL}/a2a/asker/`);
      const waiter = await factory.createFromUrl(`${PUBLIC_URL}/a2a/waiter/`);
      const send = (text: string, returnImmediately = false) => ({
        tenant: '',
        message: userMessage(text),
        configuration: {
          acceptedOutputModes: [],
          taskPushNotificationConfig: undefined,
          returnImmediately,
        },
        metadata: undefined,
      });

      const completed = asTask(await asker.sendMessage(send('hello')));
      expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(completed.artifacts[0]?.parts[0]?.content).toEqual({ $case: 'text', value: 'done' });

      const fetched = await asker.getTask({ tenant: '', id: completed.id });
      expect(fetched.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

      const running = asTask(await waiter.sendMessage(send('wait', true)));
      await waitForCondition(() => opened.bureau.getRun(running.id)?.status === 'running', 'run');
      const canceled = await waiter.cancelTask({ tenant: '', id: running.id, metadata: undefined });
      expect(canceled.id).toBe(running.id);
      await waitForCondition(async () => {
        const view = await opened.bureau.tasks.get(running.id);
        return view?.status === 'canceled';
      }, 'the task never read as canceled');
      const after = await waiter.getTask({ tenant: '', id: running.id });
      expect(after.status?.state).toBe(TaskState.TASK_STATE_CANCELED);

      // The SDK's own streaming client reads the task, then its completion.
      const streamed: string[] = [];
      for await (const event of asker.sendMessageStream(send('stream'))) {
        const payload = event.payload;
        streamed.push(
          payload?.$case === 'statusUpdate'
            ? `status:${TaskState[payload.value.status?.state ?? 0]}`
            : (payload?.$case ?? 'none'),
        );
      }
      expect(streamed[0]).toBe('task');
      expect(streamed.at(-1)).toBe('status:TASK_STATE_COMPLETED');
    } finally {
      await opened.dispose();
    }
  });
});
