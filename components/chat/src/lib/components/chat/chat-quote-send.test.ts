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
 *   7. The quotes leave the chip row at hand-off, so a follow-up sent while the
 *      run they started is still going does not repeat them.
 *   8. A failed send puts its quotes back ahead of any added since, without
 *      duplicates, within the cap of 10, and says when some were dropped.
 *   9. Quotes with an attachment and no typed text send no trailing separator.
 *  10. A send that fails after the host turned quoting off brings no chips back.
 *  11. A synchronous throw from `onSubmit` puts the carried quotes back.
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

function liveText(container: HTMLElement): string {
  return Array.from(container.querySelectorAll('[aria-live="polite"]'))
    .map((region) => region.textContent ?? '')
    .join(' ');
}

function chipTexts(container: HTMLElement): string[] {
  return quoteChips(container).map(
    (chip) => chip.querySelector('.chat-quote-chip-text')?.textContent ?? '',
  );
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

  test('does not repeat the quotes in a follow-up sent while the run they started is going', async () => {
    // Like the session controller: sendMessage settles when the run ends, and
    // sendRunInput settles on acknowledgement.
    let endRun: () => void = () => {};
    const sent: string[] = [];
    const runInput: string[] = [];
    const adapter: ChatAdapter = {
      sendMessage: (message) => {
        sent.push(message.content as string);
        return new Promise<void>((resolve) => {
          endRun = resolve;
        });
      },
      sendRunInput: async (_conversationId, message) => {
        runInput.push(message.content as string);
      },
      ordersRunInput: true,
    };
    const conversation = conversationOf('follow-up', ['Quoted reply text.']);
    const { container, rerender } = render(Chat, {
      id: 'chat-send-follow-up',
      adapter,
      conversation,
      streaming: false,
    });
    await quote(container, 0);
    await send(container, 'Why?');
    // The host marks the run as streaming once it starts.
    await rerender({ id: 'chat-send-follow-up', adapter, conversation, streaming: true });
    await settle();
    expect(quoteChips(container)).toHaveLength(0);

    await send(container, 'Shorter, please.');
    await settle();
    endRun();
    await settle();

    expect(sent).toEqual(['> Quoted reply text.\n\nWhy?']);
    expect(runInput).toEqual(['Shorter, please.']);
    expect(quoteChips(container)).toHaveLength(0);
  });

  test('takes the quotes out of the chip row while the send is in flight', async () => {
    const adapter: ChatAdapter = { sendMessage: () => new Promise<void>(() => {}) };
    const { container } = render(Chat, {
      id: 'chat-send-pending',
      adapter,
      conversation: conversationOf('pending', ['Pending quote.']),
    });
    await quote(container, 0);

    await send(container, 'Go');
    await settle();

    expect(quoteChips(container)).toHaveLength(0);
  });

  test('puts the quotes of a failed send back ahead of chips added meanwhile', async () => {
    let fail: (error: Error) => void = () => {};
    const adapter: ChatAdapter = {
      sendMessage: () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    };
    const { container } = render(Chat, {
      id: 'chat-send-restore',
      adapter,
      onAdapterError: () => undefined,
      conversation: conversationOf('restore', [
        'First quote.',
        'Second quote.',
        'Added meanwhile.',
      ]),
    });
    await quote(container, 0);
    await quote(container, 1);
    await send(container, 'Go');
    await quote(container, 2);
    expect(chipTexts(container)).toEqual(['Added meanwhile.']);

    fail(new Error('offline'));
    await settle();

    expect(chipTexts(container)).toEqual(['First quote.', 'Second quote.', 'Added meanwhile.']);
  });

  test('restores a failed send without duplicating a chip added again meanwhile', async () => {
    let fail: (error: Error) => void = () => {};
    const adapter: ChatAdapter = {
      sendMessage: () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    };
    const { container } = render(Chat, {
      id: 'chat-send-restore-duplicate',
      adapter,
      onAdapterError: () => undefined,
      conversation: conversationOf('restore-duplicate', ['Same quote.', 'Other quote.']),
    });
    await quote(container, 0);
    await send(container, 'Go');
    await quote(container, 1);
    await quote(container, 0);
    expect(chipTexts(container)).toEqual(['Other quote.', 'Same quote.']);

    fail(new Error('offline'));
    await settle();

    expect(chipTexts(container)).toEqual(['Same quote.', 'Other quote.']);
  });

  test('keeps the first ten and says so when a failed send cannot fit all its quotes back', async () => {
    let fail: (error: Error) => void = () => {};
    const adapter: ChatAdapter = {
      sendMessage: () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    };
    const replies = Array.from({ length: 13 }, (_, index) => `Quote number ${index + 1}.`);
    const { container } = render(Chat, {
      id: 'chat-send-restore-cap',
      adapter,
      onAdapterError: () => undefined,
      conversation: conversationOf('restore-cap', replies),
    });
    for (let index = 0; index < 3; index += 1) await quote(container, index);
    await send(container, 'Go');
    for (let index = 3; index < 13; index += 1) await quote(container, index);
    expect(quoteChips(container)).toHaveLength(10);

    fail(new Error('offline'));
    await settle();

    expect(chipTexts(container)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((number) => `Quote number ${number}.`),
    );
    expect(liveText(container)).toContain('3 quotes could not be restored');
  });

  test('does not restore a failed send into a different conversation', async () => {
    let fail: (error: Error) => void = () => {};
    const adapter: ChatAdapter = {
      sendMessage: () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    };
    const first = conversationOf('restore-first', ['Old conversation quote.']);
    const second = conversationOf('restore-second', ['New conversation text.']);
    const { container, rerender } = render(Chat, {
      id: 'chat-send-restore-switch',
      adapter,
      onAdapterError: () => undefined,
      conversation: first,
    });
    await quote(container, 0);
    await send(container, 'Go');
    await rerender({
      id: 'chat-send-restore-switch',
      adapter,
      onAdapterError: () => undefined,
      conversation: second,
    });

    fail(new Error('offline'));
    await settle();

    expect(quoteChips(container)).toHaveLength(0);
  });

  test('sends quotes and an attachment with no trailing separator when nothing is typed', async () => {
    const sent: string[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async (message) => {
        sent.push(message.content as string);
      },
    };
    const { container } = render(Chat, {
      id: 'chat-send-attachment-only',
      adapter,
      conversation: conversationOf('attachment-only', ['Quoted with a file.']),
    });
    await quote(container, 0);
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array([1])], 'photo.png', {
      type: 'image/png',
      lastModified: 1,
    });
    await fireEvent.change(picker, { target: { files: [file] } });
    await settle();

    const composer = container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor')!;
    await fireEvent.keyDown(composer, { key: 'Enter' });
    await settle();

    expect(sent).toEqual(['> Quoted with a file.']);
  });

  test('brings no chips back when a send fails after the host turned quoting off', async () => {
    let fail: (error: Error) => void = () => {};
    const sent: string[] = [];
    const adapter: ChatAdapter = {
      sendMessage: (message) => {
        sent.push(message.content as string);
        return new Promise<void>((_resolve, reject) => {
          fail = reject;
        });
      },
    };
    const conversation = conversationOf('restore-quote-off', ['Carried quote.']);
    const props = { id: 'chat-send-restore-quote-off', adapter, onAdapterError: () => undefined };
    const { container, rerender } = render(Chat, { ...props, conversation });
    await quote(container, 0);
    await send(container, 'Go');
    await rerender({ ...props, conversation, capabilities: { quote: false } });
    await settle();

    fail(new Error('offline'));
    await settle();
    expect(quoteChips(container)).toHaveLength(0);

    await send(container, 'Again');
    await settle();
    expect(sent).toEqual(['> Carried quote.\n\nGo', 'Again']);
  });

  test('puts the quotes back when onSubmit throws synchronously', async () => {
    // The throw escapes the form's submit handler; happy-dom reports it as a
    // window `error` event, which the listener keeps from failing the run.
    const preventReport = (event: Event): void => {
      event.preventDefault();
    };
    window.addEventListener('error', preventReport);
    try {
      const { container } = render(Chat, {
        id: 'chat-send-on-submit-throws',
        conversation: conversationOf('on-submit-throws', ['Thrown quote.']),
        onSubmit: () => {
          throw new Error('host refused');
        },
      });
      await quote(container, 0);
      await send(container, 'Go');
      await settle();

      expect(chipTexts(container)).toEqual(['Thrown quote.']);
    } finally {
      window.removeEventListener('error', preventReport);
    }
  });
});
