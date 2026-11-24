/**
 * COR-2283: a turn's run outcome and its recovery controls sit on the turn itself, in the
 * transcript presentation (rows R2 to R6 of the run-states board): the streaming caret, the
 * reconnecting warning with Retry now and its draining bar, the stopped pill with Discard and
 * Continue, the incomplete alert with Retry, and the dashed empty row with Try again.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

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

  test('the connection notice does not sit under the partial reply; it stands by the composer', () => {
    const { container, queryByRole } = mount({ turnState: reconnecting });
    // Chat draws the notice beside the composer (chat-connection-notice.test.ts), so the turn
    // itself carries no outcome row, no warning and no Retry.
    expect(outcome(container)).toBeNull();
    expect(container.querySelector('[data-cinder-variant="warning"]')).toBeNull();
    expect(container.textContent).not.toContain('Connection lost');
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
    const stopped = row?.querySelector('.chat-turn-stopped-row');
    expect(stopped?.textContent).toContain('Stopped by you, partial answer');
    expect(stopped?.querySelector('[data-cinder-variant="neutral"]')).not.toBeNull();
    expect(row?.querySelector('.chat-turn-stopped-card')).toBeNull();

    const buttons = Array.from(row?.querySelectorAll('button') ?? [], (button) =>
      button.textContent?.trim(),
    );
    // Discard first and the primary, Continue, last: it is the trailing-most control.
    expect(buttons).toEqual(['Discard', 'Continue']);
    expect(
      getByRole('button', { name: 'Continue' }).getAttribute('aria-describedby'),
    ).not.toBeNull();
    expect(
      getByRole('button', { name: 'Discard' }).getAttribute('aria-describedby'),
    ).not.toBeNull();
    expect(
      getByRole('button', { name: 'Continue' }).classList.contains('button-variant-primary'),
    ).toBe(true);
    expect(
      getByRole('button', { name: 'Discard' }).classList.contains('button-variant-secondary'),
    ).toBe(true);
    expect(stopped?.querySelector('.chat-turn-actions')).not.toBeNull();

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
    expect(
      getByRole('button', { name: 'Retry' }).classList.contains('button-variant-secondary'),
    ).toBe(true);
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

  test('keeps an optional failure explanation link in the Callout when Retry is unavailable', () => {
    const { getByRole, queryByRole } = mount({
      turnState: {
        kind: 'failed',
        cause: 'The provider dropped the connection.',
        explanationLink: { href: '/runs/run-7#failure-explanation', label: 'Why it failed' },
      },
    });

    const link = getByRole('link', { name: 'Why it failed' });
    expect(link.getAttribute('href')).toBe('/runs/run-7#failure-explanation');
    expect(link.hasAttribute('data-chat-note-link')).toBe(true);
    expect(link.closest('.cinder-callout')).not.toBeNull();
    expect(queryByRole('button', { name: 'Retry' })).toBeNull();
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
    // The turn's time sits inside the notice, muted, and no separate line carries it.
    expect(
      row?.querySelector('.chat-turn-text ~ time.chat-turn-time')?.getAttribute('datetime'),
    ).toBe(SENT_AT);
    expect(container.querySelector('.chat-message-line time')).toBeNull();
    expect(container.querySelectorAll('time')).toHaveLength(1);

    await fireEvent.click(getByRole('button', { name: 'Try again' }));
    expect(retryTurn).toHaveBeenCalledWith('a1');
  });

  test('the default presentation also puts the empty turn’s time in its notice, not a metadata row', () => {
    const { container } = render(ChatMessage, {
      props: { message: reply({ content: '' }), turnState: { kind: 'empty' } },
    } as never);
    expect(container.querySelector('.chat-message-metadata')).toBeNull();
    expect(container.querySelector('.chat-turn-empty time.chat-turn-time')).not.toBeNull();
    expect(container.querySelectorAll('time')).toHaveLength(1);
  });

  test('the empty outcome is a dashed transcript row, not a callout', () => {
    const { container } = mount({ turnState: { kind: 'empty' } });
    const row = container.querySelector('.chat-turn-empty-row');
    expect(row).not.toBeNull();
    expect(row?.classList.contains('cinder-callout')).toBe(false);
    expect(container.querySelector('.chat-turn-empty-card')).toBeNull();
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

describe('a turn that said only what it was doing', () => {
  const narration = {
    narration: true,
    message: reply({ content: 'Reading the refund policy first.' }),
  };

  test('a stopped one does not claim an answer', () => {
    const { container } = mount({ ...narration, turnState: { kind: 'stopped' } });
    expect(outcome(container)?.textContent).toContain('Stopped before an answer.');
    expect(outcome(container)?.textContent).not.toContain('answer above');
  });

  test('a stopped one with an answer keeps the partial-answer words', () => {
    const { container } = mount({ turnState: { kind: 'stopped' } });
    expect(outcome(container)?.textContent).toContain('Stopped by you, partial answer');
  });

  test('a failed one says it failed before an answer, and a host can say both its own way', () => {
    const { container } = mount({
      ...narration,
      turnState: { kind: 'failed', cause: 'The provider dropped the connection.' },
    });
    expect(outcome(container)?.textContent).toContain('Failed before an answer.');
    expect(outcome(container)?.textContent).not.toContain('This answer is incomplete.');

    cleanup();
    const hosted = mount({
      ...narration,
      turnState: { kind: 'stopped' },
      turnLabels: { stoppedBeforeAnswer: 'Arrete avant une reponse.' },
    });
    expect(outcome(hosted.container)?.textContent).toContain('Arrete avant une reponse.');
  });

  test('the body part draws the text alone and the outcome part the notice and the line alone', () => {
    const props = { ...narration, turnState: { kind: 'stopped' } };
    const body = mount({ ...props, section: 'body' });
    expect(body.container.querySelector('article')).not.toBeNull();
    expect(outcome(body.container)).toBeNull();
    expect(body.container.querySelector('.chat-message-line')).toBeNull();

    cleanup();
    const tail = mount({ ...props, section: 'outcome' });
    expect(tail.container.querySelector('article')).toBeNull();
    expect(outcome(tail.container)?.getAttribute('data-kind')).toBe('stopped');
    expect(tail.container.querySelector('.chat-message-line')).not.toBeNull();
  });
});

describe('the stopped-short ellipsis', () => {
  const wrapperOf = (content: string) => {
    cleanup();
    const { container } = mount({
      message: reply({ content }),
      turnState: { kind: 'stopped' },
    });
    return container.querySelector('.chat-message-wrapper');
  };

  test('is skipped when the text already ends where a sentence ends', () => {
    for (const content of [
      'Reading the refund policy first.',
      'Is it done?',
      'Done!',
      'Wait…',
      'He said "stop."',
      'It is **done.**',
    ]) {
      expect(wrapperOf(content)?.hasAttribute('data-ends-in-punctuation')).toBe(true);
    }
  });

  test('is kept when the text stops mid-sentence', () => {
    for (const content of ['Order 4398 shipped with Parcelly on', 'The ledger has 3.5', 'First,']) {
      expect(wrapperOf(content)?.hasAttribute('data-ends-in-punctuation')).toBe(false);
    }
  });

  test('is drawn by a rule that the punctuation mark switches off', async () => {
    const source = await Bun.file(new URL('./chat-message.svelte', import.meta.url)).text();
    const rule = /content: '\\2026' \/ '';/u.exec(source);
    expect(rule).not.toBeNull();
    // Both selectors of the rule (a text block, and the last list item) carry the switch.
    expect(source.split(':not([data-ends-in-punctuation])')).toHaveLength(3);
  });
});
