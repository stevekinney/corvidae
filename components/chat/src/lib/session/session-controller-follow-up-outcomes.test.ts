import { throwingRejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { appendMessages, createConversationHistory } from '../components/chat/builders.ts';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import { mergeRunHistory } from './session-controller-rows.ts';
import {
  createHarness,
  deferred,
  deliveryStatus,
  isFollowUp,
  settle,
  type TurnScript,
} from './session-controller-run-input-test-support.ts';
import { createChatSessionController } from './session-controller.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

/** A terminal history made of the given rows, under the ids the client already uses. */
function terminalOf(
  request: Parameters<TurnScript>[0],
  rows: Array<{ id: string; role: 'user' | 'assistant'; content: string }>,
): ConversationHistory {
  let history = createConversationHistory({ id: request.conversation.id });
  const ids = rows.map((row) => row.id);
  let next = 0;
  for (const row of rows)
    history = appendMessages(
      history,
      { role: row.role, content: row.content },
      { randomId: () => ids[next++]! },
    );
  return history;
}

function completed(terminal: ConversationHistory, sequence: number): ChatStreamEvent {
  return {
    type: 'run.completed',
    conversation: terminal,
    content: '',
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: 'stop',
    wireVersion: 1,
    sequence,
  };
}

describe('a follow-up whose run ended without delivering it', () => {
  test('a real mid-stream stop, with no terminal history, fails the follow-up with a retry', async () => {
    const harness = createHarness();
    const run = harness.startRun();
    await settle();
    await harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'follow' },
      [],
    );

    await harness.controller.adapter.stopGenerating?.('anything');
    await run;
    await settle();

    expect(harness.turns).toHaveLength(1);
    expect(deliveryStatus(harness.conversation(), 'follow')).toBe('failed');
    expect(isFollowUp(harness.conversation(), 'follow')).toBe(true);
  });

  test('a failure with no terminal history promotes the follow-up to an ordinary turn', async () => {
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
    await harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'follow' },
      [],
    );
    failure.reject(new Error('run.error'));
    await run.catch(() => undefined);
    await settle();

    expect(harness.turns).toHaveLength(2);
    expect(isFollowUp(harness.conversation(), 'follow')).toBe(false);
    expect(harness.rows().filter((row) => row.content === 'follow')).toHaveLength(1);
  });

  /** A run whose terminal history omits the follow-up, or names it. */
  function runEndingWithHandOffInFlight(options: { terminalNamesIt: boolean }) {
    const ack = deferred();
    const gate = deferred();
    let followUpId = '';
    const harness = createHarness({
      sendRunInput: async () => {
        await ack.promise;
      },
      turns: [
        (request) =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'working', wireVersion: 1, sequence: 0 };
            await gate.promise;
            const rows = [
              { id: request.conversation.ids[0]!, role: 'user' as const, content: 'start' },
              ...(options.terminalNamesIt
                ? [{ id: followUpId, role: 'user' as const, content: 'late' }]
                : []),
              { id: 'server-reply', role: 'assistant' as const, content: 'done' },
            ];
            yield completed(terminalOf(request, rows), 1);
          })(),
      ],
    });
    return {
      harness,
      ack,
      async run(): Promise<{ sent: Promise<void> | undefined }> {
        const started = harness.startRun();
        await settle();
        const sent = harness.controller.adapter.sendRunInput!(
          'run-input',
          { role: 'user', content: 'late' },
          [],
        );
        await settle();
        followUpId = harness.rowNamed('late')!.id;
        gate.resolve();
        await started;
        await settle();
        return { sent };
      },
    };
  }

  test('an acknowledgement that arrives after the run ended promotes a follow-up the history omits', async () => {
    const scenario = runEndingWithHandOffInFlight({ terminalNamesIt: false });
    const { sent } = await scenario.run();

    // Still in the hook's hands: nothing is decided until it is acknowledged.
    expect(scenario.harness.turns).toHaveLength(1);
    expect(deliveryStatus(scenario.harness.conversation(), 'late')).toBe('sending');

    scenario.ack.resolve();
    await sent;
    await settle();

    expect(scenario.harness.turns).toHaveLength(2);
    expect(isFollowUp(scenario.harness.conversation(), 'late')).toBe(false);
  });

  test('an acknowledgement that arrives after the run ended leaves a delivered follow-up alone', async () => {
    const scenario = runEndingWithHandOffInFlight({ terminalNamesIt: true });
    const { sent } = await scenario.run();

    scenario.ack.resolve();
    await sent;
    await settle();

    expect(scenario.harness.turns).toHaveLength(1);
    expect(isFollowUp(scenario.harness.conversation(), 'late')).toBe(true);
    expect(deliveryStatus(scenario.harness.conversation(), 'late')).toBeUndefined();
  });
});

