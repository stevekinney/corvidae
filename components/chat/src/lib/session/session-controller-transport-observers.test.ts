import { rejectionOf } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, test } from 'bun:test';
import { createConversationHistory } from '../components/chat/builders.ts';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import type { ChatSessionHooks, ChatSessionTransport } from './session-controller-support.ts';
import { createChatSessionController } from './session-controller.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

async function* events(values: ChatStreamEvent[]): AsyncGenerator<ChatStreamEvent> {
  yield* values;
}

function controllerWith(transport: ChatSessionTransport, hooks: ChatSessionHooks) {
  let conversation: ConversationHistory = createConversationHistory({ id: 'transport-observers' });
  return createChatSessionController({
    getConversation: () => conversation,
    setConversation: (next) => {
      conversation = next;
    },
    transport,
    hooks,
  });
}

describe('transport observers', () => {
  test('announce each turn’s transport by its run token, and its end once it has settled', async () => {
    const log: string[] = [];
    const controller = controllerWith(
      async () => {
        log.push('transport');
        return events([{ type: 'text', text: 'ok' }]);
      },
      {
        onTransportStart: (token) => log.push(`start:${token}`),
        onTransportEnd: (token) => log.push(`end:${token}`),
      },
    );

    await controller.adapter.sendMessage({ role: 'user', content: 'first' }, []);
    await controller.adapter.sendMessage({ role: 'user', content: 'second' }, []);

    expect(log).toHaveLength(6);
    const [firstStart, , firstEnd, secondStart, , secondEnd] = log;
    expect(log[1]).toBe('transport');
    expect(log[4]).toBe('transport');
    expect(firstStart).toMatch(/^start:\d+$/);
    expect(firstEnd).toBe(firstStart?.replace('start', 'end'));
    expect(secondEnd).toBe(secondStart?.replace('start', 'end'));
    // A later run's token is newer, so releasing only an equal token keeps the two apart.
    expect(Number(secondStart?.slice('start:'.length))).toBeGreaterThan(
      Number(firstStart?.slice('start:'.length)),
    );
  });

  test('end a transport that failed, after the turn’s own cleanup', async () => {
    const log: string[] = [];
    const failure = new Error('transport failed');
    const controller = controllerWith(
      async () => {
        throw failure;
      },
      {
        onTransportStart: (token) => log.push(`start:${token}`),
        onTransportEnd: (token) => log.push(`end:${token}`),
        onStreamingChange: (streaming) => log.push(`streaming:${streaming}`),
      },
    );

    expect(
      await rejectionOf(controller.adapter.sendMessage({ role: 'user', content: 'hi' }, [])),
    ).toBe(failure);

    expect(log.filter((entry) => entry.startsWith('start:'))).toHaveLength(1);
    expect(log.filter((entry) => entry.startsWith('end:'))).toHaveLength(1);
    expect(log.indexOf(log.find((entry) => entry.startsWith('end:')) ?? '')).toBeGreaterThan(
      log.indexOf(log.find((entry) => entry.startsWith('start:')) ?? ''),
    );
  });

  test('report an observer that throws through onError, and never stop the turn or its cleanup', async () => {
    const errors: unknown[] = [];
    const startFailure = new Error('start observer failed');
    const endFailure = new Error('end observer failed');
    let streaming = false;
    const controller = controllerWith(async () => events([{ type: 'text', text: 'ok' }]), {
      onTransportStart: () => {
        throw startFailure;
      },
      onTransportEnd: () => {
        throw endFailure;
      },
      onError: (error) => errors.push(error),
      onStreamingChange: (value) => {
        streaming = value;
      },
    });

    await controller.adapter.sendMessage({ role: 'user', content: 'hi' }, []);

    expect(errors).toEqual([startFailure, endFailure]);
    expect(streaming).toBe(false);
    // The session is free for the next turn: the failed observers released nothing they owned.
    await controller.adapter.sendMessage({ role: 'user', content: 'again' }, []);
    expect(errors).toEqual([startFailure, endFailure, startFailure, endFailure]);
  });
});

describe('the detached end of a run', () => {
  test('reports a failure that escapes it through onError, not as an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const unreadable = new Error('the conversation could not be read');
    let ended = false;
    let conversation: ConversationHistory = createConversationHistory({ id: 'detached-end' });
    const controller = createChatSessionController({
      // Once the run has ended, the follow-up queue's own read of the conversation fails.
      getConversation: () => {
        if (ended) throw unreadable;
        return conversation;
      },
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => events([{ type: 'text', text: 'ok' }]),
      hooks: {
        onError: (error) => errors.push(error),
        onStreamingChange: (streaming) => {
          if (!streaming) ended = true;
        },
      },
    });

    await controller.adapter.sendMessage({ role: 'user', content: 'hi' }, []);

    await waitUntil(() => errors.length > 0, { message: 'the detached failure was reported' });
    expect(errors).toEqual([unreadable]);
  });
});
