/**
 * The one-row approval decision a run's page draws: its question, its choices and the input a call
 * was given. The chat page draws Cinder's approval row instead, so this row is covered on its own.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { CHAT_COPY, REVIEWS_COPY } from '../../app/copy.ts';
import ApprovalDecision from './approval-decision.svelte';

afterEach(cleanup);

const baseProps = {
  id: 'decision-1',
  question: 'Refund order 4471 for $42.00?',
  identifiers: ['issue_refund'],
  deciding: false,
} as const;

describe('ApprovalDecision', () => {
  test('is a group named by its question that script can focus and Tab skips', () => {
    const { container } = render(ApprovalDecision, {
      props: { ...baseProps, onDecide: () => undefined },
    } as never);
    const row = container.querySelector<HTMLElement>('[data-approval-decision]');

    expect(row?.getAttribute('role')).toBe('group');
    expect(row?.getAttribute('tabindex')).toBe('-1');
    expect(
      container.querySelector(`#${row?.getAttribute('aria-labelledby')}`)?.textContent,
    ).toContain('Refund order 4471');
  });

  test('sends the person’s choice, and holds both buttons while one is being sent', async () => {
    const onDecide = mock((_decision: 'approve' | 'deny') => undefined);
    const { getByRole, rerender } = render(ApprovalDecision, {
      props: { ...baseProps, onDecide },
    } as never);

    await fireEvent.click(getByRole('button', { name: CHAT_COPY.deny }));
    await fireEvent.click(getByRole('button', { name: CHAT_COPY.approve }));
    expect(onDecide.mock.calls.map(([decision]) => decision)).toEqual(['deny', 'approve']);

    await rerender({ ...baseProps, deciding: true, onDecide } as never);
    expect(getByRole('button', { name: CHAT_COPY.deny }).hasAttribute('disabled')).toBe(true);
    expect(getByRole('button', { name: CHAT_COPY.approve }).hasAttribute('disabled')).toBe(true);
  });

  test('draws Allow for the rest of this chat only when the host can grant it', async () => {
    const onAllowForChat = mock(() => undefined);
    const without = render(ApprovalDecision, {
      props: { ...baseProps, onDecide: () => undefined },
    } as never);
    expect(without.queryByRole('button', { name: REVIEWS_COPY.allowForChat })).toBeNull();
    cleanup();

    const { getByRole } = render(ApprovalDecision, {
      props: { ...baseProps, onDecide: () => undefined, onAllowForChat },
    } as never);
    await fireEvent.click(getByRole('button', { name: REVIEWS_COPY.allowForChat }));
    expect(onAllowForChat).toHaveBeenCalledTimes(1);
  });

  test('shows what the call was given only when asked, and not at all with no input', async () => {
    const none = render(ApprovalDecision, {
      props: { ...baseProps, onDecide: () => undefined },
    } as never);
    expect(none.queryByRole('button', { name: CHAT_COPY.showInput })).toBeNull();
    cleanup();

    const { container, getByRole } = render(ApprovalDecision, {
      props: {
        ...baseProps,
        onDecide: () => undefined,
        input: [
          ['orderId', '4471'],
          ['amount', '42.00'],
        ],
      },
    } as never);
    expect(container.querySelector('dl')).toBeNull();

    const toggle = getByRole('button', { name: CHAT_COPY.showInput });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle);

    const terms = [...container.querySelectorAll('dt')].map((term) => term.textContent);
    const values = [...container.querySelectorAll('dd')].map((value) => value.textContent);
    expect(terms).toEqual(['orderId', 'amount']);
    expect(values).toEqual(['4471', '42.00']);
    expect(getByRole('button', { name: CHAT_COPY.hideInput }).getAttribute('aria-expanded')).toBe(
      'true',
    );

    await fireEvent.click(getByRole('button', { name: CHAT_COPY.hideInput }));
    expect(container.querySelector('dl')).toBeNull();
  });
});
