/**
 * One approval under its call (COR-2016): Cinder's approval row, with the risk its tool's tier
 * implies, so a read-only call is not drawn as a risky one.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { CHAT_APPROVAL_FOR_ATTRIBUTE } from '@lostgradient/chat';

import ChatApproval from './chat-approval.svelte';
import type { ToolCallEntry } from './tool-activity.ts';

afterEach(cleanup);

function entry(tier: ToolCallEntry['tier']): ToolCallEntry {
  return {
    callId: 'call-1',
    name: 'lookup-order',
    title: 'Lookup order',
    tier,
    arguments: { orderId: '4471' },
    state: 'needs-you',
    summary: '',
    result: undefined,
  };
}

function mount(
  tier: ToolCallEntry['tier'],
  onResolve: (resolution: unknown) => void = () => {},
  alwaysAsks?: boolean,
) {
  return render(ChatApproval, {
    props: {
      id: 'approval-1',
      entry: entry(tier),
      question: 'Look up order 4471?',
      source: 'Tool runner',
      context: {},
      unreachable: false,
      alwaysAsks,
      onResolve,
    },
  } as never);
}

describe('a waiting approval', () => {
  test('asks its question as a group the page can focus, and offers Deny and Approve', () => {
    const { container, getByRole } = mount('read-only');
    const row = container.querySelector('[data-approval-decision]');

    expect(row?.getAttribute('tabindex')).toBe('-1');
    expect(row?.getAttribute('data-cinder-tool-approval')).toBe('true');
    expect(row?.getAttribute('data-cinder-tool-approval-call-id')).toBe('call-1');
    expect(row?.textContent).toContain('Look up order 4471?');
    expect(getByRole('button', { name: 'Deny' })).not.toBeNull();
    expect(getByRole('button', { name: /^Approve/ })).not.toBeNull();
  });

  test('offers Allow for the rest of this chat, except for a tool set to Always, which asks every time (06m)', () => {
    const asked = mount('dangerous');
    expect(asked.queryByRole('checkbox', { name: /for the rest of this chat/ })).not.toBeNull();
    cleanup();

    const always = mount('dangerous', () => {}, true);
    expect(always.queryByRole('checkbox')).toBeNull();
    expect(always.getByRole('button', { name: /^Approve/ })).not.toBeNull();
  });

  test('takes its risk from what the tool may do', () => {
    const risks = (['read-only', 'dangerous', undefined] as const).map((tier) => {
      const view = mount(tier);
      const risk = view.container
        .querySelector('[data-approval-decision]')
        ?.outerHTML.match(/data-cinder-risk="(\w+)"/)?.[1];
      cleanup();
      return risk;
    });
    expect(new Set(risks).size).toBeGreaterThan(1);
  });

  test('sends the person’s decision with the call it answers', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const { getByRole } = mount('dangerous', onResolve);

    await fireEvent.click(getByRole('button', { name: /^Approve/ }));
    await fireEvent.click(getByRole('button', { name: 'Press again to approve' }));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({ decision: 'approve' });
  });

  test('becomes the decided row when it is decided while the page is open', async () => {
    const view = mount('dangerous');
    expect(view.container.querySelector('[data-approval-decision]')).not.toBeNull();

    await view.rerender({
      entry: {
        ...entry('dangerous'),
        state: 'done',
        decision: {
          outcome: 'approved',
          decidedBy: 'steve',
          decidedAt: Date.parse('2026-11-05T10:33:00Z'),
        },
      },
    } as never);

    expect(view.container.querySelector('[data-approval-decision]')).toBeNull();
    expect(view.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(view.container.textContent).toContain('Approved');
  });

  test('marks a waiting card with the message that asks for it, so Chat finds it (COR-2440 AC5)', () => {
    const view = render(ChatApproval, {
      props: {
        id: 'approval-marked',
        entry: entry('dangerous'),
        question: 'Look up order 4471?',
        source: 'Tool runner',
        context: {},
        unreachable: false,
        approvalMessageId: 'native-1:step:1:result:call-1',
        onResolve: () => {},
      },
    } as never);
    const card = view.container.querySelector('[data-approval-decision]');
    // The attribute Chat documents and looks a host-drawn card up by.
    expect(card?.getAttribute(CHAT_APPROVAL_FOR_ATTRIBUTE)).toBe('native-1:step:1:result:call-1');
    expect(card?.getAttribute('data-cinder-state')).toBe('pending');
  });

  test('is the explicit decision surface, not the row (COR-2282)', () => {
    const { container } = mount('dangerous');
    expect(
      container.querySelector('.cinder-approval-card')?.getAttribute('data-cinder-layout'),
    ).toBe('decision');
  });

  test('says why when the approval does, and takes irreversible from it over the tier (COR-2438)', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const view = render(ChatApproval, {
      props: {
        id: 'approval-why',
        entry: entry('dangerous'),
        question: 'Look up order 4471?',
        source: 'Tool runner',
        context: {},
        unreachable: false,
        irreversible: false,
        why: 'The customer asked where it is.',
        onResolve,
      },
    } as never);

    expect(view.container.querySelector('.cinder-approval-card__why-body')?.textContent).toBe(
      'The customer asked where it is.',
    );
    // Reversible, so the first press decides; a dangerous tier alone would arm it.
    await fireEvent.click(view.getByRole('button', { name: /^Approve/ }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  test('a decision made in Reviews writes the place as a link to it (COR-2282 A5)', () => {
    const view = render(ChatApproval, {
      props: {
        id: 'approval-elsewhere',
        entry: {
          ...entry('dangerous'),
          state: 'done',
          reviewId: 'approval:run-1:call-1',
          decision: {
            outcome: 'approved',
            decidedBy: 'priya',
            decidedAt: Date.parse('2026-11-05T10:46:00Z'),
            decisionSurface: 'reviews',
          },
        },
        question: '',
        source: 'Tool runner',
        context: { owner: 'steve' },
        unreachable: false,
        decidedInHref: '#/reviews?review=bureau%3Aapproval%3Arun-1%3Acall-1',
        onResolve: () => {},
      },
    } as never);

    const link = view.container.querySelector<HTMLAnchorElement>('.cinder-approval-card a[href]');
    expect(link?.getAttribute('href')).toBe('#/reviews?review=bureau%3Aapproval%3Arun-1%3Acall-1');
    expect(link?.textContent?.trim()).toBe('Reviews');
    // One line (board row A4): the status, then the action, then who decided and where.
    expect(
      view.container.querySelector('.cinder-approval-card__receipt-status')?.textContent?.trim(),
    ).toBe('Approved');
    expect(
      view.container
        .querySelector('.cinder-approval-card__receipt-by')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim(),
    ).toBe('by priya in Reviews');
    // When it was decided is a piece of that line, not a line under the card.
    expect(view.container.querySelector('.cinder-approval-card__receipt-time')).not.toBeNull();
    expect(view.container.querySelector('.chat-approval-time')).toBeNull();
  });

  test('reads expired from its expiresAt alone, writes when it lapsed in its status line, and offers Ask again (COR-2280)', async () => {
    const onAskAgain = mock(() => undefined);
    const view = render(ChatApproval, {
      props: {
        id: 'approval-lapsed',
        entry: entry('dangerous'),
        question: 'Look up order 4471?',
        source: 'Tool runner',
        context: {},
        unreachable: false,
        expiresAt: '2026-11-01T09:15:00.000Z',
        onAskAgain,
        onResolve: () => {},
      },
    } as never);

    const card = view.container.querySelector('[data-approval-decision]');
    expect(card?.getAttribute('data-cinder-state')).toBe('expired');
    expect(card?.textContent).toContain('Expired before a decision');
    expect(view.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(
      card?.querySelector('.cinder-approval-card__settled-time')?.getAttribute('datetime'),
    ).toBe('2026-11-01T09:15:00.000Z');
    expect(view.container.querySelector('.chat-approval-time')).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Ask again' }));
    expect(onAskAgain).toHaveBeenCalledTimes(1);
  });

  test('becomes expired when the mounted entry reaches its terminal state', async () => {
    const view = mount('dangerous');
    await view.rerender({
      entry: { ...entry('dangerous'), state: 'expired' },
      expiresAt: '2026-11-01T00:00:00.000Z',
    } as never);

    expect(
      view.container.querySelector('[data-approval-decision]')?.getAttribute('data-cinder-state'),
    ).toBe('expired');
  });
});
