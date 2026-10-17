import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { appendMessages, createConversationHistory } from '../components/chat/builders.ts';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import {
  findOwningUser,
  latestResolvedApprovalOwner,
} from './session-controller-approval-state.ts';
import { mergeRunHistory } from './session-controller-rows.ts';
import {
  approvalFrames,
  attachment,
  createHarness,
  deferred,
  isFollowUp,
  settle,
} from './session-controller-run-input-test-support.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

const followUpMetadata = { _followUp: true, _deliveryStatus: 'sending' };

function history(): ConversationHistory {
  let next = 0;
  const environment = { randomId: () => `row-${(next += 1)}` };
  let conversation = createConversationHistory({ id: 'ownership' });
  conversation = appendMessages(conversation, { role: 'user', content: 'opener' }, environment);
  conversation = appendMessages(
    conversation,
    { role: 'assistant', content: 'step one' },
    environment,
  );
  conversation = appendMessages(
    conversation,
    { role: 'user', content: 'follow-up', metadata: { ...followUpMetadata } },
    environment,
  );
  return conversation;
}

describe('follow-up rows never own a run', () => {
  test('findOwningUser skips a row marked as a follow-up', () => {
    let conversation = history();
    conversation = appendMessages(
      conversation,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'late', name: 'write', arguments: {} },
      },
      { randomId: () => 'late-call-row' },
    );

    expect(findOwningUser(conversation, 'late-call-row', undefined)).toBe('row-1');
  });

  test('findOwningUser still stops at an unmarked user row', () => {
    let conversation = history();
    conversation = appendMessages(
      conversation,
      { role: 'user', content: 'a real second turn' },
      { randomId: () => 'second-turn' },
    );
    conversation = appendMessages(
      conversation,
      { role: 'tool-call', content: '', toolCall: { id: 'late', name: 'write', arguments: {} } },
      { randomId: () => 'late-call-row' },
    );

    expect(findOwningUser(conversation, 'late-call-row', undefined)).toBe('second-turn');
  });

  test('latestResolvedApprovalOwner ignores owners marked as follow-ups', () => {
    const conversation = history();
    const followUpId = conversation.ids.at(-1)!;

    expect(latestResolvedApprovalOwner(conversation, new Set(['row-1', followUpId]))).toBe('row-1');
  });

  test('retrying the opener after a failed run is allowed even though a follow-up came later', async () => {
    const failure = deferred();
    const harness = createHarness({
      // The hook refuses, so the follow-up stays a failed row after the opener.
      sendRunInput: async () => {
        throw new Error('refused');
      },
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
    await rejectionOf(
      harness.controller.adapter.sendRunInput?.(
        'run-input',
        { role: 'user', content: 'late word' },
        [],
      ),
    );
    failure.reject(new Error('transport failed'));
    expect(await throwingRejectionOf(run)).toThrow('transport failed');

    const openerId = harness.conversation().ids[0]!;
    await harness.controller.adapter.retryMessage?.(openerId);

    expect(harness.turns).toHaveLength(2);
    expect(harness.rowNamed('start')?.metadata['_deliveryStatus']).toBeUndefined();
    expect(isFollowUp(harness.conversation(), 'late word')).toBe(true);
  });

  test('a follow-up accepted before the run fails is sent as an ordinary turn afterwards', async () => {
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
    const accepted = harness.controller.adapter.sendRunInput?.(
      'run-input',
      { role: 'user', content: 'late word' },
      [],
    );
    await settle();
    failure.reject(new Error('transport failed'));
    expect(await throwingRejectionOf(run)).toThrow('transport failed');
    await accepted;
    for (let index = 0; index < 5; index += 1) await settle();

    // The failed run never delivered it, so it becomes the next run's opener.
    expect(harness.turns).toHaveLength(2);
    expect(isFollowUp(harness.conversation(), 'late word')).toBe(false);
  });

  test('an approval continuation sends the opener and its attachments, not the follow-up', async () => {
    const gate = deferred();
    const opener = [attachment('opener-file')];
    const harness = createHarness({
      turns: [
        () =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'working' };
            await gate.promise;
            yield* approvalFrames;
          })(),
      ],
      hooks: {
        resolveToolApproval: async (callId) => ({
          callId,
          outcome: 'success',
          content: 'allowed',
        }),
      },
    });

    const run = harness.startRun(opener);
    await settle();
    await harness.controller.adapter.sendRunInput?.(
      'run-input',
      { role: 'user', content: 'also this' },
      [attachment('follow-up-file')],
    );
    gate.resolve();
    await run;
    await harness.controller.adapter.resolveToolApproval?.('call', {
      decision: 'approve',
      remember: false,
    });

    // The continuation is the second turn. It sends the opener's attachments. The
    // accepted follow-up, absent from every history, is promoted after it.
    expect(harness.turns).toHaveLength(3);
    expect(harness.turns[1]!.attachments).toEqual(opener);
  });

  test('the controller stamps _followUp on follow-up rows only', async () => {
    const harness = createHarness();

    const run = harness.startRun();
    await settle();
    await harness.controller.adapter.sendRunInput?.(
      'run-input',
      { role: 'user', content: 'marked' },
      [],
    );

    expect(isFollowUp(harness.conversation(), 'marked')).toBe(true);
    expect(isFollowUp(harness.conversation(), 'start')).toBe(false);
    harness.releaseRun();
    await run;
  });
});

