import { throwingRejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import {
  appendMessages,
  countQueuedFollowUps,
  createConversationHistory,
} from '../components/chat/builders.ts';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import {
  createHarness,
  deferred,
  deliveryStatus,
  settle,
  type TurnScript,
} from './session-controller-run-input-test-support.ts';
import type { ChatSessionRunInputRetraction } from './session-controller-support.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

/**
 * B06 (row 18k): a host that holds a follow-up until its run takes it, and can take it back until
 * then, passes `retractRunInput`. The row stays queued until the run reaches it, Remove takes it
 * back, and a follow-up the run already took becomes a normal message.
 */

const FOLLOW_UP = 'Then look up order 4476.';

type RetractCall = { conversationId: string; messageId: string };

function holdingHarness(
  options: {
    retract?: (call: RetractCall) => Promise<ChatSessionRunInputRetraction>;
    acknowledgement?: Promise<void>;
    turns?: Array<TurnScript | undefined>;
  } = {},
) {
  const retractions: RetractCall[] = [];
  const harness = createHarness({
    sendRunInput: async () => {
      await options.acknowledgement;
    },
    retractRunInput: async (conversationId, { messageId }) => {
      const call = { conversationId, messageId };
      retractions.push(call);
      return (await options.retract?.(call)) ?? 'retracted';
    },
    ...(options.turns === undefined ? {} : { turns: options.turns }),
  });
  return {
    harness,
    retractions,
    /** Starts the run and sends one follow-up while it works. */
    async sendFollowUp() {
      const run = harness.startRun();
      await settle();
      const sent = harness.controller.adapter.sendRunInput!(
        'run-input',
        { role: 'user', content: FOLLOW_UP },
        [],
      );
      await settle();
      return { run, sent, id: harness.rowNamed(FOLLOW_UP)!.id };
    },
  };
}

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

describe('a follow-up the host holds until the run takes it', () => {
  test('stays queued after the host accepts it, until the host says the run took it', async () => {
    const { harness, sendFollowUp } = holdingHarness();
    const { run, sent, id } = await sendFollowUp();
    await sent;

    expect(deliveryStatus(harness.conversation(), FOLLOW_UP)).toBe('sending');

    harness.controller.markFollowUpsDelivered([id]);

    expect(deliveryStatus(harness.conversation(), FOLLOW_UP)).toBeUndefined();
    expect(await throwingRejectionOf(harness.controller.adapter.removeRunInput!(id))).toThrow(
      'This follow-up was already sent',
    );
    harness.releaseRun();
    await run;
  });

  test('a report that lands before the acknowledgement makes it a sent message once accepted', async () => {
    const acknowledgement = deferred();
    const { harness, sendFollowUp } = holdingHarness({ acknowledgement: acknowledgement.promise });
    const { run, sent, id } = await sendFollowUp();

    harness.controller.markFollowUpsDelivered([id]);
    expect(deliveryStatus(harness.conversation(), FOLLOW_UP)).toBe('sending');
    acknowledgement.resolve();
    await sent;

    expect(deliveryStatus(harness.conversation(), FOLLOW_UP)).toBeUndefined();
    harness.releaseRun();
    await run;
  });

  test('without retractRunInput the adapter offers no Remove, and acceptance shows it sent', async () => {
    const harness = createHarness();
    const run = harness.startRun();
    await settle();
    await harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: FOLLOW_UP },
      [],
    );

    expect(harness.controller.adapter.removeRunInput).toBeUndefined();
    expect(deliveryStatus(harness.conversation(), FOLLOW_UP)).toBeUndefined();
    harness.releaseRun();
    await run;
  });
});

