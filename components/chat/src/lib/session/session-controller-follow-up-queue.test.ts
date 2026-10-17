import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { createConversationHistory } from '../components/chat/builders.ts';
import {
  approvalFrames,
  attachment,
  createHarness,
  deferred,
  deliveryStatus,
  isFollowUp,
  settle,
  textOf,
} from './session-controller-run-input-test-support.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

/**
 * A harness whose first follow-up is handed to the hook and then held there,
 * so the follow-ups sent after it are still queued when the run ends.
 */
function queuedBehindSlowAck(options: Parameters<typeof createHarness>[0] = {}) {
  const firstAck = deferred();
  const handed: string[] = [];
  const harness = createHarness({
    ...options,
    sendRunInput: async (_conversationId, message) => {
      handed.push(textOf(message));
      if (handed.length === 1) await firstAck.promise;
    },
  });
  const send = (content: string, attachments = [attachment(`${content}-file`)]) =>
    harness.controller.adapter.sendRunInput!('run-input', { role: 'user', content }, attachments);
  return { harness, handed, firstAck, send };
}

describe('follow-ups still queued when the run ends', () => {
  test('a completed run sends a queued follow-up as an ordinary turn on its existing row', async () => {
    const { harness, handed, firstAck, send } = queuedBehindSlowAck();

    const run = harness.startRun();
    await settle();
    const first = send('first');
    await settle();
    const second = send('second', [attachment('second-file')]);
    await settle();
    const secondRowId = harness.rowNamed('second')!.id;
    harness.releaseRun();
    await run;
    await second;

    // Never handed to the hook: it became the opener of its own turn.
    expect(handed).toEqual(['first']);
    expect(harness.turns).toHaveLength(2);
    const turn = harness.turns[1]!;
    const lastUser = turn.conversation.ids
      .map((id) => turn.conversation.messages[id]!)
      .findLast((row) => row.role === 'user' && row.metadata['_followUp'] !== true)!;
    expect(lastUser.id).toBe(secondRowId);
    expect(turn.attachments).toEqual([attachment('second-file')]);
    expect(harness.rows().filter((row) => row.content === 'second')).toHaveLength(1);
    expect(isFollowUp(harness.conversation(), 'second')).toBe(false);
    expect(deliveryStatus(harness.conversation(), 'second')).toBeUndefined();
    firstAck.resolve();
    await first;
  });

  test('a failed run sends a queued follow-up as an ordinary turn', async () => {
    const failure = deferred();
    const { harness, handed, firstAck, send } = queuedBehindSlowAck({
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
    const first = send('first');
    await settle();
    const second = send('second');
    await settle();
    failure.reject(new Error('transport failed'));
    expect(await throwingRejectionOf(run)).toThrow('transport failed');
    await second;

    expect(handed).toEqual(['first']);
    expect(harness.turns).toHaveLength(2);
    expect(isFollowUp(harness.conversation(), 'second')).toBe(false);
    firstAck.resolve();
    await first;
  });

  test('a stopped run marks a queued follow-up failed, with retry, and does not send it', async () => {
    const { harness, handed, firstAck, send } = queuedBehindSlowAck();

    const run = harness.startRun();
    await settle();
    const first = send('first');
    await settle();
    const second = send('second');
    const secondRejection = rejectionOf(second);
    await settle();
    await harness.controller.adapter.stopGenerating?.('anything');
    await run;

    expect(await secondRejection).toBeInstanceOf(Error);
    expect(handed).toEqual(['first']);
    expect(harness.turns).toHaveLength(1);
    expect(deliveryStatus(harness.conversation(), 'second')).toBe('failed');
    expect(isFollowUp(harness.conversation(), 'second')).toBe(true);
    firstAck.resolve();
    await first;
  });

  test('several queued follow-ups go out as sequential ordinary turns in the order sent', async () => {
    const secondTurn = deferred();
    const { harness, handed, firstAck, send } = queuedBehindSlowAck({
      turns: [
        undefined,
        () =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'second turn' };
            await secondTurn.promise;
          })(),
      ],
    });
    // The first turn keeps the default held script, so only the second is scripted.
    const run = harness.startRun();
    await settle();
    const first = send('first');
    await settle();
    const second = send('second');
    const third = send('third');
    await settle();
    harness.releaseRun();
    await run;
    await settle();

    // The second turn is open and the third waits for it to end.
    expect(harness.turns).toHaveLength(2);
    secondTurn.resolve();
    await Promise.all([second, third]);

    expect(harness.turns).toHaveLength(3);
    const openers = harness.turns
      .slice(1)
      .map(
        (turn) =>
          turn.conversation.ids
            .map((id) => turn.conversation.messages[id]!)
            .findLast((row) => row.role === 'user' && row.metadata['_followUp'] !== true)!.content,
      );
    expect(openers).toEqual(['second', 'third']);
    expect(handed).toEqual(['first']);
    firstAck.resolve();
    await first;
  });

  test('a run parked on an approval has not ended, so nothing is promoted', async () => {
    const gate = deferred();
    const { harness, handed, firstAck, send } = queuedBehindSlowAck({
      turns: [
        () =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'working' };
            await gate.promise;
            yield* approvalFrames;
          })(),
      ],
    });

    const run = harness.startRun();
    await settle();
    const first = send('first');
    await settle();
    const second = send('second');
    await settle();
    gate.resolve();
    await run;

    expect(harness.turns).toHaveLength(1);
    expect(isFollowUp(harness.conversation(), 'second')).toBe(true);
    firstAck.resolve();
    await first;
    await second;
    // Once the first acknowledgement frees the queue, the parked run takes the input.
    expect(handed).toEqual(['first', 'second']);
  });
});

