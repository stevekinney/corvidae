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
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
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
        const calls: Record<string, ReturnType<typeof mock>> = {
          continue: mock((_id: string) => undefined),
          discard: mock((_id: string) => undefined),
          retry: mock((_id: string) => undefined),
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
        const pressed = { stopped: ['continue', 'discard'], failed: ['retry'], empty: ['retry'] }[
          cell.kind
        ];
        // The first press of a stopped turn holds the other control, so only it reaches the host.
        expect(calls[pressed[0]!]).toHaveBeenCalledTimes(1);
        expect(calls[pressed[0]!]).toHaveBeenCalledWith(`${conversation.ids.at(-1)!}:outcome`);
      });
    }
  }

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