describe('removing a queued follow-up', () => {
  test('retracts it through the host under its row id, takes its row out, and never sends it', async () => {
    const { harness, retractions, sendFollowUp } = holdingHarness();
    const { run, sent, id } = await sendFollowUp();
    await sent;

    await harness.controller.adapter.removeRunInput!(id);
    harness.releaseRun();
    await run;
    await settle();

    expect(retractions).toEqual([{ conversationId: 'run-input', messageId: id }]);
    expect(harness.rowNamed(FOLLOW_UP)).toBeUndefined();
    // The run ended without it, and it is not sent as a turn of its own.
    expect(harness.turns).toHaveLength(1);
  });

  test('a follow-up the run already took stays, as a sent message', async () => {
    const { harness, sendFollowUp } = holdingHarness({ retract: async () => 'delivered' });
    const { run, sent, id } = await sendFollowUp();
    await sent;

    await harness.controller.adapter.removeRunInput!(id);

    expect(harness.rowNamed(FOLLOW_UP)?.id).toBe(id);
    expect(deliveryStatus(harness.conversation(), FOLLOW_UP)).toBeUndefined();
    harness.releaseRun();
    await run;
    await settle();
    expect(harness.turns).toHaveLength(1);
  });

  test('waits for an acknowledgement in flight, then retracts what the host accepted', async () => {
    const acknowledgement = deferred();
    const { harness, retractions, sendFollowUp } = holdingHarness({
      acknowledgement: acknowledgement.promise,
    });
    const { run, sent, id } = await sendFollowUp();

    const removal = harness.controller.adapter.removeRunInput!(id);
    await settle();
    expect(retractions).toEqual([]);
    acknowledgement.resolve();
    await sent;
    await removal;

    expect(retractions).toEqual([{ conversationId: 'run-input', messageId: id }]);
    expect(harness.rowNamed(FOLLOW_UP)).toBeUndefined();
    harness.releaseRun();
    await run;
  });

  test('a second Remove while the first settles asks the host once', async () => {
    const answer = deferred<ChatSessionRunInputRetraction>();
    const { harness, retractions, sendFollowUp } = holdingHarness({
      retract: () => answer.promise,
    });
    const { run, sent, id } = await sendFollowUp();
    await sent;

    const first = harness.controller.adapter.removeRunInput!(id);
    const second = harness.controller.adapter.removeRunInput!(id);
    await settle();
    answer.resolve('retracted');
    await Promise.all([first, second]);

    expect(retractions).toHaveLength(1);
    harness.releaseRun();
    await run;
  });

  test('a retraction that fails leaves the row queued and rejects', async () => {
    const { harness, sendFollowUp } = holdingHarness({
      retract: async () => {
        throw new Error('Interborough can’t be reached');
      },
    });
    const { run, sent, id } = await sendFollowUp();
    await sent;

    expect(await throwingRejectionOf(harness.controller.adapter.removeRunInput!(id))).toThrow(
      'Interborough can’t be reached',
    );
    expect(deliveryStatus(harness.conversation(), FOLLOW_UP)).toBe('sending');
    harness.releaseRun();
    await run;
  });

  test('a follow-up removed while its run ends without it is not sent as a turn of its own', async () => {
    const gate = deferred();
    const answer = deferred<ChatSessionRunInputRetraction>();
    const { harness, retractions, sendFollowUp } = holdingHarness({
      retract: () => answer.promise,
      turns: [
        (request) =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'working', wireVersion: 1, sequence: 0 };
            await gate.promise;
            yield {
              type: 'run.completed',
              conversation: terminalOf(request, [
                { id: request.conversation.ids[0]!, role: 'user', content: 'start' },
                { id: 'server-reply', role: 'assistant', content: 'done' },
              ]),
              content: '',
              usage: { prompt: 0, completion: 0, total: 0 },
              finishReason: 'stop',
              wireVersion: 1,
              sequence: 1,
            };
          })(),
      ],
    });
    const { run, sent, id } = await sendFollowUp();
    await sent;

    const removal = harness.controller.adapter.removeRunInput!(id);
    await settle();
    // The run ends without the follow-up while the host is still answering the removal.
    gate.resolve();
    await run;
    await settle();
    expect(harness.turns).toHaveLength(1);
    answer.resolve('retracted');
    await removal;
    await settle();

    expect(retractions).toEqual([{ conversationId: 'run-input', messageId: id }]);
    expect(harness.rowNamed(FOLLOW_UP)).toBeUndefined();
    expect(harness.turns).toHaveLength(1);
  });

  test('a follow-up whose removal failed after its run ended without it is still sent as a turn', async () => {
    const gate = deferred();
    const answer = deferred<ChatSessionRunInputRetraction>();
    const { harness, sendFollowUp } = holdingHarness({
      retract: () => answer.promise,
      turns: [
        (request) =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'working', wireVersion: 1, sequence: 0 };
            await gate.promise;
            yield {
              type: 'run.completed',
              conversation: terminalOf(request, [
                { id: request.conversation.ids[0]!, role: 'user', content: 'start' },
                { id: 'server-reply', role: 'assistant', content: 'done' },
              ]),
              content: '',
              usage: { prompt: 0, completion: 0, total: 0 },
              finishReason: 'stop',
              wireVersion: 1,
              sequence: 1,
            };
          })(),
      ],
    });
    const { run, sent, id } = await sendFollowUp();
    await sent;

    const removal = harness.controller.adapter.removeRunInput!(id);
    await settle();
    gate.resolve();
    await run;
    await settle();
    answer.reject(new Error('Interborough can’t be reached'));
    expect(await throwingRejectionOf(removal)).toThrow('Interborough can’t be reached');
    await settle();

    expect(harness.rowNamed(FOLLOW_UP)?.id).toBe(id);
    expect(harness.turns).toHaveLength(2);
  });
});

describe('countQueuedFollowUps', () => {
  test('counts the follow-ups that still read as queued, and none once the run took them', async () => {
    const { harness, sendFollowUp } = holdingHarness();
    const { run, sent, id } = await sendFollowUp();
    await sent;

    expect(countQueuedFollowUps(harness.conversation())).toBe(1);
    harness.controller.markFollowUpsDelivered([id]);
    expect(countQueuedFollowUps(harness.conversation())).toBe(0);
    harness.releaseRun();
    await run;
  });
});
