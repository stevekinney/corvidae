/**
 * COR-2725: a turn the agent only called tools in has no assistant message to carry its outcome, so
 * Chat draws it on an anchor after the turn's steps (R3 to R6). One outcome per cell, its commands
 * run once however often they are pressed, and the turn has no footnote or orphan time of its own.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import {
  appendAssistantMessage,
  appendMessages,
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
  FOLLOW_UP_METADATA_KEY,
} from './builders.ts';
import type { ConversationHistory } from './conversation-model.ts';
import {
  resolveTurnOutcome,
  turnStateOf,
  type TurnOutcome,
  type TurnOutcomeFacts,
} from './message/turn-outcome.ts';
import { CINDER_NOTES_METADATA_KEY } from './utilities/index.ts';

setupHappyDom();

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const originalResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = TestResizeObserver;

class TestIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const originalIntersectionObserver = globalThis.IntersectionObserver;
globalThis.IntersectionObserver =
  TestIntersectionObserver as unknown as typeof IntersectionObserver;
afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

const { render, fireEvent, cleanup, getByRole } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const IDLE: TurnOutcomeFacts = { running: false, now: 1_000 };

function turnOf(lastCall: 'finished' | 'errored' | 'refused'): ConversationHistory {
  const asked = appendUserMessage(createConversationHistory({ id: 'only-tools' }), 'Look up 4398');
  const called = appendToolCall(asked, {
    id: 'call-1',
    name: 'lookup-order',
    arguments: { orderId: '4398' },
  });
  if (lastCall === 'finished')
    return appendToolResult(called, { callId: 'call-1', outcome: 'success', content: 'Shipped' });
  if (lastCall === 'errored')
    return appendToolResult(called, {
      callId: 'call-1',
      outcome: 'error',
      content: null,
      error: { code: 'timeout', category: 'timeout', retryable: true, message: 'Timed out.' },
    });
  return appendToolResult(called, {
    callId: 'call-1',
    outcome: 'error',
    content: 'Tool call denied: not now',
  });
}

function noted(conversation: ConversationHistory, entry: Record<string, string | boolean>) {
  const rowId = conversation.ids.at(-1)!;
  const row = conversation.messages[rowId]!;
  return {
    ...conversation,
    messages: {
      ...conversation.messages,
      [rowId]: { ...row, metadata: { ...row.metadata, [CINDER_NOTES_METADATA_KEY]: [entry] } },
    },
  };
}

const CELLS = [
  {
    kind: 'stopped',
    stop: { kind: 'stopped', id: 'stopped:run-1', reason: 'Stopped.' },
    words: 'Stopped before an answer.',
    buttons: ['Continue', 'Discard'],
  },
  {
    kind: 'failed',
    stop: { kind: 'stopped', id: 'stopped:run-1', reason: 'The provider dropped.', failed: true },
    words: 'Failed before an answer.',
    buttons: ['Retry'],
  },
  {
    kind: 'empty',
    stop: undefined,
    words: 'The agent finished without writing an answer.',
    buttons: ['Try again'],
  },
] as const;

const LAST_CALLS = ['finished', 'errored', 'refused'] as const;

const follows = (earlier: Node, later: Node) =>
  Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('Chat — the outcome of a turn with no assistant message', () => {
  for (const lastCall of LAST_CALLS) {
    for (const cell of CELLS) {
      test(`${lastCall} last call, ${cell.kind}: one outcome after the steps, commands once, no footnote`, async () => {
        const base = turnOf(lastCall);
        const conversation = cell.stop === undefined ? base : noted(base, cell.stop);
        const outcome: TurnOutcome = resolveTurnOutcome(conversation, IDLE);
        // A command the host has not answered yet.
        const calls: Record<string, ReturnType<typeof mock>> = {
          continue: mock((_id: string) => new Promise<void>(() => undefined)),
          discard: mock((_id: string) => new Promise<void>(() => undefined)),
          retry: mock((_id: string) => new Promise<void>(() => undefined)),
        };
        const { container } = render(Chat, {
          id: 'only-tools',
          conversation: outcome.conversation,
          variant: 'transcript',
          messageTurnState: (message: Parameters<typeof turnStateOf>[1]) =>
            turnStateOf(outcome, message),
          onContinueTurn: calls['continue']!,
          onDiscardTurn: calls['discard']!,
          onRetryTurn: calls['retry']!,
        });
        await tick();

        const outcomes = container.querySelectorAll<HTMLElement>('.chat-turn-outcome');
        expect(outcomes).toHaveLength(1);
        const drawn = outcomes[0]!;
        expect(drawn.getAttribute('data-kind')).toBe(cell.kind);
        expect(drawn.textContent).toContain(cell.words);
        const timeline = container.querySelector('.chat-tool-call-timeline')!;
        expect(follows(timeline, drawn)).toBe(true);
        // The anchor is no message: it has no row of its own, line, or footnote.
        expect(container.querySelectorAll('article[data-message-id$=":outcome"]')).toHaveLength(0);
        expect(drawn.closest('.chat-message-wrapper')?.querySelector('.chat-message-line')).toBe(
          null,
        );
        expect(container.textContent).not.toContain('Run finished, no reply');
        if (cell.kind === 'empty') expect(drawn.querySelector('time')).not.toBeNull();

        for (const name of cell.buttons) {
          const button = getByRole(drawn, 'button', { name });
          await fireEvent.click(button);
          await fireEvent.click(button);
        }
        await tick();
        const anchorId = `${conversation.ids.at(-1)!}:outcome`;
        // The first press of a stopped turn holds the other control: only it reaches the host.
        const reached = { stopped: 'continue', failed: 'retry', empty: 'retry' }[cell.kind];
        expect(calls[reached]).toHaveBeenCalledTimes(1);
        expect(calls[reached]).toHaveBeenCalledWith(anchorId);
        const held = { stopped: ['discard'], failed: [], empty: [] }[cell.kind];
        for (const name of held) expect(calls[name]).toHaveBeenCalledTimes(0);
      });
    }
  }

  const refusals: [string, () => boolean | Promise<boolean>][] = [
    ['returns false', () => false],
    ['throws', () => Promise.reject(new Error('offline'))],
  ];
  test.each(refusals)(
    'Retry now on a dropped stream of a tool-only turn says once under the turn that it did not go through when the host %s',
    async (_name, answer) => {
      const outcome = resolveTurnOutcome(turnOf('finished'), {
        ...IDLE,
        running: true,
        reconnect: { attempt: 1, attempts: 7, wait: 5_000, nextTryAt: 4_000, runDropped: true },
      });
      const { container } = render(Chat, {
        id: 'only-tools',
        conversation: outcome.conversation,
        variant: 'transcript',
        messageTurnState: (message: Parameters<typeof turnStateOf>[1]) =>
          turnStateOf(outcome, message),
        onRetryConnection: answer,
      });
      await tick();

      await fireEvent.click(getByRole(container, 'button', { name: 'Retry now' }));
      await tick();
      await tick();

      const lines = [...container.querySelectorAll('.chat-turn-command-failure')];
      expect(lines.map((line) => line.textContent?.trim())).toEqual([
        'That did not go through. Try again.',
      ]);
      expect(container.querySelector('.chat-turn-outcome')).toBeNull();
    },
  );

  test('a dropped stream is the connection notice by the composer, once, and no outcome row', async () => {
    const outcome = resolveTurnOutcome(turnOf('finished'), {
      ...IDLE,
      running: true,
      reconnect: { attempt: 1, attempts: 7, wait: 5_000, nextTryAt: 4_000, runDropped: true },
    });
    const { container } = render(Chat, {
      id: 'only-tools',
      conversation: outcome.conversation,
      variant: 'transcript',
      messageTurnState: (message: Parameters<typeof turnStateOf>[1]) =>
        turnStateOf(outcome, message),
      onRetryConnection: () => undefined,
    });
    await tick();
    expect(container.querySelectorAll('.chat-connection-notice')).toHaveLength(1);
    expect(container.textContent).toContain('Reconnecting, attempt 1 of 7');
    expect(container.querySelector('.chat-turn-outcome')).toBeNull();
  });
});

const DROP = { attempt: 1, attempts: 7, wait: 5_000, nextTryAt: 4_000, runDropped: true };

function statesOf(conversation: ConversationHistory, facts: TurnOutcomeFacts) {
  const outcome = resolveTurnOutcome(conversation, facts);
  return {
    conversation: outcome.conversation,
    messageTurnState: (message: Parameters<typeof turnStateOf>[1]) => turnStateOf(outcome, message),
  };
}

function withStopNote(conversation: ConversationHistory, failed: boolean): ConversationHistory {
  return noted(conversation, {
    kind: 'stopped',
    id: 'stopped:run-1',
    reason: 'The provider dropped.',
    ...(failed ? { failed: true } : {}),
  });
}

describe('Chat — a refused Retry now is said only while the drop it was pressed on lasts', () => {
  const refuse = () => false;
  const shapes: [string, () => ConversationHistory][] = [
    ['tool-only turn', () => turnOf('finished')],
    [
      'turn with its own reply',
      () =>
        appendAssistantMessage(
          appendUserMessage(createConversationHistory({ id: 'only-tools' }), 'Hi'),
          'Partial',
        ),
    ],
  ];

  for (const [name, make] of shapes) {
    test(`${name}: the stream comes back, then drops again with nothing pressed`, async () => {
      const conversation = make();
      const { container, rerender } = render(Chat, {
        id: 'only-tools',
        variant: 'transcript',
        onRetryConnection: refuse,
        ...statesOf(conversation, { ...IDLE, running: true, reconnect: DROP }),
      });
      await tick();
      await fireEvent.click(getByRole(container, 'button', { name: 'Retry now' }));
      await tick();
      await tick();
      const lines = () => container.querySelectorAll('.chat-turn-command-failure').length;
      expect(lines()).toBe(1);

      await rerender(statesOf(conversation, { ...IDLE, running: true }));
      await tick();
      await tick();
      await rerender(statesOf(conversation, { ...IDLE, running: true, reconnect: DROP }));
      await tick();
      await tick();
      expect(lines()).toBe(0);
    });
  }

  for (const [outcome, failed] of [
    ['stopped', false],
    ['failed', true],
    ['empty', undefined],
  ] as const) {
    test(`the drop ends as ${outcome} on the same anchor: the line never renders again, not even for a frame`, async () => {
      const dropped = turnOf('finished');
      const { container, rerender } = render(Chat, {
        id: 'only-tools',
        variant: 'transcript',
        onRetryConnection: refuse,
        onRetryTurn: () => undefined,
        onContinueTurn: () => undefined,
        onDiscardTurn: () => undefined,
        ...statesOf(dropped, { ...IDLE, running: true, reconnect: DROP }),
      });
      await tick();
      await fireEvent.click(getByRole(container, 'button', { name: 'Retry now' }));
      await tick();
      await tick();
      expect(container.querySelectorAll('.chat-turn-command-failure')).toHaveLength(1);

      let drawn = false;
      const watcher = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (
              node instanceof Element &&
              (node.matches('.chat-turn-command-failure') ||
                node.querySelector('.chat-turn-command-failure') !== null)
            )
              drawn = true;
      });
      watcher.observe(container, { childList: true, subtree: true });
      const ended =
        failed === undefined ? turnOf('finished') : withStopNote(turnOf('finished'), failed);
      await rerender(statesOf(ended, IDLE));
      expect(container.querySelector('.chat-turn-command-failure')).toBeNull();
      await tick();
      await tick();
      watcher.disconnect();
      expect(container.querySelector('.chat-turn-outcome')?.getAttribute('data-kind')).toBe(
        outcome,
      );
      expect(container.querySelector('.chat-turn-command-failure')).toBeNull();
      expect(drawn).toBe(false);
    });
  }
});

describe('Chat — the outcome of a turn that ends on its steps stands before what the person typed after them', () => {
  const followUp = {
    id: 'u3',
    role: 'user' as const,
    content: 'And this too',
    metadata: { [FOLLOW_UP_METADATA_KEY]: true },
  };
  const shapes: [string, () => ConversationHistory][] = [
    ['tool calls only', () => turnOf('finished')],
    [
      'narrated then tool calls',
      () => {
        const asked = appendUserMessage(createConversationHistory({ id: 'only-tools' }), 'Look up');
        const narrated = appendAssistantMessage(asked, 'Checking.');
        const called = appendToolCall(narrated, { id: 'c1', name: 'lookup-order', arguments: {} });
        return appendToolResult(called, { callId: 'c1', outcome: 'success', content: 'ok' });
      },
    ],
  ];
  for (const [name, make] of shapes) {
    test(`${name}: the stopped row follows the steps and comes before the follow-up`, async () => {
      const base = appendMessages(make(), followUp);
      const stopRowId = base.ids.at(-2)!;
      const row = base.messages[stopRowId]!;
      const conversation = {
        ...base,
        messages: {
          ...base.messages,
          [stopRowId]: {
            ...row,
            metadata: {
              ...row.metadata,
              [CINDER_NOTES_METADATA_KEY]: [
                { kind: 'stopped', id: 'stopped:run-1', reason: 'Stopped.' },
              ],
            },
          },
        },
      };
      const outcome = resolveTurnOutcome(conversation, IDLE);
      const { container } = render(Chat, {
        id: 'order',
        variant: 'transcript',
        conversation: outcome.conversation,
        messageTurnState: (message: Parameters<typeof turnStateOf>[1]) =>
          turnStateOf(outcome, message),
        onContinueTurn: () => undefined,
        onDiscardTurn: () => undefined,
      });
      await tick();
      const drawn = container.querySelector('.chat-turn-outcome')!;
      const steps = container.querySelector('.chat-tool-call-timeline')!;
      const typed = container.querySelector('[data-message-id="u3"]')!;
      expect(follows(steps, drawn)).toBe(true);
      expect(follows(drawn, typed)).toBe(true);
    });
  }
});

describe('Chat — a turn that wrote no answer never names a reply', () => {
  const failedReply = () =>
    withStopNote(
      appendAssistantMessage(
        appendUserMessage(createConversationHistory({ id: 'only-tools' }), 'Hi'),
        'Order 4471 is $42.00, delivered',
      ),
      true,
    );

  test('Retry keeps the steps on an anchored failure, and the written text on a reply-carried one', async () => {
    const steps = resolveTurnOutcome(withStopNote(turnOf('finished'), true), IDLE);
    const anchored = render(Chat, {
      id: 'only-tools',
      variant: 'transcript',
      conversation: steps.conversation,
      messageTurnState: (message: Parameters<typeof turnStateOf>[1]) => turnStateOf(steps, message),
      onRetryTurn: () => undefined,
    });
    await tick();
    expect(anchored.container.querySelector('.chat-turn-outcome')?.textContent).toContain(
      'Retry keeps the steps that finished.',
    );
    expect(anchored.container.textContent).not.toContain('what was written so far');
    cleanup();
    const reply = resolveTurnOutcome(failedReply(), IDLE);
    const carried = render(Chat, {
      id: 'reply',
      variant: 'transcript',
      conversation: reply.conversation,
      messageTurnState: (message: Parameters<typeof turnStateOf>[1]) => turnStateOf(reply, message),
      onRetryTurn: () => undefined,
    });
    await tick();
    expect(carried.container.querySelector('.chat-turn-outcome')?.textContent).toContain(
      'Retry keeps what was written so far.',
    );
  });

  test('a command that did not go through is worded for a turn with no answer', async () => {
    const asked: [string, boolean][] = [];
    const steps = resolveTurnOutcome(
      noted(turnOf('finished'), { kind: 'stopped', id: 'stopped:r', reason: 'Stopped.' }),
      IDLE,
    );
    const { container } = render(Chat, {
      id: 'only-tools',
      variant: 'transcript',
      conversation: steps.conversation,
      messageTurnState: (message: Parameters<typeof turnStateOf>[1]) => turnStateOf(steps, message),
      onDiscardTurn: () => false,
      turnLabels: {
        commandFailed: (command: string, beforeAnswer: boolean) => {
          asked.push([command, beforeAnswer]);
          return beforeAnswer
            ? `The turn’s ${command} was refused.`
            : `The reply’s ${command} was refused.`;
        },
      },
    });
    await tick();
    await fireEvent.click(getByRole(container, 'button', { name: 'Discard' }));
    await tick();
    await tick();
    expect(container.querySelector('.chat-turn-command-failure')?.textContent?.trim()).toBe(
      'The turn’s discard was refused.',
    );
    expect(asked.every(([, beforeAnswer]) => beforeAnswer)).toBe(true);
  });

  test('a refusal stays said when the transcript is drawn again, as a resize does', async () => {
    const stopped = noted(turnOf('finished'), {
      kind: 'stopped',
      id: 'stopped:r',
      reason: 'Stopped.',
    });
    const { container, rerender } = render(Chat, {
      id: 'only-tools',
      variant: 'transcript',
      onDiscardTurn: () => false,
      ...statesOf(stopped, IDLE),
    });
    await tick();
    await fireEvent.click(getByRole(container, 'button', { name: 'Discard' }));
    await tick();
    await tick();
    expect(container.querySelectorAll('.chat-turn-command-failure')).toHaveLength(1);
    await rerender({ variant: 'transcript', ...statesOf(stopped, IDLE) });
    await tick();
    await tick();
    expect(container.querySelectorAll('.chat-turn-command-failure')).toHaveLength(1);
  });
});
