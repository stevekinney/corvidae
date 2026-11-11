/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { flushSync } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import type { ToolApprovalMessagePart } from '../../utilities/types.ts';

setupHappyDom();

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { default: ToolApprovalPart } = await import('./tool-approval-part.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function refundPart(overrides?: Partial<ToolApprovalMessagePart>): ToolApprovalMessagePart {
  return {
    type: 'tool-approval',
    key: 'm:tool-approval:call-1',
    toolCallId: 'call-1',
    toolName: 'issue-refund',
    action: {
      type: 'approval',
      message: 'Refund order 4471 for $42.00?',
      risk: 'high',
      operation: { kind: 'command', command: 'refund --order 4471 --amount 42.00' },
      policyVersion: 'test-policy',
      idempotencyKey: 'test-approval',
    },
    state: 'pending',
    resolutionInFlight: false,
    ...overrides,
  };
}

const details: NonNullable<ToolApprovalMessagePart['details']> = {
  irreversible: true,
  approveLabel: 'Refund $42.00',
  pauseSentence: 'The agent is paused until you decide.',
  facts: [
    { label: 'Target', value: 'order 4471' },
    { label: 'Amount', value: '$42.00' },
  ],
  why: 'The customer reported the parcel arrived damaged.',
};

describe('ToolApprovalPart decision surface', () => {
  test('draws the decision with the tool and the command when nothing describes the approval', () => {
    const { container, getByRole } = render(ToolApprovalPart, {
      props: { part: refundPart(), onApprovalResolve: () => undefined },
    });
    const card = container.querySelector('[data-cinder-tool-approval]');

    expect(card?.getAttribute('data-cinder-layout')).toBe('decision');
    expect(card?.querySelector('.cinder-approval-card__risk-icon')).toBeNull();
    expect(card?.querySelector('.cinder-approval-card__irreversible')).toBeNull();
    expect(
      Array.from(card?.querySelectorAll('.cinder-approval-card__fact dt') ?? [], (term) =>
        term.textContent?.trim(),
      ),
    ).toEqual(['Tool', 'Command']);
    expect(getByRole('button', { name: 'Approve' })).not.toBeNull();
  });

  test('draws the decision, forwarding the irreversible flag, the label, the pause, the facts and why', () => {
    const { container, getByRole } = render(ToolApprovalPart, {
      props: { part: refundPart({ details }), onApprovalResolve: () => undefined },
    });
    const card = container.querySelector('[data-cinder-tool-approval]');

    expect(card?.getAttribute('data-cinder-layout')).toBe('decision');
    expect(card?.querySelector('.cinder-approval-card__irreversible')?.textContent?.trim()).toBe(
      "Can't be undone",
    );
    expect(card?.querySelector('.cinder-approval-card__pause')?.textContent?.trim()).toBe(
      'The agent is paused until you decide.',
    );
    expect(
      Array.from(card?.querySelectorAll('.cinder-approval-card__fact dt') ?? [], (term) =>
        term.textContent?.trim(),
      ),
    ).toEqual(['Tool', 'Target', 'Amount', 'Command']);
    expect(getByRole('button', { name: 'Why the agent wants to do this' })).not.toBeNull();
    expect(getByRole('button', { name: 'Refund $42.00' })).not.toBeNull();
  });

  test('says an action can be undone when the adapter says so', () => {
    const { container } = render(ToolApprovalPart, {
      props: {
        part: refundPart({ details: { irreversible: false } }),
        onApprovalResolve: () => undefined,
      },
    });

    expect(container.querySelector('.cinder-approval-card__irreversible')).toBeNull();
    expect(container.textContent).toContain('Reversible');
  });

  test('an irreversible approval needs a second press before it forwards the resolution', async () => {
    const onApprovalResolve = mock((_toolCallId: string, _resolution: unknown) => undefined);
    const { getByRole } = render(ToolApprovalPart, {
      props: { part: refundPart({ details }), onApprovalResolve },
    });

    await fireEvent.click(getByRole('button', { name: 'Refund $42.00' }));
    flushSync();
    expect(onApprovalResolve).not.toHaveBeenCalled();

    await fireEvent.click(getByRole('button', { name: 'Press again to refund $42.00' }));
    flushSync();
    expect(onApprovalResolve).toHaveBeenCalledWith('call-1', {
      decision: 'approve',
      remember: false,
    });
  });

  test('Escape on an armed press reverts it without cancelling the approval', async () => {
    const onApprovalResolve = mock((_toolCallId: string, _resolution: unknown) => undefined);
    const { container, getByRole, queryByRole } = render(ToolApprovalPart, {
      props: { part: refundPart({ details }), onApprovalResolve },
    });
    const card = container.querySelector('[data-cinder-tool-approval]')!;

    await fireEvent.click(getByRole('button', { name: 'Refund $42.00' }));
    flushSync();
    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    flushSync();

    expect(queryByRole('button', { name: 'Press again to refund $42.00' })).toBeNull();
    expect(onApprovalResolve).not.toHaveBeenCalled();

    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(onApprovalResolve).toHaveBeenCalledWith('call-1', {
      decision: 'cancel',
      remember: false,
    });
  });

  test('forwards the irreversible flag when it is all the adapter said', () => {
    const { container } = render(ToolApprovalPart, {
      props: {
        part: refundPart({ details: { irreversible: true } }),
        onApprovalResolve: () => undefined,
      },
    });

    expect(container.querySelector('.cinder-approval-card__irreversible')).not.toBeNull();
  });
});

describe('ToolApprovalPart receipt', () => {
  const decidedAt = Date.UTC(2026, 10, 2, 10, 46);

  test('a decision made here reads by you, with the time, as a receipt', () => {
    const { container } = render(ToolApprovalPart, {
      props: {
        part: refundPart({ details, state: 'approved', receipt: { decidedAt } }),
      },
    });
    const card = container.querySelector('[data-cinder-tool-approval]');

    expect(card?.getAttribute('data-cinder-state')).toBe('approved');
    expect(card?.querySelector('.cinder-badge')?.textContent?.trim()).toBe('Approved');
    expect(card?.querySelector('.cinder-approval-card__receipt-by')?.textContent?.trim()).toMatch(
      /^by you, \d{1,2}:\d{2} [AP]M$/,
    );
  });

  test('a denial quotes the note that went with it', () => {
    const { container } = render(ToolApprovalPart, {
      props: {
        part: refundPart({
          details,
          state: 'denied',
          receipt: { decidedAt, reason: 'Refund it through the original card instead' },
        }),
      },
    });

    expect(
      container.querySelector('.cinder-approval-card__receipt-quote')?.textContent?.trim(),
    ).toBe('“Refund it through the original card instead”');
  });

  test('without a description a decision made here is still a receipt', () => {
    const { container } = render(ToolApprovalPart, {
      props: {
        part: refundPart({ state: 'denied', receipt: { decidedAt, reason: 'Not today' } }),
      },
    });
    const card = container.querySelector('[data-cinder-tool-approval]');

    expect(card?.getAttribute('data-cinder-layout')).toBe('decision');
    expect(card?.querySelector('.cinder-approval-card__receipt-by')?.textContent?.trim()).toMatch(
      /^by you, \d{1,2}:\d{2} [AP]M$/,
    );
    expect(card?.querySelector('.cinder-approval-card__receipt-quote')?.textContent).toContain(
      'Not today',
    );
  });
});
