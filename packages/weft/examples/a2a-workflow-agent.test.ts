import { afterEach, describe, expect, test } from 'bun:test';

import {
  type ExampleAgent,
  startExampleAgent,
  startExampleAgentAndReport,
} from './a2a-workflow-agent.ts';
import { resolveExampleEnvironment } from './environment-configuration.ts';

let running: ExampleAgent | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function rpc(agent: ExampleAgent, method: string, params: unknown) {
  const response = await fetch(`${agent.url}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await response.json()) as { result?: Record<string, any>; error?: unknown };
}

describe('the A2A workflow agent example', () => {
  test('asks for input, notifies its own receiver, and cancels during its sleep', async () => {
    const notified = Promise.withResolvers<string>();
    const agent = await startExampleAgent({ port: 0, onNotification: notified.resolve });
    running = agent;

    const started = await rpc(agent, 'SendMessage', {
      message: { messageId: 'example-1', role: 'ROLE_USER', parts: [{ text: 'refund order 42' }] },
      configuration: { taskPushNotificationConfig: { url: agent.receiverUrl } },
    });
    const task = started.result?.['task'];
    expect(task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(JSON.parse(await notified.promise)).toHaveProperty('statusUpdate');

    const answered = await rpc(agent, 'SendMessage', {
      message: {
        messageId: 'example-2',
        role: 'ROLE_USER',
        taskId: task.id,
        parts: [{ text: 'approved' }],
      },
      configuration: { returnImmediately: true },
    });
    expect(answered.result?.['task'].status.state).toBe('TASK_STATE_WORKING');

    const cancelled = await rpc(agent, 'CancelTask', { id: task.id });
    expect(cancelled.result?.['status'].state).toBe('TASK_STATE_CANCELED');
  });

  test('answers each TCK scenario its messageId prefix names', async () => {
    const agent = await startExampleAgent({ port: 0 });
    running = agent;
    const send = async (messageId: string) => {
      const response = await rpc(agent, 'SendMessage', {
        message: { messageId, role: 'ROLE_USER', parts: [{ text: 'TCK artifact test' }] },
      });
      return response.result;
    };
    const firstPart = async (messageId: string) => {
      const result = await send(messageId);
      const task = result?.['task'];
      expect(task?.status.state).toBe('TASK_STATE_COMPLETED');
      return task?.artifacts[0].parts[0];
    };

    expect(await firstPart('tck-artifact-text-1')).toEqual({ text: 'Generated text content' });
    expect(await firstPart('tck-artifact-file-1')).toEqual({
      raw: Buffer.from('tck').toString('base64'),
      filename: 'output.txt',
      mediaType: 'text/plain',
    });
    expect(await firstPart('tck-artifact-file-url-1')).toEqual({
      url: 'https://example.com/output.txt',
      filename: 'output.txt',
      mediaType: 'text/plain',
    });
    expect(await firstPart('tck-artifact-data-1')).toEqual({ data: { key: 'value', count: 42 } });
    expect(await firstPart('tck-complete-task-1')).toMatchObject({
      data: { request: 'TCK artifact test' },
    });
    const reply = await send('tck-message-response-1');
    expect(reply?.['task']).toBeUndefined();
    expect(reply?.['message']).toMatchObject({
      role: 'ROLE_AGENT',
      parts: [{ text: 'Direct message response' }],
    });
  });

  test('asks again for a tck-input-required answer, and takes any other TCK answer without the sleep', async () => {
    const agent = await startExampleAgent({ port: 0 });
    running = agent;
    const send = async (messageId: string, text: string, taskId?: string) => {
      const response = await rpc(agent, 'SendMessage', {
        message: { messageId, role: 'ROLE_USER', parts: [{ text }], ...(taskId ? { taskId } : {}) },
      });
      return response.result?.['task'];
    };

    const task = await send('tck-input-required-1', 'start');
    const again = await send('tck-input-required-2', 'history', task?.id);
    const done = await send('tck-infer-ctx-1', 'finish', task?.id);

    expect(task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(again?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(done?.status.state).toBe('TASK_STATE_COMPLETED');
    expect(done?.artifacts[0].parts[0]).toEqual({
      data: { request: 'start', input: 'finish' },
      mediaType: 'application/json',
    });
  });

  test('lets notifications reach any loopback port when told to trust loopback webhooks', async () => {
    const received = Promise.withResolvers<string>();
    const kitReceiver = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        received.resolve(await request.text());
        return new Response(null, { status: 204 });
      },
    });
    try {
      const agent = await startExampleAgent({ port: 0, trustLoopbackWebhooks: true });
      running = agent;

      const started = await rpc(agent, 'SendMessage', {
        message: { messageId: 'example-3', role: 'ROLE_USER', parts: [{ text: 'hello' }] },
        configuration: {
          taskPushNotificationConfig: { url: `http://localhost:${kitReceiver.port}/webhook` },
        },
      });

      expect(started.result?.['task'].status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      expect(JSON.parse(await received.promise)).toHaveProperty('statusUpdate');
      await rpc(agent, 'CancelTask', { id: started.result?.['task'].id });
    } finally {
      await kitReceiver.stop(true);
    }
  });

  test('reports the URL it listens at and each notification its receiver gets', async () => {
    const lines: string[] = [];
    const notified = Promise.withResolvers<void>();
    const agent = await startExampleAgentAndReport({ port: 0 }, (line) => {
      lines.push(line);
      if (line.startsWith('push notification:')) notified.resolve();
    });
    running = agent;

    expect(lines).toEqual([`A2A agent listening at ${agent.url}`]);
    const started = await rpc(agent, 'SendMessage', {
      message: { messageId: 'example-4', role: 'ROLE_USER', parts: [{ text: 'hello' }] },
      configuration: { taskPushNotificationConfig: { url: agent.receiverUrl } },
    });
    await notified.promise;
    await rpc(agent, 'CancelTask', { id: started.result?.['task'].id });
  });

  test('reads its listener and loopback trust from the examples’ environment module', () => {
    const environment = resolveExampleEnvironment();

    expect(Number.isInteger(environment.port)).toBe(true);
    expect(typeof environment.a2aExampleTrustLoopbackWebhooks).toBe('boolean');
  });
});
