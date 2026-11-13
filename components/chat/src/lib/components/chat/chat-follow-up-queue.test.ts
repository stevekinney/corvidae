/**
 * Follow-ups typed while a run works wait in the composer's Up next drawer (COR-2284, row C3).
 *
 * Asserts:
 *   1. A follow-up typed during a run is neither sent nor handed to the run: it waits as a dashed,
 *      numbered ghost under Up next, with Edit and a named remove, and Send reads Queue.
 *   2. When the run finishes the follow-ups go, one turn at a time, in the order typed.
 *   3. Send now instead hands them to the running run through `sendRunInput`.
 *   4. Edit and remove take a follow-up out of the queue; Edit puts its words back in the box.
 *   5. Stopping the run sets the follow-ups aside in a drawer whose Restore puts them back in the
 *      composer, and nothing is sent when the run ends.
 *   6. Another conversation starts with an empty queue.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import type { ChatAdapter } from './adapter/chat-adapter.ts';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';
import type { ConversationHistory } from './conversation-model.ts';
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

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function composerOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor')!;
}

async function submit(container: HTMLElement, text: string): Promise<void> {
  const composer = composerOf(container);
  await fireEvent.input(composer, { target: { value: text } });
  await fireEvent.keyDown(composer, { key: 'Enter' });
  await tick();
}

async function settle(): Promise<void> {
  // load-proof: Svelte effects, event handlers and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await tick();
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
  );
}

function drawerOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-chat-follow-up-drawer]');
}

function ghostTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.chat-follow-up-ghost-text')].map(
    (node) => node.textContent ?? '',
  );
}

function workingConversation(id: string): ConversationHistory {
  return appendAssistantMessage(
    appendUserMessage(createConversationHistory({ id }), 'hello'),
    'working on it',
  );
}

/** An adapter that records what it is handed; `sendMessage` settles only when released. */
function recordingAdapter() {
  const sent: string[] = [];
  const runInput: string[] = [];
  const releases: Array<() => void> = [];
  const adapter: ChatAdapter = {
    sendMessage: (message) => {
      sent.push(typeof message.content === 'string' ? message.content : '');
      return new Promise<void>((resolve) => releases.push(resolve));
    },
    sendRunInput: async (_conversationId, message) => {
      runInput.push(typeof message.content === 'string' ? message.content : '');
    },
    stopGenerating: async () => undefined,
  };
  return { adapter, sent, runInput, releases };
}