describe('end-of-run merge of follow-ups', () => {
  /** A terminal that names the follow-up's row between two assistant steps. */
  function runToTerminal(options: { acknowledged: boolean }) {
    const gate = deferred();
    const ack = deferred();
    let openerId = '';
    let followUpId = '';
    const harness = createHarness({
      executionOwner: 'server',
      sendRunInput: () => (options.acknowledged ? Promise.resolve() : ack.promise),
      turns: [
        () =>
          (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'text', text: 'step one', wireVersion: 1, sequence: 0 };
            await gate.promise;
            const ids = [openerId, 'server-a1', followUpId, 'server-a2'];
            let next = 0;
            const environment = { randomId: () => ids[next++]! };
            let terminal = createConversationHistory({ id: 'run-input' });
            terminal = appendMessages(terminal, { role: 'user', content: 'start' }, environment);
            terminal = appendMessages(
              terminal,
              { role: 'assistant', content: 'step one' },
              environment,
            );
            terminal = appendMessages(
              terminal,
              { role: 'user', content: 'the server copy of the follow-up' },
              environment,
            );
            terminal = appendMessages(
              terminal,
              { role: 'assistant', content: 'step two' },
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
    let sent: Promise<void> | undefined;
    return {
      harness,
      /** Lets a follow-up the hook is still holding finish. */
      async finish(): Promise<void> {
        ack.resolve();
        await sent;
      },
      async start(): Promise<void> {
        const run = harness.startRun();
        await settle();
        openerId = harness.conversation().ids[0]!;
        sent = harness.controller.adapter.sendRunInput?.(
          'run-input',
          { role: 'user', content: 'the client follow-up' },
          [],
        );
        await settle();
        followUpId = harness.conversation().ids.at(-1)!;
        gate.resolve();
        await run;
      },
    };
  }

  test('keeps one row at the position the terminal gives, and the client object wins', async () => {
    const { harness, start, finish } = runToTerminal({ acknowledged: true });
    await start();
    await finish();

    const rows = harness.rows();
    expect(rows.map((row) => row.content)).toEqual([
      'start',
      'step one',
      'the client follow-up',
      'step two',
    ]);
    const followUp = rows.find((row) => row.content === 'the client follow-up')!;
    expect(followUp.metadata['_followUp']).toBe(true);
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(2);
  });

  test('a follow-up still sending when the terminal arrives keeps its status', async () => {
    const { harness, start, finish } = runToTerminal({ acknowledged: false });
    await start();

    const followUp = harness.rowNamed('the client follow-up')!;
    expect(followUp.metadata['_deliveryStatus']).toBe('sending');
    expect(followUp.metadata['_followUp']).toBe(true);
    expect(harness.rows().map((row) => row.content)).toEqual([
      'start',
      'step one',
      'the client follow-up',
      'step two',
    ]);
    await finish();
  });

  test('mergeRunHistory leaves a follow-up the terminal does not name where it is', () => {
    const current = history();
    const followUpId = current.ids.at(-1)!;
    const terminal = appendMessages(
      createConversationHistory({ id: 'ownership' }),
      { role: 'assistant', content: 'server step' },
      { randomId: () => 'server-step' },
    );

    const merged = mergeRunHistory(current, terminal, new Set(['row-2']), new Set(['row-1']));

    expect(merged.ids.at(-1)).toBe(followUpId);
    expect(merged.messages[followUpId]).toBe(current.messages[followUpId]);
  });
});