describe('a refusal that arrives after the run ended', () => {
  test('marks the follow-up failed and leaves nothing waiting on it', async () => {
    const refusal = deferred();
    const harness = createHarness({
      sendRunInput: async () => {
        await refusal.promise;
      },
    });
    const run = harness.startRun();
    await settle();
    const sent = harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'refused later' },
      [],
    );
    await settle();
    harness.releaseRun();
    await run;
    await settle();

    refusal.reject(new Error('refused'));
    expect(await throwingRejectionOf(sent)).toThrow('refused');
    await settle();

    expect(deliveryStatus(harness.conversation(), 'refused later')).toBe('failed');
    expect(harness.turns).toHaveLength(1);
  });
});

describe('resending and receipts', () => {
  test('a follow-up failed by a stop and retried during a new run is judged by the new run', async () => {
    const harness = createHarness();
    const firstRun = harness.startRun();
    await settle();
    await harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'again' },
      [],
    );
    await harness.controller.adapter.stopGenerating?.('anything');
    await firstRun;
    await settle();
    expect(deliveryStatus(harness.conversation(), 'again')).toBe('failed');

    const secondRun = harness.controller.adapter.sendMessage({ role: 'user', content: 'next' }, []);
    await settle();
    const failedId = harness.rowNamed('again')!.id;
    await harness.controller.adapter.retryMessage?.(failedId);
    await settle();

    // The stop that ended the first run must not fail the new attempt.
    expect(deliveryStatus(harness.conversation(), 'again')).toBeUndefined();
    harness.releaseRun();
    await secondRun;
  });

  test('a promoted receipt marks the follow-up delivered even when its run sends no history', async () => {
    const failure = deferred();
    const harness = createHarness({
      sendRunInput: async () => ({ state: 'promoted' }),
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
    await harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'replayed' },
      [],
    );
    failure.reject(new Error('transport failed'));
    expect(await throwingRejectionOf(run)).toThrow('transport failed');
    for (let index = 0; index < 5; index += 1) await settle();

    // Already committed by the host: it is not sent again as a new turn.
    expect(harness.turns).toHaveLength(1);
  });
});

describe('a follow-up whose row a snapshot replaced', () => {
  test('is reported instead of being resent as an empty turn', async () => {
    const acknowledgement = deferred();
    const harness = createHarness({
      sendRunInput: async () => {
        await acknowledgement.promise;
      },
    });
    const run = harness.startRun();
    await settle();
    const sent = harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'replaced' },
      [],
    );
    await settle();
    harness.releaseRun();
    await run;
    await settle();

    // An authoritative snapshot for the same conversation arrives without the row.
    harness.setConversation(createConversationHistory({ id: harness.conversation().id }));
    acknowledgement.resolve();
    await sent;
    for (let index = 0; index < 5; index += 1) await settle();

    expect(harness.turns).toHaveLength(1);
    expect(harness.errors.map((error) => String(error))).toEqual([
      'Error: This follow-up was not resent: its message is no longer in the conversation',
    ]);
  });
});