describe('promotion', () => {
  test('a promoted follow-up owns the new run, is the turn sent, and can be retried after it fails', async () => {
    const failure = deferred();
    const { harness, firstAck, send } = queuedBehindSlowAck({
      turns: [
        undefined,
        () =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'trying' };
            await failure.promise;
          })(),
      ],
      hooks: {
        resolveToolApproval: async (callId) => ({ callId, outcome: 'success', content: 'ok' }),
      },
    });
    const run = harness.startRun();
    await settle();
    const first = send('first');
    await settle();
    const second = send('second');
    await settle();
    const secondId = harness.rowNamed('second')!.id;
    harness.releaseRun();
    await run;
    await settle();

    expect(harness.turns).toHaveLength(2);
    failure.reject(new Error('second turn failed'));
    expect(await throwingRejectionOf(second)).toThrow('second turn failed');

    // The promoted row is the failed opener now, so it can be retried.
    expect(deliveryStatus(harness.conversation(), 'second')).toBe('failed');
    await harness.controller.adapter.retryMessage?.(secondId);
    expect(harness.turns).toHaveLength(3);
    firstAck.resolve();
    await first;
  });

  test('a promoted follow-up owns the tool calls of its run', async () => {
    const { harness, firstAck, send } = queuedBehindSlowAck({
      turns: [
        undefined,
        () =>
          (async function* () {
            yield* approvalFrames;
          })(),
      ],
      hooks: {
        resolveToolApproval: async (callId) => ({ callId, outcome: 'success', content: 'ok' }),
      },
    });
    const run = harness.startRun();
    await settle();
    const first = send('first');
    await settle();
    const second = send('second', [attachment('second-file')]);
    await settle();
    harness.releaseRun();
    await run;
    await second;
    await harness.controller.adapter.resolveToolApproval?.('call', {
      decision: 'approve',
      remember: false,
    });

    expect(harness.turns).toHaveLength(3);
    expect(harness.turns[2]!.attachments).toEqual([attachment('second-file')]);
    firstAck.resolve();
    await first;
  });
});

