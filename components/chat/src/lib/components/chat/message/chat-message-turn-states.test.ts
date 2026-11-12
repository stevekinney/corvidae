/**
 * COR-2283: a turn's run outcome and its recovery controls sit on the turn itself, in the
 * transcript presentation (rows R2 to R6 of the run-states board): the streaming caret, the
 * reconnecting warning with Retry now and its draining bar, the stopped pill with Discard and
 * Continue, the incomplete alert with Retry, and the dashed empty row with Try again.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import type { ChatTurnState } from './turn-state.ts';

setupHappyDom();

const { fireEvent, render, cleanup } = await import('@testing-library/svelte');
const { default: ChatMessage } = await import('./chat-message.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const SENT_AT = '2026-11-02T16:45:00.000Z';

function reply(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    role: 'assistant',
    content: 'Order 4398 shipped with Parcelly on',
    createdAt: SENT_AT,
    metadata: {},
    hidden: false,
    ...overrides,
  };
}

function mount(props: Record<string, unknown>) {
  return render(ChatMessage, {
    props: { presentation: 'transcript', message: reply(), ...props },
  } as never);
}

function outcome(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('.chat-turn-outcome');
}

describe('R2: streaming', () => {
  test('a streaming turn draws no outcome and no line, and ends in a caret', () => {
    const { container } = mount({ streaming: true });
    expect(outcome(container)).toBeNull();
    expect(container.querySelector('.chat-message-line')).toBeNull();
    expect(container.querySelector('.message-content-streaming')).not.toBeNull();
  });

  test('the caret is a 2 px bar in the accent colour', async () => {
    const source = await Bun.file(new URL('./chat-message.svelte', import.meta.url)).text();
    const caret = /\.message-content-tail::after\)\s*\{([^}]*)\}/u.exec(source)?.[1] ?? '';
    expect(caret).toMatch(/inline-size:\s*2px;/u);
    expect(caret).toMatch(/background:\s*var\(--cinder-accent-solid\);/u);
  });
});

describe('R3: reconnecting', () => {
  const reconnecting: ChatTurnState = {
    kind: 'reconnecting',
    attempt: 2,
    attempts: 5,
    nextTryIn: 8,
    wait: 10,
  };

  test('the partial text is muted with no caret, and the turn has no line', () => {
    const { container } = mount({ streaming: true, turnState: reconnecting });
    const wrapper = container.querySelector('.chat-message-wrapper');
    expect(wrapper?.getAttribute('data-turn-state')).toBe('reconnecting');
    expect(container.querySelector('.message-content-streaming')).toBeNull();
    expect(container.querySelector('.chat-message-line')).toBeNull();
    expect(container.textContent).toContain('Order 4398 shipped with Parcelly on');
  });

  test('the warning on the turn reads the exact template, with Retry now and a draining bar', async () => {
    const retryConnection = mock((_messageId: string) => undefined);
    const { container, getByRole } = mount({
      turnState: reconnecting,
      onRetryConnection: retryConnection,
    });
    const warning = outcome(container);
    expect(warning?.getAttribute('data-kind')).toBe('reconnecting');
    // The warning belongs to the turn: it sits in the message's wrapper, not the composer.
    expect(warning?.closest('.chat-message-wrapper')).not.toBeNull();
    expect(warning?.querySelector('[role="note"]')?.getAttribute('data-cinder-variant')).toBe(
      'warning',
    );
    expect(warning?.querySelector('.cinder-callout--inline-action')).not.toBeNull();
    expect(warning?.querySelector('.cinder-callout__action button')?.textContent?.trim()).toBe(
      'Retry',
    );
    expect(warning?.querySelector('.chat-turn-text')?.textContent?.trim()).toBe(
      'Connection lost. Reconnecting, attempt 2 of 5. Next try in 8s.',
    );

    const bar = getByRole('progressbar', { name: 'Time until the next try' });
    expect(bar.getAttribute('aria-valuenow')).toBe('80');
    expect(bar.getAttribute('aria-valuetext')).toBe('8s');

    await fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(retryConnection).toHaveBeenCalledWith('a1');
  });

  test('the bar drains as the host counts the next try down', async () => {
    const view = mount({ turnState: reconnecting });
    await view.rerender({ turnState: { ...reconnecting, nextTryIn: 3 } });
    await tick();
    const bar = view.getByRole('progressbar', { name: 'Time until the next try' });
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    expect(view.container.querySelector('.chat-turn-text')?.textContent).toContain(
      'Next try in 3s.',
    );
  });

  test('without the callback there is no Retry now', () => {
    const { queryByRole } = mount({ turnState: reconnecting });
    expect(queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('R4: stopped', () => {
  test('a contained neutral notice keeps Discard and Continue beside the stopped status', async () => {
    const continueTurn = mock((_messageId: string) => undefined);
    const discardTurn = mock((_messageId: string) => undefined);
    const { container, getByRole } = mount({
      turnState: { kind: 'stopped' },
      onContinueTurn: continueTurn,
      onDiscardTurn: discardTurn,
    });
    const row = outcome(container);
    expect(row?.getAttribute('data-kind')).toBe('stopped');
    const card = row?.querySelector('.chat-turn-stopped-card');
    expect(card?.getAttribute('role')).toBe('note');
    expect(card?.textContent).toContain('Stopped. The answer above is partial.');

    const buttons = Array.from(row?.querySelectorAll('button') ?? [], (button) =>
      button.textContent?.trim(),
    );
    expect(buttons).toEqual(['Continue', 'Discard']);
    expect(
      getByRole('button', { name: 'Continue' }).getAttribute('aria-describedby'),
    ).not.toBeNull();
    expect(
      getByRole('button', { name: 'Discard' }).getAttribute('aria-describedby'),
    ).not.toBeNull();
    expect(getByRole('button', { name: 'Continue' }).getAttribute('data-cinder-variant')).toBe(
      'primary',
    );
    expect(getByRole('button', { name: 'Discard' }).getAttribute('data-cinder-variant')).toBe(
      'secondary',
    );
    expect(card?.querySelector('.cinder-callout__action')).not.toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Continue' }));
    await fireEvent.click(getByRole('button', { name: 'Discard' }));
    expect(continueTurn).toHaveBeenCalledWith('a1');
    expect(discardTurn).toHaveBeenCalledWith('a1');
    expect(container.querySelector('.chat-message-line')).not.toBeNull();
  });

  test('the turn draws its own stop, so a stop note the run left is not drawn twice', () => {
    const { container } = mount({
      turnState: { kind: 'stopped' },
      notes: [{ kind: 'stopped', id: 'stop', reason: 'You stopped the run.' }],
    });
    expect(container.querySelector('.chat-note[data-kind="stopped"]')).toBeNull();
    expect(container.textContent).not.toContain('You stopped the run.');
  });

  test('a stopped turn shows Regenerate disabled, so every settled turn has the same actions', () => {
    const { getByRole } = mount({
      turnState: { kind: 'stopped' },
      onRegenerate: () => undefined,
    });
    expect((getByRole('button', { name: /Regenerate/u }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('an outcome that carries its own recovery hides Quote and Regenerate, and keeps Copy', () => {
    const turns: Array<Record<string, unknown>> = [
      { turnState: { kind: 'stopped' }, onContinueTurn: () => undefined },
      { turnState: { kind: 'empty' }, onRetryTurn: () => undefined },
      {
        turnState: { kind: 'failed', cause: 'The connection dropped.' },
        onRetryTurn: () => undefined,
      },
    ];
    for (const props of turns) {
      cleanup();
      const { queryByRole } = mount({
        ...props,
        onRegenerate: () => undefined,
        onQuote: () => undefined,
      });
      expect(queryByRole('button', { name: /Regenerate/u })).toBeNull();
      expect(queryByRole('button', { name: /Quote/u })).toBeNull();
      expect(queryByRole('button', { name: /Copy/u })).not.toBeNull();
    }
  });
});

describe('R5: failed partway', () => {
  test('a danger alert says the answer is incomplete, why, what Retry keeps, with Retry', async () => {
    const retryTurn = mock((_messageId: string) => undefined);
    const { container, getByRole } = mount({
      turnState: {
        kind: 'failed',
        cause: 'The model provider dropped the connection.',
        keeps: 'Retry keeps the text above and the 2 steps that finished.',
      },
      onRetryTurn: retryTurn,
    });
    const block = outcome(container);
    expect(block?.getAttribute('data-kind')).toBe('failed');
    const alert = block?.querySelector('.cinder-callout');
    expect(alert?.getAttribute('data-cinder-variant')).toBe('danger');
    expect(getByRole('button', { name: 'Retry' }).getAttribute('data-cinder-variant')).toBe(
      'secondary',
    );
    expect(alert?.textContent).toContain('This answer is incomplete.');
    expect(
      block?.querySelector('.chat-turn-failure-body')?.textContent?.replace(/\s+/gu, ' ').trim(),
    ).toBe(
      'The model provider dropped the connection. Retry keeps the text above and the 2 steps that finished.',
    );
    await fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(retryTurn).toHaveBeenCalledWith('a1');
    // The partial answer stays readable above the alert.
    expect(container.querySelector('.chat-message-body')?.textContent).toContain('Order 4398');
  });

  test('without a host sentence, the alert says what Retry keeps in Chat’s words', () => {
    const { container } = mount({ turnState: { kind: 'failed', cause: 'Timed out.' } });
    expect(
      container.querySelector('.chat-turn-failure-body')?.textContent?.replace(/\s+/gu, ' ').trim(),
    ).toBe('Timed out. Retry keeps what was written so far.');
  });

  test('a failed stop note is not drawn beside the alert', () => {
    const { container } = mount({
      turnState: { kind: 'failed', cause: 'Timed out.' },
      notes: [{ kind: 'stopped', id: 'stop', failed: true, reason: 'The run failed.' }],
    });
    expect(container.querySelector('.chat-note[data-kind="stopped"]')).toBeNull();
  });
});

describe('R6: empty answer', () => {
  test('a dashed neutral row says so with the turn’s time and Try again, and no line stands under it', async () => {
    const retryTurn = mock((_messageId: string) => undefined);
    const { container, getByRole } = mount({
      message: reply({ content: '' }),
      turnState: { kind: 'empty' },
      onRetryTurn: retryTurn,
    });
    const row = outcome(container);
    expect(row?.getAttribute('data-kind')).toBe('empty');
    expect(row?.querySelector('.chat-turn-text')?.textContent).toBe(
      'The agent finished without writing an answer.',
    );
    // The turn's time is on its own line, not inside the notice.
    expect(row?.querySelector('time')).toBeNull();
    expect(container.querySelector('.chat-message-line time')?.getAttribute('datetime')).toBe(
      SENT_AT,
    );
    expect(container.querySelectorAll('time')).toHaveLength(1);

    await fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(retryTurn).toHaveBeenCalledWith('a1');
  });

  test('the default presentation keeps the empty turn’s time on its metadata row', () => {
    const { container } = render(ChatMessage, {
      props: { message: reply({ content: '' }), turnState: { kind: 'empty' } },
    } as never);
    expect(container.querySelector('.chat-message-metadata time')).not.toBeNull();
    expect(container.querySelectorAll('time')).toHaveLength(1);
  });

  test('the empty outcome is one compact neutral card without a dashed placeholder edge', () => {
    const { container } = mount({ turnState: { kind: 'empty' } });
    const card = container.querySelector('.chat-turn-empty-card');
    expect(card?.classList.contains('cinder-callout')).toBe(true);
    expect(card?.getAttribute('data-cinder-variant')).toBe('neutral');
    expect(card?.querySelector('.cinder-callout__icon')).not.toBeNull();
  });
});

describe('a turn without a state', () => {
  test('a finished reply draws no outcome and keeps its line', () => {
    const { container } = mount({});
    expect(outcome(container)).toBeNull();
    expect(container.querySelector('.chat-message-line')).not.toBeNull();
    expect(container.querySelector('.chat-message-wrapper')?.hasAttribute('data-turn-state')).toBe(
      false,
    );
  });

  test('a person’s message ignores a turn state', () => {
    const { container } = mount({
      message: reply({ role: 'user' }),
      turnState: { kind: 'stopped' },
    });
    expect(outcome(container)).toBeNull();
  });

  test('a state a host gets wrong is ignored rather than drawn', () => {
    const { container } = mount({
      turnState: { kind: 'reconnecting', attempt: 9, attempts: 3, nextTryIn: 2 },
    });
    expect(outcome(container)).toBeNull();
  });
});

describe('approval receipt timestamp', () => {
  test('suppresses the transcript timestamp only for approval-only turns', async () => {
    const source = await Bun.file(new URL('./chat-message.svelte', import.meta.url)).text();
    expect(source).toContain("part.type === 'tool-approval'");
    expect(source).toMatch(/createdAtValue\s*&&\s*formattedCreatedAt\s*&&\s*!approvalOnlyTurn/u);
  });
});