describe('Chat queued follow-ups (COR-2284, row C3)', () => {
  test('keeps queued follow-ups until an offline transport reconnects', async () => {
    const { adapter, sent, runInput, releases } = recordingAdapter();
    const rendered = render(Chat, {
      id: 'queue-offline',
      conversation: workingConversation('queue-offline'),
      streaming: true,
      adapter,
    });
    await submit(rendered.container, 'wait for reconnect');
    await submit(rendered.container, 'then continue in order');
    const staleSendNow = buttonNamed(rendered.container, 'Send now instead');
    expect(staleSendNow).toBeDefined();
    await rendered.rerender({ composerStatus: { kind: 'offline' } });
    await settle();
    expect(sent).toEqual([]);
    expect(runInput).toEqual([]);
    expect(ghostTexts(rendered.container)).toEqual([
      'wait for reconnect',
      'then continue in order',
    ]);
    expect(buttonNamed(rendered.container, 'Send now instead')).toBeUndefined();
    await fireEvent.click(staleSendNow!);
    await settle();
    expect(sent).toEqual([]);
    expect(runInput).toEqual([]);
    expect(ghostTexts(rendered.container)).toEqual([
      'wait for reconnect',
      'then continue in order',
    ]);
    await rendered.rerender({ streaming: false });
    await rendered.rerender({ composerStatus: { kind: 'reconnecting', attempt: 1 } });
    await settle();
    expect(sent).toEqual([]);
    expect(ghostTexts(rendered.container)).toEqual([
      'wait for reconnect',
      'then continue in order',
    ]);
    await rendered.rerender({ composerStatus: { kind: 'note', text: 'Back online' } });
    await settle();
    expect(sent).toEqual(['wait for reconnect']);
    releases[0]!();
    await settle();
    expect(sent).toEqual(['wait for reconnect', 'then continue in order']);
    releases[1]!();
  });

  test('offline failure discards the queue for Restore instead of waiting to dispatch', async () => {
    const { adapter, sent } = recordingAdapter();
    let turnState: ChatTurnState = { kind: 'streaming' };
    const rendered = render(Chat, {
      id: 'queue-offline-failed',
      conversation: workingConversation('queue-offline-failed'),
      streaming: true,
      adapter,
      messageTurnState: () => turnState,
    });

    await submit(rendered.container, 'keep offline');
    turnState = { kind: 'failed', cause: 'The run failed while offline.' };
    await rendered.rerender({ composerStatus: { kind: 'offline' }, streaming: false });
    await settle();

    expect(sent).toEqual([]);
    expect(
      rendered.container.querySelector('[data-chat-follow-up-discard="failed"]'),
    ).not.toBeNull();
    expect(ghostTexts(rendered.container)).toEqual([]);
    await fireEvent.click(buttonNamed(rendered.container, 'Restore')!);
    await tick();
    expect(composerOf(rendered.container).value).toBe('keep offline');
  });

  test('keeps the phone queue rows compact without shrinking action hit regions', async () => {
    const source = await Bun.file(
      new URL('./container/chat-follow-up-drawer.svelte', import.meta.url),
    ).text();

    expect(source).toMatch(/\.chat-follow-up-ghost\s*\{[^}]*min-block-size:\s*2\.75rem;/s);
    expect(source).toMatch(/\.chat-follow-up-ghost-actions\s*\{[^}]*display:\s*flex;/s);
    // Edit and Remove stand a 40px pitch apart, and the header has block padding at any pointer.
    expect(source).toMatch(
      /\.chat-follow-up-ghost-actions\s*\{[^}]*gap:\s*var\(--cinder-space-3\);/s,
    );
    expect(source).toMatch(
      /\.chat-follow-up-drawer-header\s*\{[^}]*padding-block:\s*var\(--cinder-space-2\);/s,
    );
  });

  test('a follow-up typed during a run waits under Up next, sent to neither the run nor a new turn', async () => {
    const { adapter, sent, runInput } = recordingAdapter();
    const { container } = render(Chat, {
      id: 'queue-waits',
      conversation: workingConversation('queue-waits'),
      streaming: true,
      adapter,
    });

    await fireEvent.input(composerOf(container), { target: { value: 'then check the logs' } });
    await tick();
    const send = container.querySelector<HTMLButtonElement>('[data-chat-send]')!;
    expect(send.getAttribute('aria-label')).toBe('Queue message');
    expect(send.hasAttribute('data-cinder-icon-only')).toBe(true);
    expect(send.textContent?.trim()).toBe('');

    await fireEvent.keyDown(composerOf(container), { key: 'Enter' });
    await tick();

    expect(sent).toEqual([]);
    expect(runInput).toEqual([]);
    const drawer = drawerOf(container)!;
    expect(drawer).not.toBeNull();
    expect(drawer.querySelector('.chat-follow-up-drawer-title')?.textContent).toBe('Up next');
    expect(drawer.querySelector('.chat-follow-up-drawer-summary-short')?.textContent).toBe(
      '1 queued',
    );
    expect(drawer.querySelector('.chat-follow-up-drawer-summary-long')?.textContent).toBe(
      '1 queued, sends after this run',
    );
    expect(drawer.textContent).not.toContain(String.fromCodePoint(0xb7));
    expect(ghostTexts(container)).toEqual(['then check the logs']);
    expect(drawer.querySelector('.chat-follow-up-ghost-index')?.textContent).toBe('1');
    expect(buttonNamed(container, 'Edit queued follow-up 1')).toBeDefined();
    expect(buttonNamed(container, 'Remove queued follow-up 1')).toBeDefined();
    const sendNow = buttonNamed(container, 'Send now instead');
    expect(sendNow?.closest('.chat-follow-up-drawer-header')).not.toBeNull();
    expect(composerOf(container).value).toBe('');
  });

  test('when the run finishes the follow-ups go as turns of their own, one at a time, in order', async () => {
    const { adapter, sent, releases } = recordingAdapter();
    const rendered = render(Chat, {
      id: 'queue-drains',
      conversation: workingConversation('queue-drains'),
      streaming: true,
      adapter,
    });

    await submit(rendered.container, 'first');
    await submit(rendered.container, 'second');
    expect(ghostTexts(rendered.container)).toEqual(['first', 'second']);
    expect(
      rendered.container.querySelector('.chat-follow-up-drawer-summary-short')?.textContent,
    ).toBe('2 queued');

    await rendered.rerender({ streaming: false });
    await settle();

    // The first is a new turn; the second waits for that turn to be handed over.
    expect(sent).toEqual(['first']);
    expect(ghostTexts(rendered.container)).toEqual(['second']);

    releases[0]!();
    await settle();

    expect(sent).toEqual(['first', 'second']);
    expect(drawerOf(rendered.container)).toBeNull();
    releases[1]!();
  });

  test('a failed turn discards queued follow-ups instead of dispatching them', async () => {
    const { adapter, sent } = recordingAdapter();
    let turnState: ChatTurnState = { kind: 'streaming' };
    const rendered = render(Chat, {
      id: 'queue-failed-turn',
      conversation: workingConversation('queue-failed-turn'),
      streaming: true,
      adapter,
      messageTurnState: () => turnState,
    });

    await submit(rendered.container, 'keep this');
    await submit(rendered.container, 'and this');
    expect(ghostTexts(rendered.container)).toEqual(['keep this', 'and this']);

    turnState = { kind: 'failed', cause: 'The run failed.' };
    await rendered.rerender({ streaming: false, messageTurnState: () => turnState });
    await settle();

    expect(sent).toEqual([]);
    expect(drawerOf(rendered.container)).toBeNull();
    const discard = rendered.container.querySelector<HTMLElement>(
      '[data-chat-follow-up-discard="failed"]',
    );
    expect(discard?.textContent).toContain('The run failed');
    expect(discard?.textContent).toContain('2 queued follow-ups');

    await fireEvent.click(buttonNamed(rendered.container, 'Restore')!);
    await tick();
    expect(composerOf(rendered.container).value).toBe('keep this\n\nand this');
  });

  test('Send now instead hands the follow-ups to the running run, in order', async () => {
    const { adapter, sent, runInput } = recordingAdapter();
    const { container } = render(Chat, {
      id: 'queue-send-now',
      conversation: workingConversation('queue-send-now'),
      streaming: true,
      adapter,
    });

    await submit(container, 'one');
    await submit(container, 'two');
    await fireEvent.click(buttonNamed(container, 'Send now instead')!);
    await settle();

    expect(runInput).toEqual(['one', 'two']);
    expect(sent).toEqual([]);
    expect(drawerOf(container)).toBeNull();
  });

  test('remove takes a follow-up out, and Edit puts its words back in the composer', async () => {
    const { adapter, sent, runInput } = recordingAdapter();
    const rendered = render(Chat, {
      id: 'queue-edit',
      conversation: workingConversation('queue-edit'),
      streaming: true,
      adapter,
    });

    await submit(rendered.container, 'drop this');
    await submit(rendered.container, 'fix this');
    await fireEvent.click(buttonNamed(rendered.container, 'Remove queued follow-up 1')!);
    await tick();
    expect(ghostTexts(rendered.container)).toEqual(['fix this']);

    await fireEvent.click(buttonNamed(rendered.container, 'Edit queued follow-up 1')!);
    await tick();

    expect(drawerOf(rendered.container)).toBeNull();
    expect(composerOf(rendered.container).value).toBe('fix this');

    await rendered.rerender({ streaming: false });
    await settle();
    expect(sent).toEqual([]);
    expect(runInput).toEqual([]);
  });

  test('Stop sets the follow-ups aside, and Restore puts them back in the composer', async () => {
    const { adapter, sent } = recordingAdapter();
    const rendered = render(Chat, {
      id: 'queue-stop',
      conversation: workingConversation('queue-stop'),
      streaming: true,
      adapter,
    });

    await submit(rendered.container, 'first thought');
    await submit(rendered.container, 'second thought');
    await fireEvent.click(buttonNamed(rendered.container, 'Stop generating')!);
    await tick();

    expect(drawerOf(rendered.container)).toBeNull();
    const discard = rendered.container.querySelector<HTMLElement>('[data-chat-follow-up-discard]')!;
    expect(discard.getAttribute('data-chat-follow-up-discard')).toBe('stopped');
    expect(discard.querySelector('.chat-follow-up-discard-text')?.textContent?.trim()).toBe(
      'The run was stopped, so your 2 queued follow-ups were not sent.',
    );
    // Restore sits inline with the sentence; the dismiss is Callout's own, at the trailing end.
    const actions = [...discard.querySelectorAll('button')].map(
      (button) => button.getAttribute('aria-label') ?? button.textContent?.trim(),
    );
    expect(actions).toEqual(['Restore', 'Dismiss']);
    expect(
      discard
        .querySelector('button[aria-label="Dismiss"]')
        ?.classList.contains('cinder-callout__dismiss'),
    ).toBe(true);

    await rendered.rerender({ streaming: false });
    await settle();
    expect(sent).toEqual([]);

    await fireEvent.click(buttonNamed(rendered.container, 'Restore')!);
    await tick();

    expect(composerOf(rendered.container).value).toBe('first thought\n\nsecond thought');
    expect(rendered.container.querySelector('[data-chat-follow-up-discard]')).toBeNull();
  });

  test('another conversation starts with an empty queue', async () => {
    const { adapter, sent } = recordingAdapter();
    const rendered = render(Chat, {
      id: 'queue-switch',
      conversation: workingConversation('queue-before'),
      streaming: true,
      adapter,
    });

    await submit(rendered.container, 'for the first chat');
    expect(ghostTexts(rendered.container)).toEqual(['for the first chat']);

    await rendered.rerender({ conversation: workingConversation('queue-after') });
    await tick();
    expect(drawerOf(rendered.container)).toBeNull();

    await rendered.rerender({ streaming: false });
    await settle();
    expect(sent).toEqual([]);
  });
});
