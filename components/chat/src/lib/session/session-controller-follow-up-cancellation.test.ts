import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { appendMessages, createConversationHistory } from '../components/chat/builders.ts';
import { assertRunInputAccepted } from './session-controller-run-input-receipt.ts';
import {
  attachment,
  createHarness,
  deferred,
  deliveryStatus,
  isFollowUp,
  settle,
} from './session-controller-run-input-test-support.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

describe('receipts decide the acknowledgement', () => {
  test.each(['accepted', 'queued', 'promoted'])('a %s receipt is an acknowledgement', (state) => {
    expect(() => assertRunInputAccepted({ state })).not.toThrow();
  });

  test('a canceled receipt from an immediate self-cancel rejects, naming its state', async () => {
    const harness = createHarness({
      sendRunInput: async () => assertRunInputAccepted({ state: 'canceled' }),
    });
    const run = harness.startRun();
    await settle();

    const rejection = await rejectionOf(
      harness.controller.adapter.sendRunInput!('run-input', { role: 'user', content: 'late' }, []),
    );

    expect((rejection as Error).message).toContain('canceled');
    expect(deliveryStatus(harness.conversation(), 'late')).toBe('failed');
    harness.releaseRun();
    await run;
  });

  test('a replay of an input that was already cancelled rejects too', async () => {
    // `replayed` is an admission outcome, but the receipt it carries says what
    // became of the input, and that is what the hook must act on.
    const replay = { outcome: 'replayed', receipt: { state: 'canceled' } };
    const harness = createHarness({
      sendRunInput: async () => assertRunInputAccepted(replay.receipt),
    });
    const run = harness.startRun();
    await settle();

    expect(
      await throwingRejectionOf(
        harness.controller.adapter.sendRunInput!(
          'run-input',
          { role: 'user', content: 'again' },
          [],
        ),
      ),
    ).toThrow('canceled');
    expect(deliveryStatus(harness.conversation(), 'again')).toBe('failed');
    harness.releaseRun();
    await run;
  });
});

describe('a follow-up the server cancelled after hand-off', () => {
  /**
   * A server-owned run whose terminal history never names the follow-up. The
   * stream stays open after the terminal frame so a stop can still land.
   */
  function runWithoutDelivery(hold: boolean) {
    const gate = deferred();
    const harness = createHarness({
      executionOwner: 'server',
      turns: [
        (request) =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'working', wireVersion: 1, sequence: 0 };
            await gate.promise;
            let terminal = createConversationHistory({ id: 'run-input' });
            terminal = appendMessages(
              terminal,
              { role: 'user', content: 'start' },
              { randomId: () => request.conversation.ids[0]! },
            );
            terminal = appendMessages(
              terminal,
              { role: 'assistant', content: 'done without it' },
              { randomId: () => 'server-reply' },
            );
            yield {
              type: 'run.completed',
              conversation: terminal,
              content: '',
              usage: { prompt: 0, completion: 0, total: 0 },
              finishReason: 'stop',
              wireVersion: 1,
              sequence: 1,
            };
            if (hold)
              await new Promise<void>((resolve) =>
                request.signal.addEventListener('abort', () => resolve(), { once: true }),
              );
          })(),
      ],
    });
    return { harness, gate };
  }

  test('is promoted to an ordinary turn after the run ends, on its row and attachments', async () => {
    const { harness, gate } = runWithoutDelivery(false);
    const run = harness.startRun();
    await settle();
    const sent = harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'too late' },
      [attachment('late-file')],
    );
    await sent;
    const rowId = harness.rowNamed('too late')!.id;
    expect(deliveryStatus(harness.conversation(), 'too late')).toBeUndefined();

    gate.resolve();
    await run;
    await settle();

    expect(harness.turns).toHaveLength(2);
    const turn = harness.turns[1]!;
    expect(
      turn.conversation.ids
        .map((id) => turn.conversation.messages[id]!)
        .findLast((row) => row.role === 'user' && row.metadata['_followUp'] !== true)?.id,
    ).toBe(rowId);
    expect(turn.attachments).toEqual([attachment('late-file')]);
    expect(isFollowUp(harness.conversation(), 'too late')).toBe(false);
    expect(deliveryStatus(harness.conversation(), 'too late')).toBeUndefined();
    expect(harness.rows().filter((row) => row.content === 'too late')).toHaveLength(1);
  });

  test('is marked failed with retry when this client pressed stop', async () => {
    const { harness, gate } = runWithoutDelivery(true);
    const run = harness.startRun();
    await settle();
    await harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'too late' },
      [],
    );
    gate.resolve();
    await settle();
    await harness.controller.adapter.stopGenerating?.('anything');
    await run;
    await settle();

    expect(harness.turns).toHaveLength(1);
    expect(deliveryStatus(harness.conversation(), 'too late')).toBe('failed');
    expect(isFollowUp(harness.conversation(), 'too late')).toBe(true);

    // The retry is the user's, and it sends the row as an ordinary turn.
    await harness.controller.adapter.retryMessage?.(harness.rowNamed('too late')!.id);
    expect(harness.turns).toHaveLength(2);
    expect(isFollowUp(harness.conversation(), 'too late')).toBe(false);
  });

  test('a follow-up the terminal history does name is left alone', async () => {
    const gate = deferred();
    let followUpId = '';
    const harness = createHarness({
      executionOwner: 'server',
      turns: [
        (request) =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'working', wireVersion: 1, sequence: 0 };
            await gate.promise;
            const ids = [request.conversation.ids[0]!, followUpId, 'server-reply'];
            let next = 0;
            const environment = { randomId: () => ids[next++]! };
            let terminal = createConversationHistory({ id: 'run-input' });
            terminal = appendMessages(terminal, { role: 'user', content: 'start' }, environment);
            terminal = appendMessages(terminal, { role: 'user', content: 'seen' }, environment);
            terminal = appendMessages(
              terminal,
              { role: 'assistant', content: 'answered both' },
              environment,
            );
            yield {
              type: 'run.completed',
              conversation: terminal,
              content: '',
              usage: { prompt: 0, completion: 0, total: 0 },
              finishReason: 'stop',
              wireVersion: 1,
              sequence: 1,
            };
          })(),
      ],
    });
    const run = harness.startRun();
    await settle();
    await harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'seen' },
      [],
    );
    followUpId = harness.rowNamed('seen')!.id;
    gate.resolve();
    await run;
    await settle();

    expect(harness.turns).toHaveLength(1);
    expect(isFollowUp(harness.conversation(), 'seen')).toBe(true);
    expect(deliveryStatus(harness.conversation(), 'seen')).toBeUndefined();
  });
});
