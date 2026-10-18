import { throwingRejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import {
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from '../components/chat/builders.ts';
import {
  approvalAction,
  attachment,
  createHarness,
  deferred,
  deliveryStatus,
  eventsOf,
  settle,
  textOf,
} from './session-controller-run-input-test-support.ts';
import { createChatSessionController } from './session-controller.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

describe('chat session controller run input', () => {
  test('a message submitted during a run goes through sendRunInput with its attachments', async () => {
    const harness = createHarness();
    const file = attachment('notes');

    const run = harness.startRun();
    await settle();
    await harness.controller.adapter.sendRunInput?.(
      'run-input',
      { role: 'user', content: 'also this' },
      [file],
    );
    harness.releaseRun();
    await run;

    expect(harness.calls).toEqual([
      {
        conversationId: 'run-input',
        message: { role: 'user', content: 'also this' },
        attachments: [file],
        options: { messageId: harness.rowNamed('also this')!.id },
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
        action: approvalAction,
      },
    );
    const received: string[] = [];
    let resolved = 0;
    let transportCalls = 0;
    const controller = createChatSessionController({
      executionOwner: 'server',
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
    let runSettled = false;
    void run.then(() => {
      runSettled = true;
    });
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

    // The run is untouched: it is still streaming until the test releases it.
    await settle();
    expect(runSettled).toBe(false);
    harness.releaseRun();
    await run;
    expect(harness.rows().some((row) => row.content === 'working')).toBe(true);
    expect(deliveryStatus(harness.conversation(), 'start')).toBeUndefined();
    expect(harness.conversation().ids).toContain(
      harness.rows().find((row) => row.content === 'nope')!.id,
    );
  });

  test('a run that fails keeps the follow-ups the user sent while it worked', async () => {
    const failure = deferred();
    const harness = createHarness({
      turns: [
        () =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'partial' };
            await failure.promise;
          })(),
      ],
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
      turns: [() => eventsOf([{ type: 'text', text: 'reply' }])],
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
