/**
 * COR-2725: Chat runs a turn's recovery controls. One command is in flight per turn and its controls
 * say so, a press that arrives while it runs does nothing, a command that did not go through is said
 * once on its own turn, and an answer that arrives for another session, or for a turn that has since
 * moved on, changes nothing.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';
import type { ConversationHistory, Message } from './conversation-model.ts';
import type { ChatTurnState } from './message/turn-state.ts';

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

function answered(id: string): ConversationHistory {
  return appendAssistantMessage(
    appendUserMessage(createConversationHistory({ id }), 'Where is order 4398?'),
    'Order 4398 shipped with Parcelly on',
  );
}

/** A host command the test settles by hand. */
function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function turnOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('.chat-message-wrapper:has(.chat-turn-outcome)')!;
}

const FAILED_LINE = 'That did not go through. Try again.';

function failureLines(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.chat-turn-command-failure')].map(
    (line) => line.textContent?.trim() ?? '',
  );
}

function stoppedTurn(id: string, assistantId: string, state: ChatTurnState = { kind: 'stopped' }) {
  return {
    id,
    variant: 'transcript' as const,
    messageTurnState: (message: Message): ChatTurnState | undefined =>
      message.id === assistantId ? state : undefined,
  };
}

describe('Chat — a turn’s recovery commands', () => {
  test('a press while the command runs does nothing, and the turn’s controls say it is busy', async () => {
    const conversation = answered('busy');
    const assistantId = conversation.ids.at(-1)!;
    const running = deferred<void>();
    const continueTurn = mock((_messageId: string) => running.promise);
    const { container } = render(Chat, {
      ...stoppedTurn('busy', assistantId),
      conversation,
      onContinueTurn: continueTurn,
      onDiscardTurn: () => undefined,
    });
    await tick();

    const turn = turnOf(container);
    const continueButton = getByRole(turn, 'button', { name: 'Continue' });
    await fireEvent.click(continueButton);
    await fireEvent.click(continueButton);
    await tick();
    expect(continueTurn).toHaveBeenCalledTimes(1);
    expect(continueButton.getAttribute('aria-busy')).toBe('true');
    // The other control of the turn is held too: one command, one visible outcome.
    expect(getByRole(turn, 'button', { name: 'Discard' }).hasAttribute('disabled')).toBe(true);

    running.settle();
    await tick();
    expect(continueButton.hasAttribute('aria-busy')).toBe(false);
    expect(getByRole(turn, 'button', { name: 'Discard' }).hasAttribute('disabled')).toBe(false);
    expect(failureLines(container)).toEqual([]);
  });

  test('a command the host refuses or fails is said once on its turn, and the next press replaces it', async () => {
    const conversation = answered('refused');
    const assistantId = conversation.ids.at(-1)!;
    const answers = [Promise.resolve(false), Promise.reject(new Error('offline'))];
    const discardTurn = mock((_messageId: string) => answers.shift() ?? Promise.resolve());
    const { container } = render(Chat, {
      ...stoppedTurn('refused', assistantId),
      conversation,
      onDiscardTurn: discardTurn,
    });
    await tick();

    const discard = getByRole(turnOf(container), 'button', { name: 'Discard' });
    await fireEvent.click(discard);
    await tick();
    expect(failureLines(container)).toEqual([FAILED_LINE]);
    expect(container.querySelector('.chat-turn-command-failure')?.getAttribute('role')).toBe(
      'alert',
    );

    await fireEvent.click(discard);
    await tick();
    expect(discardTurn).toHaveBeenCalledTimes(2);
    expect(failureLines(container)).toEqual([FAILED_LINE]);
  });

  test('the host’s own words for a command that did not go through replace the default', async () => {
    const conversation = answered('words');
    const assistantId = conversation.ids.at(-1)!;
    const { container } = render(Chat, {
      ...stoppedTurn('words', assistantId),
      conversation,
      onDiscardTurn: () => false,
      turnLabels: { commandFailed: (command: string) => `The ${command} was not done.` },
    });
    await tick();
    await fireEvent.click(getByRole(turnOf(container), 'button', { name: 'Discard' }));
    await tick();
    expect(failureLines(container)).toEqual(['The discard was not done.']);
  });

  test('an answer that arrives after another session is shown says nothing there', async () => {
    const conversation = answered('session-a');
    const assistantId = conversation.ids.at(-1)!;
    const running = deferred<boolean>();
    const discardTurn = mock((_messageId: string) => running.promise);
    const view = render(Chat, {
      ...stoppedTurn('session-a', assistantId),
      conversation,
      onDiscardTurn: discardTurn,
    });
    await tick();
    await fireEvent.click(getByRole(turnOf(view.container), 'button', { name: 'Discard' }));
    await tick();

    // The person moves to another chat whose last turn is also stopped, then the first answer lands.
    const other = answered('session-b');
    await view.rerender({
      ...stoppedTurn('session-b', other.ids.at(-1)!),
      id: 'session-b',
      conversation: other,
    });
    await tick();
    running.settle(false);
    await tick();
    expect(failureLines(view.container)).toEqual([]);

    // The other chat's turn takes its own press: nothing from the first one is still in flight.
    const discard = getByRole(turnOf(view.container), 'button', { name: 'Discard' });
    expect(discard.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(discard);
    expect(discardTurn).toHaveBeenCalledTimes(2);
  });

  test('an answer that arrives after the turn moved on changes nothing', async () => {
    const conversation = answered('late');
    const assistantId = conversation.ids.at(-1)!;
    const running = deferred<boolean>();
    let state: ChatTurnState = { kind: 'stopped' };
    const view = render(Chat, {
      id: 'late',
      variant: 'transcript',
      conversation,
      messageTurnState: (message: Message) => (message.id === assistantId ? state : undefined),
      onContinueTurn: () => running.promise,
      onDiscardTurn: () => undefined,
    });
    await tick();
    await fireEvent.click(getByRole(turnOf(view.container), 'button', { name: 'Continue' }));
    await tick();

    // The run picks up again by itself and finishes before the host answers Continue.
    state = { kind: 'complete' };
    await view.rerender({
      messageTurnState: (message: Message) => (message.id === assistantId ? state : undefined),
    });
    await tick();
    running.settle(false);
    await tick();
    expect(failureLines(view.container)).toEqual([]);
    expect(view.container.querySelector('.chat-turn-outcome')).toBeNull();
  });

  test('Retry now is one press while it runs, on the notice beside the composer', async () => {
    const conversation = answered('reconnect');
    const assistantId = conversation.ids.at(-1)!;
    const running = deferred<void>();
    const retryConnection = mock((_messageId: string) => running.promise);
    const { container } = render(Chat, {
      id: 'reconnect',
      variant: 'transcript',
      conversation,
      messageTurnState: (message: Message): ChatTurnState | undefined =>
        message.id === assistantId
          ? { kind: 'reconnecting', attempt: 1, attempts: 3, nextTryIn: 4, wait: 5 }
          : undefined,
      onRetryConnection: retryConnection,
    });
    await tick();

    const notice = container.querySelector<HTMLElement>('.chat-connection-notice')!;
    const retryNow = getByRole(notice, 'button', { name: 'Retry now' });
    await fireEvent.click(retryNow);
    await fireEvent.click(retryNow);
    await tick();
    expect(retryConnection).toHaveBeenCalledTimes(1);
    expect(retryNow.getAttribute('aria-busy')).toBe('true');
    running.settle();
    await tick();
    expect(retryNow.hasAttribute('aria-busy')).toBe(false);
  });

  test('Regenerate is one press while it runs', async () => {
    const conversation = answered('regenerate');
    const running = deferred<void>();
    const regenerate = mock((_messageId: string) => running.promise);
    const { container } = render(Chat, {
      id: 'regenerate',
      variant: 'transcript',
      conversation,
      onRegenerate: regenerate,
    });
    await tick();

    const button = container.querySelector<HTMLButtonElement>('.chat-message-regenerate-button')!;
    await fireEvent.click(button);
    await fireEvent.click(button);
    await tick();
    expect(regenerate).toHaveBeenCalledTimes(1);
    running.settle();
    await tick();
    await fireEvent.click(button);
    expect(regenerate).toHaveBeenCalledTimes(2);
  });
});