describe('retrying a failed follow-up', () => {
  test('with a run in progress it is resent through the hook with the same messageId', async () => {
    let attempts = 0;
    const harness = createHarness({
      sendRunInput: async (_id, _message, _attachments, hookOptions) => {
        attempts += 1;
        harness.calls.push({
          conversationId: _id,
          message: _message,
          attachments: _attachments,
          options: hookOptions,
        });
        if (attempts === 1) throw new Error('refused');
      },
    });
    const run = harness.startRun();
    await settle();
    await harness.controller.adapter
      .sendRunInput?.('run-input', { role: 'user', content: 'again' }, [])
      .catch(() => undefined);
    const rowId = harness.rowNamed('again')!.id;

    await harness.controller.adapter.retryMessage?.(rowId);

    expect(harness.calls.map((call) => call.options.messageId)).toEqual([rowId, rowId]);
    expect(deliveryStatus(harness.conversation(), 'again')).toBeUndefined();
    harness.releaseRun();
    await run;
  });

  test('a queued follow-up failed by a stop is promoted when retried', async () => {
    const { harness, firstAck, send } = queuedBehindSlowAck();
    const run = harness.startRun();
    await settle();
    const first = send('first');
    await settle();
    const second = send('second', [attachment('second-file')]);
    const secondRejection = rejectionOf(second);
    await settle();
    await harness.controller.adapter.stopGenerating?.('anything');
    await run;
    await secondRejection;
    const secondId = harness.rowNamed('second')!.id;

    await harness.controller.adapter.retryMessage?.(secondId);

    expect(harness.turns).toHaveLength(2);
    expect(harness.turns[1]!.attachments).toEqual([attachment('second-file')]);
    expect(isFollowUp(harness.conversation(), 'second')).toBe(false);
    expect(deliveryStatus(harness.conversation(), 'second')).toBeUndefined();
    firstAck.resolve();
    await first;
  });

  test('a row the hook rejected, whose run ended before the retry, is promoted', async () => {
    const refusal = deferred();
    const harness = createHarness({ sendRunInput: () => refusal.promise });
    const run = harness.startRun();
    await settle();
    const sent = harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'late' },
      [],
    );
    const rejection = rejectionOf(sent);
    await settle();
    harness.releaseRun();
    await run;
    refusal.reject(new Error('refused after the run ended'));
    await rejection;
    expect(deliveryStatus(harness.conversation(), 'late')).toBe('failed');

    await harness.controller.adapter.retryMessage?.(harness.rowNamed('late')!.id);

    expect(harness.turns).toHaveLength(2);
    expect(isFollowUp(harness.conversation(), 'late')).toBe(false);
  });

  test('refusing to retry a pending follow-up leaves it retryable once it fails', async () => {
    const ack = deferred();
    let attempts = 0;
    const harness = createHarness({
      sendRunInput: async () => {
        attempts += 1;
        if (attempts === 1) await ack.promise;
      },
    });
    const run = harness.startRun();
    await settle();
    const sent = harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'pending' },
      [],
    );
    const rejection = rejectionOf(sent);
    await settle();
    const rowId = harness.rowNamed('pending')!.id;

    // Pending, not failed: the retry is refused and must not forget the row.
    expect(await rejectionOf(harness.controller.adapter.retryMessage!(rowId))).toBeInstanceOf(
      Error,
    );

    ack.reject(new Error('refused'));
    await rejection;
    await harness.controller.adapter.retryMessage?.(rowId);
    expect(attempts).toBe(2);
    harness.releaseRun();
    await run;
  });
});

