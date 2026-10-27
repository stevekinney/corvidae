/**
 * A streamed `INPUT_REQUIRED` update names the waits that opened it (COR-1661), from the durable
 * event that opened them, even when the registry read made after the event has not caught up.
 */
import type { GenerateFunction } from '@lostgradient/operative';
import { createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { type Json } from './a2a-mount.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { authentication, openBureau } from './management/management-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function rpc(method: string, params: Json): Request {
  return new Request('http://localhost/a2a/asker', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'A2A-Version': '1.0',
      'X-API-Key': 'alice-key',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

/** Frames of an event stream, as parsed `result` objects, until `done` says it has enough. */
async function framesUntil(
  response: Response,
  done: (results: readonly Json[]) => boolean,
): Promise<Json[]> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const results: Json[] = [];
  try {
    while (!done(results)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      for (
        let boundary = buffered.indexOf('\n\n');
        boundary !== -1;
        boundary = buffered.indexOf('\n\n')
      ) {
        const data = buffered
          .slice(0, boundary)
          .split('\n')
          .find((line) => line.startsWith('data:'));
        buffered = buffered.slice(boundary + 2);
        if (data !== undefined) results.push(JSON.parse(data.slice(5)).result ?? {});
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return results;
}

describe('an INPUT_REQUIRED update on a stream', () => {
  it('names the wait that opened it, whatever the registry read has caught up to', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const generate: GenerateFunction = async () => {
      calls += 1;
      if (calls > 1) return { content: 'done', toolCalls: [] };
      await gate;
      return {
        content: '',
        toolCalls: [
          {
            id: 'wait-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'human-response', prompt: 'Which?' },
          },
        ],
      };
    };
    const opened = await openBureau({
      agents: { asker: createAgent({ name: 'asker', generate }) },
      publish: ['asker'],
      durableHistory: true,
      handlerOptions: { publicUrl: 'http://localhost' },
    });
    cleanups.push(() => opened.dispose());
    const sent = await opened.handler(
      rpc('SendMessage', {
        message: { messageId: 'm-wait', role: 'ROLE_USER', parts: [{ text: 'go' }] },
        configuration: { returnImmediately: true },
      }),
    );
    const sentBody: Json = await sent.json();
    const taskId = sentBody.result.task.id;
    // A Bureau whose registry read lags the durable event: it lists no open wait yet.
    const lagging = Object.create(opened.bureau, {
      internals: {
        value: {
          ...opened.bureau.internals,
          taskRegistry: new Proxy(opened.bureau.internals.taskRegistry, {
            get(target, property) {
              if (property !== 'get') return Reflect.get(target, property, target);
              return async (id: string) => {
                const view = await target.get(id);
                return view === undefined ? undefined : { ...view, openWaits: [] };
              };
            },
          }),
        },
      },
    });
    const handler = createBureauHandler(lagging, {
      authentication,
      publish: ['asker'],
      publicUrl: 'http://localhost',
    });

    const streaming = framesUntil(
      await handler(rpc('SubscribeToTask', { id: taskId })),
      (results) =>
        results.some(
          (result) => result.statusUpdate?.status?.state === 'TASK_STATE_INPUT_REQUIRED',
        ),
    );
    release();
    const results = await streaming;

    const waiting = results.find(
      (result) => result.statusUpdate?.status?.state === 'TASK_STATE_INPUT_REQUIRED',
    );
    expect(waiting?.statusUpdate.status.message.metadata.signalNames).toEqual(['human-response']);
  });
});
