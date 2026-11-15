/**
 * A conversation that is not available stands in the transcript's place (COR-2285, rows V2 and V3):
 * skeleton turns with `Loading conversation…` and the seconds so far, the editor kept and Send
 * waiting for the history, a slow read with its indicator, elapsed time and Cancel, Retry after
 * Cancel, Cinder's `ErrorState` with Retry and All conversations for a history that failed, and
 * a deleted conversation with All conversations as the primary action and no composer.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';
import type { ChatAvailability } from './container/chat-availability.ts';

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

function conversation(id: string) {
  return appendAssistantMessage(
    appendUserMessage(createConversationHistory({ id }), 'hi'),
    'hello',
  );
}

function mountWith(id: string, availability: ChatAvailability | undefined) {
  return render(Chat, {
    props: { id, conversation: conversation(`${id}-conversation`), availability },
  });
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
  );
}

function timelineOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('.chat-timeline')!;
}

function composerWrapperOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('.chat-input-wrapper')!;
}

test('an unconfigured chat with no message centers a provider action in place of the conversation', async () => {
  let connected = 0;
  const { container } = render(Chat, {
    props: {
      id: 'availability-unconfigured',
      conversation: createConversationHistory({ id: 'availability-unconfigured-conversation' }),
      availability: { kind: 'unconfigured', onConnect: () => (connected += 1) },
    },
  });
  const state = container.querySelector<HTMLElement>('[data-chat-availability="unconfigured"]')!;
  expect(state.textContent).toContain('Connect a model provider');
  expect(timelineOf(container).style.display).toBe('none');
  expect(composerWrapperOf(container).style.display).toBe('none');
  const connect = buttonNamed(state, 'Connect provider')!;
  expect(connect.getAttribute('data-cinder-variant')).toBe('primary');
  await fireEvent.click(connect);
  expect(connected).toBe(1);
});

test('an unconfigured chat with messages keeps them readable and replaces only the composer', async () => {
  let connected = 0;
  const { container } = mountWith('availability-unconfigured-history', {
    kind: 'unconfigured',
    onConnect: () => (connected += 1),
  });

  // The transcript stays: nothing stands in its place.
  expect(timelineOf(container).style.display).not.toBe('none');
  expect(container.querySelector('[data-chat-availability]')).toBeNull();
  expect(timelineOf(container).textContent).toContain('hello');
  // The composer is one blocked row with the same words and the primary provider action.
  expect(composerWrapperOf(container).style.display).not.toBe('none');
  const blocked = container.querySelector('[data-chat-composer-status="blocked"]')!;
  expect(blocked.textContent).toContain('Connect a model provider');
  expect(container.querySelector('textarea.chat-input-editor')).toBeNull();
  const connect = buttonNamed(container, 'Connect provider')!;
  expect(blocked.contains(connect)).toBe(true);
  expect(connect.getAttribute('data-cinder-variant')).toBe('primary');
  await fireEvent.click(connect);
  expect(connected).toBe(1);
});

describe('a conversation that is loading', () => {
  test('draws skeleton turns and a status line with the seconds so far, in the transcript place', () => {
    const { container } = mountWith('availability-loading', { kind: 'loading' });

    const region = container.querySelector('[data-chat-availability="loading"]')!;
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(region.querySelectorAll('.cinder-skeleton').length).toBeGreaterThan(2);
    expect(region.querySelector('.chat-availability-reading')?.textContent?.trim()).toBe(
      'Loading conversation…',
    );
    expect(region.querySelector('[data-chat-availability-elapsed]')).toBeNull();
    // The transcript that was there is out of sight, not discarded.
    expect(timelineOf(container).style.display).toBe('none');
    // One status for a screen reader, with no ticking number in it.
    const status = region.querySelector('[role="status"]')!;
    expect(status.textContent?.trim()).toBe('Loading conversation…');
    expect(status.textContent).not.toMatch(/\d/u);
  });

  test('keeps the editor, and Send waits for the history to load', () => {
    const { container } = mountWith('availability-send', { kind: 'loading' });

    expect(composerWrapperOf(container).style.display).not.toBe('none');
    const editor = container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor')!;
    expect(editor.disabled).toBe(false);
    expect(editor.readOnly).toBe(false);
    const send = buttonNamed(container, 'Loading…')!;
    expect(send.disabled).toBe(true);
  });

  test('once the read is slow, adds an indicator, the elapsed time and Cancel', async () => {
    let canceled = 0;
    const { container } = mountWith('availability-slow', {
      kind: 'loading',
      slowAfterSeconds: 0,
      onCancel: () => (canceled += 1),
    });
    await tick();

    const region = container.querySelector('[data-chat-availability="loading"]')!;
    expect(region.getAttribute('data-slow')).toBe('');
    expect(region.querySelector('.cinder-spinner')).not.toBeNull();
    expect(region.querySelector('.chat-availability-reading')?.textContent?.trim()).toBe(
      'Still loading. This is taking longer than usual.',
    );
    expect(region.querySelector('[data-chat-availability-elapsed]')?.textContent?.trim()).toMatch(
      /^\d+s$/u,
    );

    const cancel = buttonNamed(container, 'Cancel')!;
    await fireEvent.click(cancel);
    expect(canceled).toBe(1);
  });

  test('draws no Cancel when the host gives no way to cancel', async () => {
    const { container } = mountWith('availability-no-cancel', {
      kind: 'loading',
      slowAfterSeconds: 0,
    });
    await tick();

    expect(buttonNamed(container, 'Cancel')).toBeUndefined();
  });

  test('says the host words instead of the defaults', () => {
    const { container } = mountWith('availability-labels', {
      kind: 'loading',
      labels: { loading: 'جارٍ تحميل المحادثة…', sendWaits: 'انتظر' },
    });

    expect(container.querySelector('.chat-availability-reading')?.textContent?.trim()).toBe(
      'جارٍ تحميل المحادثة…',
    );
    expect(container.querySelector('[data-chat-availability-elapsed]')).toBeNull();
    expect(buttonNamed(container, 'انتظر')).not.toBeUndefined();
  });

  test('gives the transcript back when the availability clears', async () => {
    const view = mountWith('availability-clears', { kind: 'loading' });
    expect(timelineOf(view.container).style.display).toBe('none');

    await view.rerender({ availability: undefined });
    expect(view.container.querySelector('[data-chat-availability]')).toBeNull();
    expect(timelineOf(view.container).style.display).not.toBe('none');
    expect(buttonNamed(view.container, 'Loading…')).toBeUndefined();
  });
});

describe('a canceled read', () => {
  test('offers Retry as the primary action and All conversations beside it', async () => {
    const calls: string[] = [];
    const { container } = mountWith('availability-canceled', {
      kind: 'canceled',
      onRetry: () => calls.push('retry'),
      allConversations: { label: 'All conversations', onclick: () => calls.push('list') },
    });

    const state = container.querySelector('[data-chat-availability="canceled"]')!;
    expect(state.querySelector('.cinder-error-state-title')?.textContent?.trim()).toBe(
      'Loading was canceled',
    );
    expect(state.querySelector('.chat-availability-canceled-icon')).not.toBeNull();
    expect(state.querySelector('.lucide-search')).toBeNull();
    const retry = buttonNamed(container, 'Retry')!;
    const list = buttonNamed(container, 'All conversations')!;
    expect(retry.getAttribute('data-cinder-variant')).toBe('primary');
    expect(list.getAttribute('data-cinder-variant')).toBe('secondary');
    // The editor remains mounted and editable, but canceled is not presented as ongoing loading.
    const editor = container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor')!;
    expect(editor.readOnly).toBe(false);
    const send = buttonNamed(container, 'Send message')!;
    expect(send.disabled).toBe(true);
    // The state says what happened once (COR-2327 B6): no notice over the composer, and the reason
    // Send is off beside Send, named by it, in words that point to the Retry that exists.
    expect(container.querySelector('[data-chat-composer-drawer]')).toBeNull();
    const reason = container.querySelector('.chat-input-paused-reason');
    expect(reason?.textContent?.trim()).toBe('Retry to send messages.');
    expect(container.textContent?.match(/Retry to send messages\./gu)).toHaveLength(1);
    expect(send.getAttribute('aria-describedby')).toContain(reason?.id ?? 'missing-reason');

    await fireEvent.click(retry);
    await fireEvent.click(list);
    expect(calls).toEqual(['retry', 'list']);
  });

  test('lets the host replace the disabled-send reason', () => {
    const { container } = mountWith('availability-canceled-labels', {
      kind: 'canceled',
      onRetry: () => undefined,
      labels: { sendBlocked: 'Load history before sending.' },
    });

    expect(container.querySelector('[data-chat-composer-drawer]')).toBeNull();
    expect(container.querySelector('.chat-input-paused-reason')?.textContent?.trim()).toBe(
      'Load history before sending.',
    );
  });
});

describe('a history that could not be loaded', () => {
  test('is an ErrorState with the cause, a primary Retry and a secondary All conversations, and no composer', async () => {
    const calls: string[] = [];
    const { container } = mountWith('availability-error', {
      kind: 'error',
      cause: 'Interborough didn’t send it back. Nothing was lost.',
      detail: 'HTTP 500',
      onRetry: () => calls.push('retry'),
      allConversations: { label: 'All conversations', onclick: () => calls.push('list') },
    });

    const state = container.querySelector('[data-chat-availability="error"]')!;
    expect(state.classList.contains('cinder-error-state')).toBe(true);
    expect(state.querySelector('.cinder-error-state-title')?.textContent?.trim()).toBe(
      'This conversation couldn’t be loaded',
    );
    expect(state.querySelector('.cinder-error-state-description')?.textContent?.trim()).toBe(
      'Interborough didn’t send it back. Nothing was lost.',
    );
    expect(state.textContent).toContain('HTTP 500');
    const retry = buttonNamed(container, 'Retry')!;
    const list = buttonNamed(container, 'All conversations')!;
    expect(retry.getAttribute('data-cinder-variant')).toBe('primary');
    expect(list.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(composerWrapperOf(container).style.display).toBe('none');
    expect(timelineOf(container).style.display).toBe('none');

    await fireEvent.click(retry);
    await fireEvent.click(list);
    expect(calls).toEqual(['retry', 'list']);
  });

  test('draws no All conversations when the host gives no way back', () => {
    const { container } = mountWith('availability-error-alone', {
      kind: 'error',
      cause: 'It did not answer.',
      onRetry: () => undefined,
    });

    expect(buttonNamed(container, 'Retry')).not.toBeUndefined();
    expect(buttonNamed(container, 'All conversations')).toBeUndefined();
  });
});

describe('a deleted conversation', () => {
  test('says it was deleted, with All conversations as its primary action and no composer', async () => {
    let went = 0;
    const { container } = mountWith('availability-deleted', {
      kind: 'deleted',
      allConversations: { label: 'All conversations', onclick: () => (went += 1) },
    });

    const state = container.querySelector('[data-chat-availability="deleted"]')!;
    expect(state.getAttribute('data-cinder-tone')).toBe('neutral');
    expect(state.querySelector('.cinder-error-state-title')?.textContent?.trim()).toBe(
      'This conversation was deleted',
    );
    expect(state.querySelector('.chat-availability-deleted-icon')).not.toBeNull();
    expect(state.querySelector('.lucide-search')).toBeNull();
    const list = buttonNamed(container, 'All conversations')!;
    expect(list.getAttribute('data-cinder-variant')).toBe('primary');
    expect(composerWrapperOf(container).style.display).toBe('none');

    await fireEvent.click(list);
    expect(went).toBe(1);
  });
});