describe('invalidation and conversation changes', () => {
  test('invalidate() retires a pending acknowledgement', async () => {
    const ack = deferred();
    const harness = createHarness({ sendRunInput: () => ack.promise });
    const run = harness.startRun();
    await settle();
    const sent = harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'in flight' },
      [],
    );
    await settle();

    harness.controller.invalidate();
    ack.resolve();
    await sent;
    harness.releaseRun();

    // The acknowledgement landed after the host retired outstanding work, so it
    // writes nothing: the row is left exactly as it was.
    expect(deliveryStatus(harness.conversation(), 'in flight')).toBe('sending');
    await run;
  });

  test('invalidate() retires a pending rejection, and tells the sender it did not complete', async () => {
    const ack = deferred();
    const harness = createHarness({ sendRunInput: () => ack.promise });
    const run = harness.startRun();
    await settle();
    const sent = harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'in flight' },
      [],
    );
    const rejection = rejectionOf(sent);
    await settle();

    harness.controller.invalidate();
    ack.reject(new Error('refused'));

    expect(((await rejection) as Error).message).toContain('invalidated');
    // Nothing lands: the row stays as it was, and the hook's refusal is not reported.
    expect(deliveryStatus(harness.conversation(), 'in flight')).toBe('sending');
    expect(harness.errors).toEqual([]);
    harness.releaseRun();
    await run;
  });

  test('a stop does not retire an acknowledgement the hook still owes', async () => {
    const ack = deferred();
    const harness = createHarness({ sendRunInput: () => ack.promise });
    const run = harness.startRun();
    await settle();
    const sent = harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'handed over' },
      [],
    );
    await settle();
    await harness.controller.adapter.stopGenerating?.('anything');
    await run;

    ack.resolve();
    await sent;

    // The acknowledgement still lands, and with the stop known the follow-up the
    // run never delivered is failed with a retry rather than left pending.
    expect(deliveryStatus(harness.conversation(), 'handed over')).toBe('failed');
  });

  test('a follow-up still queued when the host invalidates is rejected, not delivered', async () => {
    const { harness, handed, firstAck, send } = queuedBehindSlowAck();
    const run = harness.startRun();
    await settle();
    const first = send('first');
    await settle();
    const second = send('second');
    const rejection = rejectionOf(second);
    await settle();

    harness.controller.invalidate();
    firstAck.resolve();
    await first;

    expect(((await rejection) as Error).message).toContain('invalidated');
    expect(handed).toEqual(['first']);
    // Like a conversation change: the row is marked failed and the error reported.
    expect(deliveryStatus(harness.conversation(), 'second')).toBe('failed');
    expect(harness.errors).toHaveLength(1);
    harness.releaseRun();
    await run;
  });

  test('a follow-up still queued when the session is disposed is rejected, not delivered', async () => {
    const { harness, handed, firstAck, send } = queuedBehindSlowAck();
    const run = harness.startRun();
    await settle();
    const first = send('first');
    await settle();
    const second = send('second');
    const rejection = rejectionOf(second);
    await settle();

    harness.controller.dispose();
    firstAck.resolve();
    await first;

    expect(((await rejection) as Error).message).toContain('disposed');
    expect(handed).toEqual(['first']);
    harness.releaseRun();
    await run.catch(() => undefined);
  });

  test('a follow-up still queued when the conversation switches is rejected, not dropped silently', async () => {
    const { harness, firstAck, send } = queuedBehindSlowAck();
    const run = harness.startRun();
    await settle();
    const first = send('first');
    await settle();
    const second = send('second');
    const rejection = rejectionOf(second);
    await settle();

    harness.setConversation(createConversationHistory({ id: 'another-conversation' }));
    firstAck.resolve();
    await first.catch(() => undefined);

    expect(((await rejection) as Error).message).toContain('conversation');
    expect(harness.errors).toHaveLength(1);
    harness.releaseRun();
    await run.catch(() => undefined);
  });
});

describe('the host hook', () => {
  test('receives the row id as messageId', async () => {
    const harness = createHarness();
    const run = harness.startRun();
    await settle();

    await harness.controller.adapter.sendRunInput?.(
      'run-input',
      { role: 'user', content: 'identified' },
      [],
    );

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.options).toEqual({ messageId: harness.rowNamed('identified')!.id });
    harness.releaseRun();
    await run;
  });
});
