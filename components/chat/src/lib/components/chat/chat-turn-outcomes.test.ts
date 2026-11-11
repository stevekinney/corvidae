/**
 * COR-2283: Chat wires a turn's run outcome from the host to the turn it describes. The host's
 * `messageTurnState` decides each assistant turn's state, Chat draws it on that turn with the
 * recovery controls the host supplied callbacks for, and a failed step under the turn offers
 * Retry this step through `onRetryStep`.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { createRawSnippet, tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import {
  appendAssistantMessage,
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';
import type { ConversationHistory, Message } from './conversation-model.ts';
import { advanceTurnState, type ChatTurnState } from './message/turn-state.ts';

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
const { default: OverrideDelegationFixture } =
  await import('./chat-override-delegation-fixture.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function answered(id: string): ConversationHistory {
  return appendAssistantMessage(
    appendUserMessage(createConversationHistory({ id }), 'Where is order 4398?'),
    'Order 4398 shipped with Parcelly on',
  );
}

function lastId(conversation: ConversationHistory): string {
  return conversation.ids.at(-1)!;
}

function turnOf(container: HTMLElement, messageId: string): HTMLElement {
  const article = container.querySelector<HTMLElement>(`article[data-message-id="${messageId}"]`);
  expect(article).not.toBeNull();
  return article!.closest<HTMLElement>('.chat-message-wrapper')!;
}

describe('Chat — run outcomes on the turn', () => {
  test('the host’s state is drawn on the turn it names, with the callbacks it supplied', async () => {
    const conversation = answered('stopped-turn');
    const assistantId = lastId(conversation);
    const continueTurn = mock((_messageId: string) => undefined);
    const discardTurn = mock((_messageId: string) => undefined);
    const { container } = render(Chat, {
      id: 'stopped-turn',
      conversation,
      variant: 'transcript',
      messageTurnState: (message: Message): ChatTurnState | undefined =>
        message.id === assistantId ? { kind: 'stopped' } : undefined,
      onContinueTurn: continueTurn,
      onDiscardTurn: discardTurn,
    });
    await tick();

    const turn = turnOf(container, assistantId);
    const outcome = turn.querySelector('.chat-turn-outcome');
    expect(outcome?.getAttribute('data-kind')).toBe('stopped');
    // Only the turn the state names carries it.
    expect(container.querySelectorAll('.chat-turn-outcome')).toHaveLength(1);

    await fireEvent.click(getByRole(turn, 'button', { name: 'Continue' }));
    await fireEvent.click(getByRole(turn, 'button', { name: 'Discard' }));
    expect(continueTurn).toHaveBeenCalledWith(assistantId);
    expect(discardTurn).toHaveBeenCalledWith(assistantId);
  });

  test('the host drives the turn through its states with advanceTurnState', async () => {
    const conversation = answered('driven-turn');
    const assistantId = lastId(conversation);
    let state: ChatTurnState = { kind: 'streaming' };
    const view = render(Chat, {
      id: 'driven-turn',
      conversation,
      variant: 'transcript',
      messageTurnState: () => state,
      onRetryConnection: () => undefined,
      onRetryTurn: () => undefined,
    });
    await tick();
    const kindOf = () =>
      turnOf(view.container, assistantId)
        .querySelector('.chat-turn-outcome')
        ?.getAttribute('data-kind') ?? null;
    expect(kindOf()).toBeNull();

    state = advanceTurnState(state, {
      type: 'connection-lost',
      attempt: 1,
      attempts: 3,
      nextTryIn: 4,
    });
    await view.rerender({ messageTurnState: () => state });
    await tick();
    expect(kindOf()).toBe('reconnecting');
    const reconnecting = view.container.querySelector('.chat-turn-callout')!;
    expect(reconnecting.querySelector('.cinder-callout__icon')).toBeNull();
    expect(reconnecting.querySelector('.chat-turn-text svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(view.container.textContent).toContain(
      'Connection lost. Reconnecting, attempt 1 of 3. Next try in 4 s.',
    );

    state = advanceTurnState(state, { type: 'fail', cause: 'Three tries failed.' });
    await view.rerender({ messageTurnState: () => state });
    await tick();
    expect(kindOf()).toBe('failed');
    const failed = view.container.querySelector('.chat-turn-alert')!;
    expect(failed.querySelector('.chat-turn-alert-header button')?.textContent?.trim()).toBe(
      'Retry',
    );
    expect(failed.querySelector('.chat-turn-failure-body')?.textContent).toContain(
      'Three tries failed.',
    );
    expect(view.container.textContent).toContain('Three tries failed.');

    state = advanceTurnState(state, { type: 'retry' });
    await view.rerender({ messageTurnState: () => state });
    await tick();
    expect(kindOf()).toBeNull();
  });

  test('a callback that throws leaves every turn as Chat sees it', async () => {
    const conversation = answered('throwing-turn');
    const { container } = render(Chat, {
      id: 'throwing-turn',
      conversation,
      variant: 'transcript',
      messageTurnState: () => {
        throw new Error('host bug');
      },
    });
    await tick();
    expect(container.querySelector('.chat-turn-outcome')).toBeNull();
    expect(container.textContent).toContain('Order 4398 shipped with Parcelly on');
  });

  test('a person’s message is never asked for a turn state', async () => {
    const asked: string[] = [];
    const conversation = answered('asked-roles');
    render(Chat, {
      id: 'asked-roles',
      conversation,
      messageTurnState: (message: Message) => {
        asked.push(message.role);
        return undefined;
      },
    });
    await tick();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((role) => role === 'assistant')).toBe(true);
  });

  test('a failed step under the turn offers Retry this step with its call id, and the header counts it', async () => {
    let conversation = appendUserMessage(createConversationHistory({ id: 'failed-step' }), 'Check');
    conversation = appendToolCall(conversation, {
      id: 'source-1',
      name: 'fetch_source',
      arguments: { url: 'https://example.com/a' },
    });
    conversation = appendToolResult(conversation, {
      callId: 'source-1',
      outcome: 'success',
      content: 'ok',
    });
    conversation = appendToolCall(conversation, {
      id: 'source-2',
      name: 'fetch_source',
      arguments: { url: 'https://example.com/b' },
    });
    conversation = appendToolResult(conversation, {
      callId: 'source-2',
      outcome: 'error',
      content: null,
      error: {
        code: 'timeout',
        category: 'timeout',
        retryable: true,
        message: 'example.com did not answer within 10 s.',
      },
    });
    const retryStep = mock((_toolCallId: string) => undefined);
    const { container } = render(Chat, {
      id: 'failed-step',
      conversation,
      onRetryStep: retryStep,
      turnLabels: {
        stepsDone: (worked: number, total: number) => `Checked ${worked} of ${total} sources`,
      },
    });
    await tick();

    const timeline = container.querySelector<HTMLElement>('.chat-tool-call-timeline');
    expect(timeline).not.toBeNull();
    expect(timeline?.querySelector('.chat-tool-call-summary-count')?.textContent).toBe(
      'Checked 1 of 2 sources,',
    );
    await fireEvent.click(getByRole(timeline!, 'button', { name: 'Retry this step' }));
    expect(retryStep).toHaveBeenCalledWith('source-2');
  });
});

describe('tool-call grouping under host customization (COR-2289)', () => {
  function threeLookups(id: string, lastOutcome: 'success' | 'error' = 'success') {
    let conversation = appendUserMessage(createConversationHistory({ id }), 'Compare the orders');
    for (const [index, order] of ['4471', '4472', '4473'].entries()) {
      const callId = `lookup-${order}`;
      conversation = appendToolCall(conversation, {
        id: callId,
        name: 'lookup_order',
        arguments: { order },
      });
      const failed = lastOutcome === 'error' && index === 2;
      conversation = appendToolResult(conversation, {
        callId,
        outcome: failed ? 'error' : 'success',
        content: failed ? null : { order },
        ...(failed
          ? {
              error: {
                code: 'timeout',
                category: 'timeout',
                retryable: true,
                message: 'The ledger did not answer within 10 s.',
              },
            }
          : {}),
      });
    }
    return appendAssistantMessage(conversation, 'All three orders shipped.');
  }

  test('a Chat with message actions, status, reasoning and an expansion callback still draws three contiguous calls as one group', async () => {
    const expandedChanges: boolean[] = [];
    const messageActions = createRawSnippet(() => ({
      render: () => '<span data-testid="host-action">Pin</span>',
    }));
    const messageStatus = createRawSnippet(() => ({
      render: () => '<span data-testid="host-status">Seen</span>',
    }));
    const { container } = render(Chat, {
      id: 'grouped-with-actions',
      conversation: threeLookups('grouped-with-actions'),
      messageActions,
      messageStatus,
      messageReasoning: (message: Message) =>
        message.role === 'assistant' ? 'Compared the three ship dates.' : undefined,
      onExpandedChange: (expanded: boolean) => expandedChanges.push(expanded),
    });
    await tick();

    const timelines = container.querySelectorAll<HTMLElement>('.chat-tool-call-timeline');
    expect(timelines).toHaveLength(1);
    expect(timelines[0]!.dataset['cinderToolCallCount']).toBe('3');
    // The host's snippets still draw on the messages that are rows of their own.
    expect(container.querySelectorAll('[data-testid="host-action"]').length).toBeGreaterThan(0);

    await fireEvent.click(timelines[0]!.querySelector<HTMLElement>('.chat-tool-call-toggle')!);
    expect(expandedChanges).toEqual([true]);
    // Three lookups of one tool fold into one row that counts them.
    const items = timelines[0]!.querySelectorAll<HTMLElement>('.chat-tool-call-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset['cinderToolCallRepeat']).toBe('3');
  });

  test('a tool call the host gives reasoning keeps its own row, and its neighbours still group', async () => {
    const { container } = render(Chat, {
      id: 'reasoning-call',
      conversation: threeLookups('reasoning-call'),
      messageReasoning: (message: Message) =>
        message.toolCall?.id === 'lookup-4473' ? 'Checking the last order twice.' : undefined,
    });
    await tick();

    const counts = [...container.querySelectorAll<HTMLElement>('.chat-tool-call-timeline')].map(
      (timeline) => timeline.dataset['cinderToolCallCount'],
    );
    expect(counts).toEqual(['2', '1']);
  });

  test('a host that draws rows and parts sees each call on its own row, and a failed one still offers Retry this step', async () => {
    const retryStep = mock((_toolCallId: string) => undefined);
    const { container } = render(OverrideDelegationFixture, {
      props: {
        conversation: threeLookups('own-rows', 'error'),
        delegate: true,
        onRetryStep: retryStep,
      },
    });
    await tick();

    const timelines = [...container.querySelectorAll<HTMLElement>('.chat-tool-call-timeline')];
    expect(timelines.map((timeline) => timeline.dataset['cinderToolCallCount'])).toEqual([
      '1',
      '1',
      '1',
    ]);
    await fireEvent.click(getByRole(timelines[2]!, 'button', { name: 'Retry this step' }));
    expect(retryStep).toHaveBeenCalledWith('lookup-4473');
  });
});
