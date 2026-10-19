import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import ApprovalAlert from './approval-alert.svelte';

afterEach(cleanup);

const approvals = [
  { toolCallId: 'call-1', toolName: 'issue-refund', message: 'Refund order-1001?' },
  { toolCallId: 'call-2', toolName: 'send-email', message: undefined },
];

describe('the approval alert', () => {
  test('is one warning alert for each approval, naming the tool and the question', () => {
    const { getAllByRole, getByText } = render(ApprovalAlert, {
      props: { approvals, deciding: false, onDecide: () => undefined },
    });

    expect(getAllByRole('alert')).toHaveLength(2);
    expect(getByText('issue-refund')).not.toBeNull();
    expect(getByText('Refund order-1001?')).not.toBeNull();
    expect(getByText('send-email')).not.toBeNull();
  });

  test('reports Approve and Deny with the tool call they decide', () => {
    const decisions: Array<[string, string]> = [];
    const { getAllByRole } = render(ApprovalAlert, {
      props: {
        approvals,
        deciding: false,
        onDecide: (toolCallId: string, decision: string) => decisions.push([toolCallId, decision]),
      },
    });

    (getAllByRole('button', { name: 'Approve' })[0] as HTMLButtonElement).click();
    (getAllByRole('button', { name: 'Deny' })[1] as HTMLButtonElement).click();

    expect(decisions).toEqual([
      ['call-1', 'approve'],
      ['call-2', 'deny'],
    ]);
  });

  test('holds every button while a decision is being sent', () => {
    const { getAllByRole } = render(ApprovalAlert, {
      props: { approvals, deciding: true, onDecide: () => undefined },
    });

    const buttons = getAllByRole('button') as HTMLButtonElement[];
    expect(buttons.map((button) => button.disabled)).toEqual([true, true, true, true]);
  });

  test('renders nothing when no approval is waiting', () => {
    const { queryAllByRole } = render(ApprovalAlert, {
      props: { approvals: [], deciding: false, onDecide: () => undefined },
    });

    expect(queryAllByRole('alert')).toEqual([]);
  });
});
