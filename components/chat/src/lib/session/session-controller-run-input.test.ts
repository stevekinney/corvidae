import { throwingRejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import {
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from '../components/chat/builders.ts';
import type { ConversationHistory, MessageInput } from '../components/chat/conversation-model.ts';
import type { ChatAttachment } from '../components/chat/input/chat-attachment.ts';
import type { ChatSessionControllerOptions } from './session-controller-support.ts';
import { createChatSessionController } from './session-controller.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

function textOf(message: MessageInput): string {
  return typeof message.content === 'string' ? message.content : '';
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

type RunInputCall = {
  conversationId: string;
  message: MessageInput;
  attachments: ChatAttachment[];
};

/** A controller whose first run stays open until the test releases it. */
function createHarness(
  options: {
    conversation?: ConversationHistory;
    sendRunInput?: ChatSessionControllerOptions['sendRunInput'] | null;
    transport?: ChatSessionControllerOptions['transport'];
  } = {},
) {
  let conversation = options.conversation ?? createConversationHistory({ id: 'run-input' });
  const calls: RunInputCall[] = [];
  const run = deferred();
  const errors: unknown[] = [];
  const sendRunInput: ChatSessionControllerOptions['sendRunInput'] =
    options.sendRunInput === undefined
      ? async (conversationId, message, attachments) => {
          calls.push({ conversationId, message, attachments });
        }
      : (options.sendRunInput ?? undefined);
  const controller = createChatSessionController({
    getConversation: () => conversation,
    setConversation: (next) => {
      conversation = next;
    },
    transport:
      options.transport ??
      (async () => {
        async function* held(): AsyncGenerator<ChatStreamEvent> {
          yield { type: 'text', text: 'working' };
          await run.promise;
        }
        return held();
      }),
    ...(sendRunInput ? { sendRunInput } : {}),
    hooks: { onError: (error) => errors.push(error) },
  });
  const startRun = async () => {
    const pending = controller.adapter.sendMessage({ role: 'user', content: 'start' }, []);
    await settle();
    return pending;
  };
  return {
    controller,
    calls,
    errors,
    releaseRun: () => run.resolve(),
    startRun,
    conversation: () => conversation,
    rows: () => conversation.ids.map((id) => conversation.messages[id]!),
  };
}

function deliveryStatus(history: ConversationHistory, content: string): unknown {
  return Object.values(history.messages).find((message) => message.content === content)?.metadata[
    '_deliveryStatus'
  ];
}

describe('chat session controller run input', () => {
  test('a message submitted during a run goes through sendRunInput with its attachments', async () => {
    const harness = createHarness();
    const attachment = { id: 'a', name: 'notes.txt' } as unknown as ChatAttachment;

    const run = harness.startRun();
    await settle();
    await harness.controller.adapter.sendRunInput?.(
      'run-input',
      { role: 'user', content: 'also this' },
      [attachment],
    );
    harness.releaseRun();
    await run;

    expect(harness.calls).toEqual([
      {
        conversationId: 'run-input',
        message: { role: 'user', content: 'also this' },
        attachments: [attachment],
      },
    ]);
  });

  test('without sendRunInput a second turn during a run is still refused', async () => {
    const harness = createHarness({ sendRunInput: null });

    const run = harness.startRun();
    await settle();

    expect(harness.controller.adapter.sendRunInput).toBeUndefined();
    expect(
      await throwingRejectionOf(
        harness.controller.adapter.sendMessage({ role: 'user', content: 'second' }, []),
      ),
    ).toThrow('Chat session is already running');
    harness.releaseRun();
    await run;
  });

  test('the follow-up is pending in the transcript until the transport acknowledges it', async () => {
    const acknowledgement = deferred();
    const harness = createHarness({ sendRunInput: () => acknowledgement.promise });

    const run = harness.startRun();
    await settle();
    const followUp = harness.controller.adapter.sendRunInput?.(
      'run-input',
      { role: 'user', content: 'and also' },
      [],
    );
    await settle();

    expect(deliveryStatus(harness.conversation(), 'and also')).toBe('sending');
    acknowledgement.resolve();
    await followUp;
    expect(deliveryStatus(harness.conversation(), 'and also')).toBeUndefined();
    harness.releaseRun();
    await run;
  });

  test('follow-ups reach the transport, and the transcript, in the order they were sent', async () => {
    const acknowledgements = [deferred(), deferred()];
    const seen: string[] = [];
    const harness = createHarness({
      sendRunInput: async (_conversationId, message) => {
        seen.push(textOf(message));
        await acknowledgements[seen.length - 1]!.promise;
      },
    });

    const run = harness.startRun();
    await settle();
    const first = harness.controller.adapter.sendRunInput?.(
      'run-input',
      { role: 'user', content: 'first' },
      [],
    );
    const second = harness.controller.adapter.sendRunInput?.(
      'run-input',
      { role: 'user', content: 'second' },
      [],
    );
    await settle();

    // The second waits for the first's acknowledgement, so a slow first
    // delivery cannot be overtaken.
    expect(seen).toEqual(['first']);
    acknowledgements[0]!.resolve();
    await settle();
    expect(seen).toEqual(['first', 'second']);
    acknowledgements[1]!.resolve();
    await Promise.all([first, second]);

    const userContents = harness
      .rows()
      .filter((row) => row.role === 'user')
      .map((row) => row.content);
    expect(userContents).toEqual(['start', 'first', 'second']);
    harness.releaseRun();
    await run;
  });

  test('a follow-up while an approval is pending is accepted and does not resolve the approval', async () => {
    let conversation = appendToolResult(
      appendToolCall(appendUserMessage(createConversationHistory({ id: 'run-input' }), 'write'), {
        id: 'call',
        name: 'write',
        arguments: {},
      }),
      {
        callId: 'call',
        outcome: 'action_required',
        content: null,
        action: {
          type: 'approval',
          message: 'Approve this tool call',
          risk: 'high',
          operation: { kind: 'command', command: 'echo approval', argsPreview: {} },
          policyVersion: 'test-policy',
          idempotencyKey: 'test-approval',
        },
      },
    );
    const received: string[] = [];
    let resolved = 0;
    let transportCalls = 0;
    const controller = createChatSessionController({
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => {
        transportCalls += 1;
        return (async function* (): AsyncGenerator<ChatStreamEvent> {})();
      },
      sendRunInput: async (_id, message) => {
        received.push(textOf(message));
      },
      hooks: {
        resolveToolApproval: async () => {
          resolved += 1;
          return undefined;
        },
      },
    });

    await controller.adapter.sendRunInput?.('run-input', { role: 'user', content: 'wait' }, []);

    expect(received).toEqual(['wait']);
    expect(resolved).toBe(0);
    expect(transportCalls).toBe(0);
    const result = Object.values(conversation.messages).find(
      (message) => message.role === 'tool-result',
    )?.toolResult;
    expect(result?.outcome).toBe('action_required');
    // The pending approval can still be resolved afterwards.
    expect(
      await throwingRejectionOf(
        controller.adapter.resolveToolApproval?.('call', { decision: 'approve', remember: false }),
      ),
    ).toThrow('Approval resolution hook must return a tool result');
    expect(resolved).toBe(1);
  });

  test('a transport rejection marks the message failed, leaves the run alone, and can be retried', async () => {
    let attempts = 0;
    const harness = createHarness({
      sendRunInput: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('input refused');
      },
    });

    const run = harness.startRun();
    await settle();
    expect(
      await throwingRejectionOf(
        harness.controller.adapter.sendRunInput?.(
          'run-input',
          { role: 'user', content: 'nope' },
          [],
        ),
      ),
    ).toThrow('input refused');

    expect(deliveryStatus(harness.conversation(), 'nope')).toBe('failed');
    expect(harness.errors).toHaveLength(1);

    // The run is untouched: it is still streaming and finishes normally.
    harness.releaseRun();
    await run;
    expect(harness.rows().some((row) => row.content === 'working')).toBe(true);
    expect(deliveryStatus(harness.conversation(), 'start')).toBeUndefined();
    expect(harness.conversation().ids).toContain(
      harness.rows().find((row) => row.content === 'nope')!.id,
    );
  });

  test('retrying a failed follow-up resends it as run input while the run is active', async () => {
    let attempts = 0;
    const sent: string[] = [];
    const harness = createHarness({
      sendRunInput: async (_id, message) => {
        attempts += 1;
        sent.push(textOf(message));
        if (attempts === 1) throw new Error('input refused');
      },
    });

    const run = harness.startRun();
    await settle();
    await harness.controller.adapter
      .sendRunInput?.('run-input', { role: 'user', content: 'again' }, [])
      .catch(() => undefined);
    const failedId = harness.rows().find((row) => row.content === 'again')!.id;

    await harness.controller.adapter.retryMessage?.(failedId);

    expect(sent).toEqual(['again', 'again']);
    expect(deliveryStatus(harness.conversation(), 'again')).toBeUndefined();
    harness.releaseRun();
    await run;
  });

  test('a run that fails keeps the follow-ups the user sent while it worked', async () => {
    const failure = deferred();
    const harness = createHarness({
      transport: async () => {
        async function* failing(): AsyncGenerator<ChatStreamEvent> {
          yield { type: 'text', text: 'partial' };
          await failure.promise;
        }
        return failing();
      },
    });

    const run = harness.startRun();
    await settle();
    await harness.controller.adapter.sendRunInput?.(
      'run-input',
      { role: 'user', content: 'kept' },
      [],
    );
    failure.reject(new Error('transport failed'));
    expect(await throwingRejectionOf(run)).toThrow('transport failed');

    expect(harness.rows().map((row) => row.content)).toContain('kept');
    expect(deliveryStatus(harness.conversation(), 'start')).toBe('failed');
  });

  test('with nothing running, sendRunInput behaves as an ordinary send', async () => {
    const harness = createHarness({
      transport: async () =>
        (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: 'text', text: 'reply' };
        })(),
    });

    await harness.controller.adapter.sendRunInput?.(
      'run-input',
      { role: 'user', content: 'plain' },
      [],
    );

    expect(harness.calls).toEqual([]);
    expect(harness.rows().map((row) => row.content)).toEqual(['plain', 'reply']);
  });

  test('refuses input addressed to another conversation', async () => {
    const harness = createHarness();

    expect(
      await throwingRejectionOf(
        harness.controller.adapter.sendRunInput?.(
          'someone-else',
          { role: 'user', content: 'misdirected' },
          [],
        ),
      ),
    ).toThrow('Run input targets a different conversation');
  });
});
