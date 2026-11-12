/**
 * One approval under its call (COR-2016): Cinder's approval row, with the risk its tool's tier
 * implies, so a read-only call is not drawn as a risky one.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, mock, test } from 'bun:test';

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
