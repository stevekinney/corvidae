/**
 * Sending a reply that carries quoted excerpts.
 *
 * Asserts, with the exact content each time:
 *   1. Every quote line gets a `> ` prefix, quotes are separated by one blank
 *      line, and one blank line precedes the typed text.
 *   2. A long quote is cut to 3,999 characters plus an ellipsis.
 *   3. The content goes through `ChatAdapter.sendMessage`, through
 *      `sendRunInput` while a run is active, and through `onSubmit` with no
 *      adapter.
 *   4. A successful send clears the chips; a failed one keeps them.
 *   5. A quote added while a send is in flight survives that send's success.
 *   6. A reply without quotes is sent exactly as typed.
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
import { quoteChips, quoteMessageButtons } from './chat-quote-test-support.ts';

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
  window.getSelection()?.removeAllRanges();
  cleanup();
  document.body.replaceChildren();
});

function conversationOf(id: string, replies: readonly string[]) {
  let conversation = appendUserMessage(createConversationHistory({ id }), 'Go.');
  for (const reply of replies) conversation = appendAssistantMessage(conversation, reply);
  return conversation;
}

async function quote(container: HTMLElement, index: number): Promise<void> {
  await fireEvent.click(quoteMessageButtons(container)[index]!);
  await tick();
}

async function send(container: HTMLElement, text: string): Promise<void> {
  const composer = container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor')!;
  await fireEvent.input(composer, { target: { value: text } });
  await fireEvent.keyDown(composer, { key: 'Enter' });
  await tick();
}

/** Lets a settled promise's continuation, and the render it triggers, run. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await tick();
  await Promise.resolve();
  await tick();
}

describe('Chat sending quoted excerpts', () => {
  test('puts each quote, with every line prefixed, ahead of the typed text', async () => {
    const sent: string[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async (message) => {
        sent.push(message.content as string);
      },
    };
    const { container } = render(Chat, {
      id: 'chat-send-compose',
      adapter,
      conversation: conversationOf('compose', ['Line one\nLine two', 'Standalone line']),
    });
    await quote(container, 0);
    await quote(container, 1);

    await send(container, 'My reply');

    expect(sent).toEqual(['> Line one\n> Line two\n\n> Standalone line\n\nMy reply']);
  });

  test('cuts a quote longer than 4,000 characters to 3,999 plus an ellipsis', async () => {
    const sent: string[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async (message) => {
        sent.push(message.content as string);
      },
    };
    const { container } = render(Chat, {
      id: 'chat-send-long',
      adapter,
      conversation: conversationOf('long', ['x'.repeat(5000)]),
    });
    await quote(container, 0);

    await send(container, 'Too long');

    const expectedQuote = `${'x'.repeat(3999)}…`;
    expect(expectedQuote).toHaveLength(4000);
    expect(sent).toEqual([`> ${expectedQuote}\n\nToo long`]);
  });

  test('keeps a quote of exactly 4,000 characters whole', async () => {
    const sent: string[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async (message) => {
        sent.push(message.content as string);
      },
    };
    const { container } = render(Chat, {
      id: 'chat-send-exact',
      adapter,
      conversation: conversationOf('exact', ['y'.repeat(4000)]),
    });
    await quote(container, 0);

    await send(container, 'Exact');

    expect(sent).toEqual([`> ${'y'.repeat(4000)}\n\nExact`]);
  });

  test('sends a reply without quotes exactly as typed', async () => {
    const sent: string[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async (message) => {
        sent.push(message.content as string);
      },
    };
    const { container } = render(Chat, {
      id: 'chat-send-plain',
      adapter,
      conversation: conversationOf('plain', ['Unquoted.']),
    });

    await send(container, 'Just text');

    expect(sent).toEqual(['Just text']);
  });

  test('clears the chips once the adapter accepts the message', async () => {
    const adapter: ChatAdapter = { sendMessage: async () => undefined };
    const { container } = render(Chat, {
      id: 'chat-send-clear',
      adapter,
      conversation: conversationOf('clear', ['Clear me.']),
    });
    await quote(container, 0);
    expect(quoteChips(container)).toHaveLength(1);

    await send(container, 'Go');
    await settle();

    expect(quoteChips(container)).toHaveLength(0);
    expect(container.querySelector('[aria-label="Quoted excerpts"]')).toBeNull();
  });

  test('keeps the chips when the adapter rejects the message', async () => {
    const errors: unknown[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async () => {
        throw new Error('offline');
      },
    };
    const { container } = render(Chat, {
      id: 'chat-send-fail',
      adapter,
      onAdapterError: (event) => errors.push(event.error),
      conversation: conversationOf('fail', ['Keep me.']),
    });
    await quote(container, 0);

    await send(container, 'Go');
    await settle();

    expect(errors).toHaveLength(1);
    expect(quoteChips(container)).toHaveLength(1);
    expect(quoteChips(container)[0]!.textContent).toContain('Keep me.');
  });

  test('keeps the chips when the adapter throws synchronously', async () => {
    const adapter: ChatAdapter = {
      sendMessage: () => {
        throw new Error('sync failure');
      },
    };
    const { container } = render(Chat, {
      id: 'chat-send-throw',
      adapter,
      onAdapterError: () => undefined,
      conversation: conversationOf('throw', ['Keep me too.']),
    });
    await quote(container, 0);

    await send(container, 'Go');
    await settle();

    expect(quoteChips(container)).toHaveLength(1);
  });

  test('clears only the quotes a successful send carried', async () => {
    let finish: () => void = () => {};
    const adapter: ChatAdapter = {
      sendMessage: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    };
    const { container } = render(Chat, {
      id: 'chat-send-inflight',
      adapter,
      conversation: conversationOf('inflight', ['Sent quote.', 'Later quote.']),
    });
    await quote(container, 0);
    await send(container, 'Go');

    await quote(container, 1);
    finish();
    await settle();

    const chips = quoteChips(container);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('Later quote.');
  });

  test('goes through sendRunInput while a run is active, then clears the chips', async () => {
    const runInput: Array<{ conversationId: string; content: unknown }> = [];
    const sent: unknown[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async (message) => {
        sent.push(message);
      },
      sendRunInput: async (conversationId, message) => {
        runInput.push({ conversationId, content: message.content });
      },
    };
    const { container } = render(Chat, {
      id: 'chat-send-run',
      adapter,
      streaming: true,
      conversation: conversationOf('run', ['Mid-run reply.']),
    });
    await quote(container, 0);

    await send(container, 'Actually, wait');
    await settle();

    expect(sent).toEqual([]);
    expect(runInput).toEqual([
      { conversationId: 'run', content: '> Mid-run reply.\n\nActually, wait' },
    ]);
    expect(quoteChips(container)).toHaveLength(0);
  });

  test('keeps the chips when sendRunInput rejects', async () => {
    const adapter: ChatAdapter = {
      sendMessage: async () => undefined,
      sendRunInput: async () => {
        throw new Error('run input refused');
      },
    };
    const { container } = render(Chat, {
      id: 'chat-send-run-fail',
      adapter,
      streaming: true,
      onAdapterError: () => undefined,
      conversation: conversationOf('run-fail', ['Mid-run reply.']),
    });
    await quote(container, 0);

    await send(container, 'Actually, wait');
    await settle();

    expect(quoteChips(container)).toHaveLength(1);
  });

  test('passes the composed content to onSubmit when there is no adapter', async () => {
    const submitted: unknown[] = [];
    const { container } = render(Chat, {
      id: 'chat-send-callback',
      onSubmit: ({ message }) => {
        submitted.push(message.content);
      },
      conversation: conversationOf('callback', ['Callback quote.']),
    });
    await quote(container, 0);

    await send(container, 'Reply');
    await settle();

    expect(submitted).toEqual(['> Callback quote.\n\nReply']);
    expect(quoteChips(container)).toHaveLength(0);
  });
});