describe('browser-owned runs', () => {
  test('do not offer follow-ups, and a second turn during the run is refused as before', async () => {
    const gate = deferred();
    let conversation = createConversationHistory({ id: 'browser-owned' });
    const controller = createChatSessionController({
      executionOwner: 'browser',
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () =>
        (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: 'text', text: 'working' };
          await gate.promise;
        })(),
      sendRunInput: async () => undefined,
    });

    const run = controller.adapter.sendMessage({ role: 'user', content: 'start' }, []);
    await settle();

    expect(controller.adapter.sendRunInput).toBeUndefined();
    expect(controller.adapter.ordersRunInput).toBeUndefined();
    expect(
      await throwingRejectionOf(
        controller.adapter.sendMessage({ role: 'user', content: 'second' }, []),
      ),
    ).toThrow('Chat session is already running');
    gate.resolve();
    await run;
  });
});

describe('the end-of-run merge across consecutive runs', () => {
  test("a later run's full terminal history leaves an earlier run's follow-ups in place", async () => {
    const firstGate = deferred();
    const harness = createHarness({
      turns: [
        (request) =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'one', wireVersion: 1, sequence: 0 };
            await firstGate.promise;
            const followUpId = Object.values(harness.conversation().messages).find(
              (message) => message.content === 'early follow-up',
            )!.id;
            yield completed(
              terminalOf(request, [
                { id: request.conversation.ids[0]!, role: 'user', content: 'start' },
                { id: 'a1', role: 'assistant', content: 'first answer' },
                { id: followUpId, role: 'user', content: 'early follow-up' },
                { id: 'a2', role: 'assistant', content: 'second answer' },
              ]),
              1,
            );
          })(),
        (request) =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'two', wireVersion: 1, sequence: 0 };
            // The second run answers with its whole history, earlier rows included.
            const rows = request.conversation.ids
              .map((id) => request.conversation.messages[id]!)
              .filter((message) => message.role !== 'assistant' || message.content !== '')
              .map((message) => ({
                id: message.id,
                role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
                content: typeof message.content === 'string' ? message.content : '',
              }));
            yield completed(
              terminalOf(request, [
                ...rows,
                { id: 'a3', role: 'assistant', content: 'third answer' },
              ]),
              1,
            );
          })(),
      ],
    });
    const run = harness.startRun();
    await settle();
    await harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'early follow-up' },
      [],
    );
    firstGate.resolve();
    await run;
    await settle();
    const before = harness.rows().map((row) => row.content);

    await harness.controller.adapter.sendMessage({ role: 'user', content: 'next question' }, []);

    const after = harness.rows().map((row) => row.content);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toContain('early follow-up');
    expect(after.filter((content) => content === 'early follow-up')).toHaveLength(1);
    expect(after.at(-1)).toBe('third answer');
  });

  test('mergeRunHistory relocates only follow-ups added after the run started', () => {
    let next = 0;
    const environment = { randomId: () => `row-${(next += 1)}` };
    let current = createConversationHistory({ id: 'merge' });
    current = appendMessages(current, { role: 'user', content: 'start' }, environment);
    current = appendMessages(
      current,
      { role: 'user', content: 'earlier follow-up', metadata: { _followUp: true } },
      environment,
    );
    const runStartIds = new Set(current.ids);
    current = appendMessages(
      current,
      { role: 'user', content: 'new follow-up', metadata: { _followUp: true } },
      environment,
    );
    // The terminal names everything, with the new follow-up first.
    const terminal = terminalOf({ conversation: current } as Parameters<TurnScript>[0], [
      { id: 'row-1', role: 'user', content: 'start' },
      { id: 'row-3', role: 'user', content: 'new follow-up' },
      { id: 'row-2', role: 'user', content: 'earlier follow-up' },
    ]);

    const merged = mergeRunHistory(current, terminal, new Set(['row-1']), runStartIds);

    expect(merged.ids).toContain('row-2');
    expect(merged.ids.indexOf('row-2')).toBe(1);
    expect(merged.ids).toContain('row-3');
  });
});
