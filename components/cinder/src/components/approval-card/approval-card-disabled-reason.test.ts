/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

import type { ApprovalCardProps } from './approval-card.types.ts';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: ApprovalCard } = await import('./approval-card.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const REASON = 'Approving is off until Interborough is reachable';

function editableCard(overrides: Partial<ApprovalCardProps> = {}): ApprovalCardProps {
  return {
    tool: { name: 'issue-refund', risk: 'high', irreversible: true },
    operation: { kind: 'other', argsPreview: { force: false } },
    policyVersion: 'policy-2026-06',
    idempotencyKey: 'disabled-reason-key',
    state: 'pending',
    editableArgs: true,
    ...overrides,
  };
}

describe('ApprovalCard disabled reason on every commit path', () => {
  test('Confirm edited approval holds back a reason that appears after the edit, and works once it clears', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const view = render(ApprovalCard, { props: editableCard({ onResolve }) });

    await fireEvent.click(view.getByRole('button', { name: 'Approve with edits' }));
    const editor = requiredInstance(
      view.getByLabelText('Edited arguments JSON'),
      HTMLTextAreaElement,
    );
    await fireEvent.input(editor, { target: { value: '{ "force": true }' } });

    await view.rerender(editableCard({ onResolve, disabledReason: REASON }));
    const confirm = requiredInstance(
      view.getByRole('button', { name: 'Confirm edited approval' }),
      HTMLButtonElement,
    );
    const reason = view.getByText(REASON);
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(confirm.getAttribute('aria-describedby')).toBe(reason.id);
    await fireEvent.click(confirm);
    expect(onResolve).not.toHaveBeenCalled();

    await view.rerender(editableCard({ onResolve }));
    await fireEvent.click(view.getByRole('button', { name: 'Confirm edited approval' }));
    expect(onResolve).toHaveBeenCalledWith({
      decision: 'approve_with_edits',
      editedArgs: { force: true },
      remember: false,
    });
  });

  test('Confirm edited approval is held back from the first render when the reason is already given', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const view = render(ApprovalCard, {
      props: editableCard({ onResolve, disabledReason: REASON }),
    });

    await fireEvent.click(view.getByRole('button', { name: 'Approve with edits' }));
    await fireEvent.click(view.getByRole('button', { name: 'Confirm edited approval' }));

    expect(onResolve).not.toHaveBeenCalled();
  });
});
