/**
 * COR-1490/COR-1558 — a thread's conversation as AG-UI messages, for a client that opens a thread
 * with no run to attach to: `GET <prefix>/threads/<threadId>/messages`. It decides with the attach
 * route's predicate (the thread's owner, or `bureau.tasks:read`) and answers a thread the caller
 * may not read exactly as it answers one that does not exist.
 */
import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'bun:test';

import {
  as,
  authentication,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { readAgUiStream } from './ag-ui-stream.test-support.ts';

async function withHarness<T>(
  options: Parameters<typeof openHarness>[0],
  body: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await openHarness(options);
  try {
    return await body(harness);
  } finally {
    await harness.dispose();
  }
}

const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});

const messagesRequest = (threadId: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`http://localhost/ag-ui/threads/${encodeURIComponent(threadId)}/messages`, {
    method,
    headers,
  });

type Answer = { threadId?: string; messages?: Array<{ role: string; content?: string }> };

describe('a thread’s messages', () => {
  it('are the finished conversation in order, for the thread’s owner', async () => {
    await withHarness({ script: [say('First answer.')], authentication }, async ({ handler }) => {
      const events = await readAgUiStream(
        await handler(startRequest(runAgentInput(), as('alice-key'))),
      );
      expect(events.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);

      const response = await handler(messagesRequest('thread-1', as('alice-key')));
      const answer = (await response.json()) as Answer;

      expect(response.status).toBe(200);
      expect(answer.threadId).toBe('thread-1');
      expect(answer.messages?.map((message) => [message.role, message.content])).toEqual([
        ['user', 'hello'],
        ['assistant', 'First answer.'],
      ]);
    });
  });

  it('answer another owner, and a thread that does not exist, alike', async () => {
    await withHarness({ script: [say('Done.')], authentication }, async ({ handler }) => {
      await readAgUiStream(await handler(startRequest(runAgentInput(), as('alice-key'))));

      const stranger = await handler(messagesRequest('thread-1', as('bob-key')));
      const missing = await handler(messagesRequest('thread-never', as('bob-key')));

      expect(stranger.status).toBe(404);
      expect(missing.status).toBe(404);
      const strangerText = await stranger.text();
      const missingText = await missing.text();
      expect(strangerText.replaceAll('thread-1', '<id>')).toBe(
        missingText.replaceAll('thread-never', '<id>'),
      );
    });
  });

  it('are readable by a caller holding bureau.tasks:read, which the attach route also allows', async () => {
    await withHarness({ script: [say('Done.')], authentication }, async ({ handler }) => {
      await readAgUiStream(await handler(startRequest(runAgentInput(), as('alice-key'))));

      const reader = await handler(messagesRequest('thread-1', as('reader-key')));
      const writer = await handler(messagesRequest('thread-1', as('writer-key')));

      expect(reader.status).toBe(200);
      expect(writer.status).toBe(404);
    });
  });

  it('refuse any method but GET', async () => {
    await withHarness({ script: [say('Done.')], authentication }, async ({ handler }) => {
      const response = await handler(messagesRequest('thread-1', as('alice-key'), 'POST'));

      expect(response.status).toBe(405);
    });
  });
});
