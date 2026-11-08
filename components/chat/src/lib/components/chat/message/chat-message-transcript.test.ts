/**
 * The transcript presentation of one message: plain replies, one muted line of time and actions, a
 * red icon and "Not sent" for a message that was not delivered, a dashed Queued bubble, and a run's
 * notes outside the bubble.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { fireEvent, render, cleanup } = await import('@testing-library/svelte');
const { default: ChatMessage } = await import('./chat-message.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const SENT_AT = '2026-11-02T16:45:00.000Z';

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    role: 'user',
    content: 'Also look up order 4398, the same carrier.',
    createdAt: SENT_AT,
    metadata: {},
    hidden: false,
    ...overrides,
  };
}

function mount(props: Record<string, unknown>) {
  return render(ChatMessage, {
    props: { presentation: 'transcript', message: message(), ...props },
  } as never);
}

describe('transcript presentation', () => {
  test('a sent message has one line with its time, Copy and, on a reply, Quote as words', () => {
    const { container, getByRole } = mount({
      message: message({ role: 'assistant', content: 'Order 4398 is $27.25.' }),
      onQuote: () => undefined,
    });
    const line = container.querySelector('.chat-message-line');
    expect(line?.getAttribute('data-state')).toBe('sent');
    expect(line?.querySelector('time')).not.toBeNull();
    expect(line?.textContent).toContain('Copy');
    expect(getByRole('button', { name: 'Quote message' }).textContent?.trim()).toBe('Quote');
    // A reply is not a card: the role label is read but not drawn.
    expect(
      container.querySelector('[data-presentation="transcript"][data-role="assistant"]'),
    ).not.toBeNull();
  });

  test('a message written today is stamped with its time of day, and one from another day with its date too', () => {
    setSystemTime(new Date('2026-11-02T17:00:00.000Z'));
    try {
      const today = mount({ message: message({ createdAt: SENT_AT }) });
      const todayText = today.container.querySelector('time')?.textContent ?? '';
      expect(todayText).toBe(
        new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
          new Date(SENT_AT),
        ),
      );
      cleanup();
      const earlier = '2026-10-29T16:04:00.000Z';
      const older = mount({ message: message({ createdAt: earlier }) });
      expect(older.container.querySelector('time')?.textContent).toBe(
        new Intl.DateTimeFormat(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(earlier)),
      );
      expect(older.container.querySelector('time')?.getAttribute('datetime')).toBe(earlier);
    } finally {
      setSystemTime();
    }
  });

  test("a person's own message offers Copy and no Quote", () => {
    const { container, queryByRole } = mount({ onQuote: () => undefined });
    expect(container.querySelector('.chat-message-line')?.textContent).toContain('Copy');
    expect(queryByRole('button', { name: 'Quote message' })).toBeNull();
  });

  test('the host actions sit in the line before Copy', () => {
    const { container } = mount({
      actions: createRawSnippet(() => ({ render: () => '<button type="button">Branch</button>' })),
    });
    const labels = Array.from(
      container.querySelectorAll('.chat-message-line-actions > *'),
      (node) => node.textContent?.trim(),
    );
    expect(labels.indexOf('Branch')).toBeGreaterThan(-1);
    expect(labels.indexOf('Branch')).toBeLessThan(labels.findIndex((text) => text === 'Copy'));
  });

  test('a message that was not sent keeps its bubble, shows a focusable red icon, its time and Not sent, and Copy', () => {
    const { container, getByRole, getByText } = mount({
      message: message({ metadata: { _deliveryStatus: 'failed' } }),
      onRetry: () => undefined,
    });
    const icon = getByRole('button', { name: 'Not sent: details' });
    expect(icon.tabIndex).toBeGreaterThanOrEqual(0);
    expect(getByText('Not sent')).not.toBeNull();
    expect(container.querySelector('.chat-message-line time')).not.toBeNull();
    expect(container.querySelector('.chat-message-line')?.textContent).toContain('Copy');
    expect(container.querySelector('.chat-message')?.textContent).toContain('order 4398');
    // The old inline label and icon-only retry are gone.
    expect(container.querySelector('.chat-message-failed-actions')).toBeNull();
  });

  test('the icon opens the popover with the host words and an enabled Retry', async () => {
    const retry = mock((_id: string) => undefined);
    const { getByRole, findByText } = mount({
      message: message({ metadata: { _deliveryStatus: 'failed' } }),
      onRetry: retry,
      notSent: {
        summary: 'Not sent. Interborough couldn’t deliver this message. Your message is kept.',
      },
    });
    await fireEvent.click(getByRole('button', { name: 'Not sent: details' }));
    expect(await findByText(/couldn’t deliver this message/)).not.toBeNull();
    const button = getByRole('button', { name: 'Retry', hidden: true }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await fireEvent.click(button);
    expect(retry).toHaveBeenCalledWith('m1');
  });

  test('while the server cannot be reached Retry is inert and says when it will retry', async () => {
    const retry = mock((_id: string) => undefined);
    const { getByRole, findByText } = mount({
      message: message({ metadata: { _deliveryStatus: 'failed' } }),
      onRetry: retry,
      notSentOpen: true,
      notSent: {
        summary: 'Not sent. Interborough can’t be reached. Your message is kept.',
        retryDisabled: true,
        retryNote: 'Retries when you’re back online.',
      },
    });
    expect(await findByText('Retries when you’re back online.')).not.toBeNull();
    const button = getByRole('button', { name: 'Retry', hidden: true }) as HTMLButtonElement;
    // Inert, but not natively disabled: it keeps focus and is described by the note beside it.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.focus();
    expect(document.activeElement).toBe(button);
    const note = await findByText('Retries when you’re back online.');
    expect(button.getAttribute('aria-describedby')).toBe(note.id);
    await fireEvent.click(button);
    expect(retry).not.toHaveBeenCalled();
  });

  test('a follow-up the run has not taken is a dashed Queued bubble with Remove only when the host can take it back', async () => {
    const remove = mock((_id: string) => undefined);
    const queued = message({ metadata: { _deliveryStatus: 'sending' } });
    const without = mount({ message: queued });
    expect(without.container.querySelector('.chat-message-queued-label')?.textContent).toContain(
      'Queued · sends when the run is ready',
    );
    expect(without.container.querySelector('[data-pending]')).not.toBeNull();
    expect(without.queryByRole('button', { name: 'Remove' })).toBeNull();
    // A queued message has no Copy yet: it has not been sent.
    expect(without.container.querySelector('.chat-message-copy')).toBeNull();
    cleanup();
    const withRemove = mount({ message: queued, onRemoveQueued: remove });
    await fireEvent.click(withRemove.getByRole('button', { name: 'Remove' }));
    expect(remove).toHaveBeenCalledWith('m1');
  });

  test('Remove on a queued follow-up is Cinder’s accent text action, the one thing on the bubble’s line the person can do', () => {
    const { getByRole } = mount({
      message: message({ metadata: { _deliveryStatus: 'sending' } }),
      onRemoveQueued: () => undefined,
    });

    expect(getByRole('button', { name: 'Remove' }).getAttribute('data-cinder-variant')).toBe(
      'ghost-accent',
    );
  });

  test('a reply that is still streaming has no line under it, and ends in a caret drawn after its last text', async () => {
    const { container } = mount({
      message: message({ role: 'assistant', content: 'Looking up order 4398…' }),
      streaming: true,
    });
    expect(container.querySelector('.chat-message-line')).toBeNull();
    expect(container.querySelector('time')).toBeNull();

    // The caret is a pseudo-element on the last block of text (or the raw tail), so it shares that
    // line instead of wrapping onto a line of its own.
    const source = await Bun.file(new URL('./chat-message.svelte', import.meta.url)).text();
    expect(source).toMatch(/\.message-content-preview\s+> :last-child::after/u);
    expect(source).toContain('.message-content-tail::after');
    expect(source).not.toMatch(/chat-message-streaming-progress\)::after/u);
  });

  test('a reply whose stream dropped has no line under it either, though nothing is streaming now', () => {
    const { container } = mount({
      message: message({
        role: 'assistant',
        content: 'Order 4471 is $42.00.',
        metadata: { __streaming: true },
      }),
      streaming: false,
    });

    expect(container.querySelector('.chat-message-line')).toBeNull();
    // Its text is at full contrast with no caret: only a reply streaming now is shimmering.
    expect(container.querySelector('.message-content-streaming')).toBeNull();
  });

  test('a run’s notes are outside the bubble, and a failed run’s stop note takes the host action', () => {
    const { container, getByRole } = mount({
      message: message({ role: 'assistant', content: 'Order 4398 is' }),
      notes: [
        {
          kind: 'stopped',
          id: 'stopped',
          failed: true,
          reason: 'The reply stopped partway: the model provider dropped the connection.',
        },
      ],
      noteAction: createRawSnippet(() => ({
        render: () => '<button type="button">Retry</button>',
      })),
    });
    const note = container.querySelector('.chat-note[data-kind="stopped"]');
    expect(note).not.toBeNull();
    expect(note?.hasAttribute('data-failed')).toBe(true);
    expect(note?.closest('.chat-message')).toBeNull();
    expect(note?.closest('.chat-message-notes')).not.toBeNull();
    expect(note?.textContent).toContain('The reply stopped partway');
    expect(getByRole('button', { name: 'Retry' })).not.toBeNull();
  });

  test('the agent’s instructions are muted text folded to one line until shown', async () => {
    const { container, getByRole } = mount({
      message: message({ role: 'system', content: 'You are a refund helper. Be brief.' }),
    });
    const toggle = getByRole('button', { name: 'Instructions · Show' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const body = container.querySelector('.chat-message-body');
    expect(body?.hasAttribute('hidden')).toBe(true);
    // No time, Copy or other line: the instructions are not a message anyone sent.
    expect(container.querySelector('.chat-message-line')).toBeNull();
    await fireEvent.click(toggle);
    expect(getByRole('button', { name: 'Instructions · Hide' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(body?.hasAttribute('hidden')).toBe(false);
    expect(body?.textContent).toContain('You are a refund helper');
  });

  test('the default presentation is unchanged: no line, and notes stay in the bubble', () => {
    const { container } = render(ChatMessage, {
      props: { message: message({ role: 'assistant' }) },
    } as never);
    expect(container.querySelector('.chat-message-line')).toBeNull();
  });
});
