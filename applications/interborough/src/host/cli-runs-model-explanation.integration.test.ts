/**
 * COR-2534: `interborough runs explain --model` against a real Bureau and its handler. A model
 * writes the longer explanation of a failed agent run, the CLI prints it with the model's name and
 * what it cost, and the run's chat, exported as Markdown from the messages the Bureau serves for the
 * thread, does not hold what the model wrote.
 */
import { appendMessages, createConversationHistory, type ChatMessage } from '@lostgradient/chat';
import { createAgent, createMockGenerate, stopWhen } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  openBureau,
  OWNER,
  type OpenedBureau,
} from '../../../../packages/bureau/src/http/management/management-fixtures.test-support.ts';
import { chatMarkdown } from '../routes/chat/chat-export.ts';
import type { CliClientDependencies } from './cli-client.ts';
import { executeCliWithDispatchAssertions as executeCli } from './cli-dispatch.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const MODEL_TEXT = 'WRITTEN-BY-THE-MODEL-3c9e: the card network declined the charge.';
const USER_MESSAGE = 'please charge the card';

/** A Bureau whose agent fails, with a model that writes an explanation when asked. */
async function fixtureHost(): Promise<{
  opened: OpenedBureau;
  dependencies: CliClientDependencies;
  modelCalls: () => number;
}> {
  const model = createMockGenerate([
    {
      content: JSON.stringify({ text: MODEL_TEXT }),
      toolCalls: [],
      usage: { prompt: 2000, completion: 400, total: 2400 },
    },
  ]);
  const opened = await openBureau({
    agents: {
      writer: createAgent({
        name: 'writer',
        generate: async () => {
          throw new Error('the writer is down');
        },
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    bureauOptions: { models: { generate: () => model } },
    handlerOptions: { agUi: {}, publicUrl: 'http://localhost' },
  });
  cleanups.push(() => opened.dispose());
  return {
    opened,
    modelCalls: () => model.callCount,
    // The CLI posts to `/bureau/jsonrpc`; the handler serves `/jsonrpc`, as the host mounts it.
    dependencies: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        url.pathname = url.pathname.replace(/^\/bureau/, '') || '/';
        const headers = new Headers(init?.headers);
        headers.set('x-api-key', 'alice-key');
        return opened.handler(new Request(url, { ...init, headers }));
      },
    },
  };
}

async function failedTask(opened: OpenedBureau): Promise<{ id: string; contextId: string }> {
  const handle = await opened.bureau.tasks.start('writer', USER_MESSAGE, {
    principal: OWNER.alice,
  });
  await waitUntil(async () => (await opened.bureau.tasks.get(handle.id))?.status === 'failed', {
    message: `task ${handle.id} failed`,
  });
  await opened.bureau.internals.taskRegistry.flush();
  const task = await opened.bureau.tasks.get(handle.id);
  return { id: handle.id, contextId: task!.contextId };
}

describe('interborough runs explain --model', () => {
  // spawn-free: the CLI runs in this process against a real Bureau handler.
  test('AC6, AC9: prints what the model wrote with its name and cost, and the chat’s export does not hold it', async () => {
    const { opened, dependencies, modelCalls } = await fixtureHost();
    const task = await failedTask(opened);

    const text = await executeCli(['runs', 'explain', task.id, '--model'], dependencies);

    expect(text.exitCode).toBe(0);
    expect(modelCalls()).toBe(1);
    expect(text.stdout).toContain(MODEL_TEXT);
    expect(text.stdout).toContain('Written by anthropic/claude-haiku-5-5 at ');
    // 2,000 prompt and 400 completion tokens at the catalog's price: under a cent.
    expect(text.stdout).toContain('Cost of this explanation: < $0.01');

    // The run's chat, as the page reads it: the messages the Bureau serves for the thread.
    const response = await opened.handler(
      new Request(`http://localhost/ag-ui/threads/${encodeURIComponent(task.contextId)}/messages`, {
        headers: { 'x-api-key': 'alice-key' },
      }),
    );
    expect(response.status).toBe(200);
    const served = (await response.json()) as {
      messages: Array<{ id: string; role: 'user' | 'assistant'; content?: string }>;
    };
    const conversation = appendMessages(
      createConversationHistory({ id: task.contextId }),
      ...served.messages.map((message): ChatMessage => ({
        id: message.id,
        role: message.role,
        content: message.content ?? '',
      })),
    );
    const exported = chatMarkdown({ title: 'A failed run', agent: 'writer', conversation });
    // The export is of the chat that was said, so it holds the person's message and not the text.
    expect(exported).toContain(USER_MESSAGE);
    expect(exported).not.toContain('WRITTEN-BY-THE-MODEL');
    expect(JSON.stringify(served)).not.toContain('WRITTEN-BY-THE-MODEL');
  });

  // spawn-free: the CLI runs in this process against a real Bureau handler.
  test('AC4: with no provider connected it is a refusal that says to connect one', async () => {
    const opened = await openBureau({
      agents: {
        writer: createAgent({
          name: 'writer',
          generate: async () => {
            throw new Error('the writer is down');
          },
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      bureauOptions: { models: {} },
    });
    cleanups.push(() => opened.dispose());
    const task = await failedTask(opened);

    const result = await executeCli(['runs', 'explain', task.id, '--model'], {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        url.pathname = url.pathname.replace(/^\/bureau/, '') || '/';
        const headers = new Headers(init?.headers);
        headers.set('x-api-key', 'alice-key');
        return opened.handler(new Request(url, { ...init, headers }));
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No model is connected');
    expect(result.stderr).toContain('Connect a provider');
  });
});
