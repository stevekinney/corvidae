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

function mount(tier: ToolCallEntry['tier'], onResolve: (resolution: unknown) => void = () => {}) {
  return render(ChatApproval, {
    props: {
      id: 'approval-1',
      entry: entry(tier),
      question: 'Look up order 4471?',
      source: 'Tool runner',
      context: {},
      unreachable: false,
      onResolve,
    },
  } as never);
}

describe('a waiting approval', () => {
  test('asks its question as a group the page can focus, and offers Deny and Approve', () => {
    const { container, getByRole } = mount('read-only');
    const row = container.querySelector('[data-approval-decision]');

    expect(row?.getAttribute('tabindex')).toBe('-1');
    expect(row?.textContent).toContain('Look up order 4471?');
    expect(getByRole('button', { name: 'Deny' })).not.toBeNull();
    expect(getByRole('button', { name: /^Approve/ })).not.toBeNull();
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

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({ decision: 'approve' });
  });
});
