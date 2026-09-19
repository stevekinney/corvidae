import { setupHappyDom } from '@corvidae/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import type { ConversationHistory, Message } from './conversation-model.ts';

setupHappyDom();

const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');
const { tick } = await import('svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function conversation(id: string): ConversationHistory {
  const now = '2026-06-01T12:00:00.000Z';
  const messages: Record<string, Message> = {};
  const ids: string[] = [];
  for (let position = 0; position < 20; position += 1) {
    const messageId = `${id}-message-${position}`;
    ids.push(messageId);
    messages[messageId] = {
      id: messageId,
      role: position % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${position}`,
      position,
      createdAt: now,
      metadata: {},
      hidden: false,
    };
  }
  return {
    schemaVersion: 4,
    id,
    status: 'active',
    metadata: {},
    ids,
    messages,
    createdAt: now,
    updatedAt: now,
  };
}

describe('history loading across conversation identity changes', () => {
  test('adapter-only changes release old loading so the replacement can start', async () => {
    let resolveOldLoad: ((result: { hasMore: boolean }) => void) | undefined;
    let newLoadCalled = false;
    const oldAdapter = {
      sendMessage: async () => {},
      loadOlderMessages: async () =>
        new Promise<{ hasMore: boolean }>((resolve) => {
          resolveOldLoad = resolve;
        }),
    };
    const newAdapter = {
      sendMessage: async () => {},
      loadOlderMessages: async () => {
        newLoadCalled = true;
        return { hasMore: true };
      },
    };
    const { container, rerender } = render(Chat, {
      props: {
        id: 'history-adapter-change',
        conversation: conversation('same-history'),
        adapter: oldAdapter,
      },
    });
    const trigger = await waitFor(() => {
      const element = container.querySelector<HTMLButtonElement>(
        '[data-cinder-history-trigger] button',
      );
      if (!element) throw new Error('history trigger did not render');
      return element;
    });
    await fireEvent.click(trigger);
    await rerender({
      id: 'history-adapter-change',
      conversation: conversation('same-history'),
      adapter: newAdapter,
    });
    const replacementTrigger = container.querySelector<HTMLButtonElement>(
      '[data-cinder-history-trigger] button',
    );
    if (!replacementTrigger) throw new Error('replacement history trigger did not render');
    await fireEvent.click(replacementTrigger);
    expect(newLoadCalled).toBe(true);
    resolveOldLoad?.({ hasMore: false });
  });

  test('conversation-only changes release old loading so the replacement can start', async () => {
    let loadCount = 0;
    let resolveOldLoad: ((result: { hasMore: boolean }) => void) | undefined;
    const adapter = {
      sendMessage: async () => {},
      loadOlderMessages: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return await new Promise<{ hasMore: boolean }>((resolve) => {
            resolveOldLoad = resolve;
          });
        }
        return { hasMore: true };
      },
    };
    const { container, rerender } = render(Chat, {
      props: {
        id: 'history-conversation-change',
        conversation: conversation('old-history'),
        adapter,
      },
    });
    const trigger = await waitFor(() => {
      const element = container.querySelector<HTMLButtonElement>(
        '[data-cinder-history-trigger] button',
      );
      if (!element) throw new Error('history trigger did not render');
      return element;
    });
    await fireEvent.click(trigger);
    await rerender({
      id: 'history-conversation-change',
      conversation: conversation('new-history'),
      adapter,
    });
    const replacementTrigger = container.querySelector<HTMLButtonElement>(
      '[data-cinder-history-trigger] button',
    );
    if (!replacementTrigger) throw new Error('replacement history trigger did not render');
    await fireEvent.click(replacementTrigger);
    expect(loadCount).toBe(2);
    resolveOldLoad?.({ hasMore: false });
  });

  test('does not let an old success hide the new conversation history trigger', async () => {
    let resolveOldLoad: ((result: { hasMore: boolean }) => void) | undefined;
    let newLoadCalled = false;
    const oldAdapter = {
      sendMessage: async () => {},
      loadOlderMessages: async () =>
        new Promise<{ hasMore: boolean }>((resolve) => {
          resolveOldLoad = resolve;
        }),
    };
    const newAdapter = {
      sendMessage: async () => {},
      loadOlderMessages: async () => {
        newLoadCalled = true;
        return { hasMore: true };
      },
    };
    const { container, rerender } = render(Chat, {
      props: {
        id: 'history-identity-success-chat',
        conversation: conversation('old-history'),
        adapter: oldAdapter,
        moreHistoryAvailable: true,
      },
    });
    const trigger = await waitFor(() => {
      const element = container.querySelector<HTMLButtonElement>(
        '[data-cinder-history-trigger] button',
      );
      if (!element) throw new Error('history trigger did not render');
      return element;
    });
    await fireEvent.click(trigger);

    await rerender({
      id: 'history-identity-success-chat',
      conversation: conversation('new-history'),
      adapter: newAdapter,
      moreHistoryAvailable: true,
    });
    const newTrigger = container.querySelector<HTMLButtonElement>(
      '[data-cinder-history-trigger] button',
    );
    if (!newTrigger) throw new Error('new history trigger did not render');
    await fireEvent.click(newTrigger);
    expect(newLoadCalled).toBe(true);
    resolveOldLoad?.({ hasMore: false });

    await waitFor(() => {
      const currentTrigger = container.querySelector<HTMLButtonElement>(
        '[data-cinder-history-trigger] button',
      );
      expect(currentTrigger).not.toBeNull();
      expect(currentTrigger?.disabled).toBe(false);
    });
  });

  test('does not report a stale rejection through the new conversation boundary', async () => {
    let rejectOldLoad: ((error: Error) => void) | undefined;
    const adapterErrors: { command: string; error: unknown }[] = [];
    const oldAdapter = {
      sendMessage: async () => {},
      loadOlderMessages: async () =>
        new Promise<{ hasMore: boolean }>((_resolve, reject) => {
          rejectOldLoad = reject;
        }),
    };
    const newAdapter = {
      sendMessage: async () => {},
      loadOlderMessages: async () => ({ hasMore: true }),
    };
    const { container, rerender } = render(Chat, {
      props: {
        id: 'history-identity-rejection-chat',
        conversation: conversation('old-history'),
        adapter: oldAdapter,
        moreHistoryAvailable: true,
        onadaptererror: (event: { command: string; error: unknown }) => {
          adapterErrors.push(event);
        },
      },
    });
    const trigger = await waitFor(() => {
      const element = container.querySelector<HTMLButtonElement>(
        '[data-cinder-history-trigger] button',
      );
      if (!element) throw new Error('history trigger did not render');
      return element;
    });
    await fireEvent.click(trigger);

    await rerender({
      id: 'history-identity-rejection-chat',
      conversation: conversation('new-history'),
      adapter: newAdapter,
      moreHistoryAvailable: true,
      onadaptererror: (event: { command: string; error: unknown }) => {
        adapterErrors.push(event);
      },
    });
    rejectOldLoad?.(new Error('stale history failure'));
    await tick();
    await Promise.resolve();
    await tick();

    expect(adapterErrors).toHaveLength(0);
  });
});
