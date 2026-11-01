import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import ClearDeadLetterDialog from './clear-dead-letter-dialog.svelte';
import type { DeadLetterTarget } from './dead-letter-guard.ts';

const TARGET: DeadLetterTarget = {
  operationId: 'op-123',
  queue: 'payments',
  activityName: 'ChargeCard',
  deadLetteredAt: 1_700_000_000_000,
  attemptTokenDigest: undefined,
};

describe('ClearDeadLetterDialog', () => {
  test('names what it clears: the task, its activity, its queue and when it failed for good', () => {
    const { getByText } = render(ClearDeadLetterDialog, {
      props: {
        open: true,
        target: TARGET,
        submitting: false,
        onConfirm: () => {},
        onCancel: () => {},
      },
    });

    expect(
      getByText(
        'Clears the retained dead-letter record for ChargeCard on queue payments (task op-123). It failed for good at 2023-11-14T22:13:20.000Z. Clearing does not retry the task, and it cannot be undone.',
      ),
    ).not.toBeNull();
  });

  test('says so when the diagnostics named neither the activity nor the moment', () => {
    const { getByText } = render(ClearDeadLetterDialog, {
      props: {
        open: true,
        target: {
          operationId: 'op-9',
          queue: 'payments',
          activityName: undefined,
          deadLetteredAt: undefined,
          attemptTokenDigest: undefined,
        },
        submitting: false,
        onConfirm: () => {},
        onCancel: () => {},
      },
    });

    expect(
      getByText(
        'Clears the retained dead-letter record for a task on queue payments (task op-9). Clearing does not retry the task, and it cannot be undone.',
      ),
    ).not.toBeNull();
  });

  test('the confirm button is disabled until the operationId is typed exactly', async () => {
    const { getByRole, getByLabelText } = render(ClearDeadLetterDialog, {
      props: {
        open: true,
        target: TARGET,
        submitting: false,
        onConfirm: () => {},
        onCancel: () => {},
      },
    });

    const confirmButton = getByRole('button', { name: 'Clear dead letter' });
    expect(confirmButton.hasAttribute('disabled')).toBe(true);

    const input = getByLabelText(/Type "op-123" to confirm/i);
    await fireEvent.input(input, { target: { value: 'op-123' } });

    expect(confirmButton.hasAttribute('disabled')).toBe(false);
  });

  test('confirming calls onConfirm once the value matches', async () => {
    let confirmed = 0;
    const { getByRole, getByLabelText } = render(ClearDeadLetterDialog, {
      props: {
        open: true,
        target: TARGET,
        submitting: false,
        onConfirm: () => (confirmed += 1),
        onCancel: () => {},
      },
    });

    await fireEvent.input(getByLabelText(/Type "op-123" to confirm/i), {
      target: { value: 'op-123' },
    });
    await fireEvent.click(getByRole('button', { name: 'Clear dead letter' }));

    expect(confirmed).toBe(1);
  });

  test('cancelling calls onCancel', async () => {
    let cancelled = 0;
    const { getByRole } = render(ClearDeadLetterDialog, {
      props: {
        open: true,
        target: TARGET,
        submitting: false,
        onConfirm: () => {},
        onCancel: () => (cancelled += 1),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(cancelled).toBe(1);
  });
});
