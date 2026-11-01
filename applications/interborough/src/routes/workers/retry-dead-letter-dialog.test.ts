import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { DeadLetterTarget } from './dead-letter-guard.ts';
import RetryDeadLetterDialog from './retry-dead-letter-dialog.svelte';

const TARGET: DeadLetterTarget = {
  operationId: 'op-123',
  queue: 'payments',
  activityName: 'ChargeCard',
  deadLetteredAt: 1_700_000_000_000,
  attemptTokenDigest: 'sha256:t2',
};

function renderDialog(
  overrides: Partial<{
    target: DeadLetterTarget;
    submitting: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }> = {},
) {
  return render(RetryDeadLetterDialog, {
    props: {
      open: true,
      target: TARGET,
      submitting: false,
      onConfirm: () => {},
      onCancel: () => {},
      ...overrides,
    },
  });
}

describe('RetryDeadLetterDialog', () => {
  test('names the task, its activity and queue, and warns that the activity runs again', () => {
    const { getByText } = renderDialog();
    expect(
      getByText(
        'Queues ChargeCard on queue payments again under the same ID (task op-123) as a new attempt. It failed for good at 2023-11-14T22:13:20.000Z. A worker will run the activity again, so anything it did the first time may happen twice. The failed attempt stays in the task history, and the retained result is replaced.',
      ),
    ).not.toBeNull();
  });

  test('says so when the activity and the moment are not known', () => {
    const { getByText } = renderDialog({
      target: { ...TARGET, activityName: undefined, deadLetteredAt: undefined },
    });
    expect(getByText(/^Queues the task on queue payments again/)).not.toBeNull();
  });

  test('asks for a plain yes: confirming needs no typed id', async () => {
    let confirmed = 0;
    const { getByRole } = renderDialog({ onConfirm: () => (confirmed += 1) });
    await fireEvent.click(getByRole('button', { name: 'Retry task' }));
    expect(confirmed).toBe(1);
  });

  test('cancelling does not confirm', async () => {
    let cancelled = 0;
    const { getByRole } = renderDialog({
      onConfirm: () => {
        throw new Error('must not confirm');
      },
      onCancel: () => (cancelled += 1),
    });
    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(cancelled).toBe(1);
  });

  test('while submitting the confirm button says so', () => {
    const { getByRole } = renderDialog({ submitting: true });
    expect(getByRole('button', { name: 'Retrying…' })).not.toBeNull();
  });
});
