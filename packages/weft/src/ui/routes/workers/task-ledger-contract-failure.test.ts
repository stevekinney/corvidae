import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import TaskLedgerDetailView from './task-ledger-detail-view.svelte';
import { parseTaskLedgerDetail } from './workers-data.ts';

const NOW = 1_700_000_000_000;

function failedTask(error: string) {
  return parseTaskLedgerDetail({
    state: 'terminal',
    operationId: 'op_strict_1',
    workflowType: 'orders',
    activityName: 'chargeCard',
    queue: 'payments',
    headerKeys: [],
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: NOW - 60_000,
    attempt: 1,
    disposition: 'resolved',
    resultStatus: 'failed',
    resultDigest: 'sha256:failed',
    attempts: [],
    error,
    terminalAt: NOW - 10_000,
    adopted: true,
    adoptedAt: NOW - 5_000,
  });
}

describe('task ledger strict payload failures (COR-162)', () => {
  test('strict-boundary vocabulary in a ledger error is hedged, with its path', () => {
    const { getByText, queryByText } = render(TaskLedgerDetailView, {
      props: {
        task: failedTask('activity result.total: number must be finite'),
        now: NOW,
      },
    });

    expect(getByText('Possible strict payload rejection')).not.toBeNull();
    expect(getByText('activity result.total')).not.toBeNull();
    expect(queryByText('Strict payload boundary rejected a value')).toBeNull();
    expect(queryByText('Contract mismatch')).toBeNull();
  });

  test('an activity that throws strict-boundary wording is not asserted to be a worker rejection', () => {
    // Both transports record only `error.message`, so this application error
    // is indistinguishable from a strict-json rejection in the ledger.
    const { container, getByText, queryByText } = render(TaskLedgerDetailView, {
      props: { task: failedTask('price: number must be finite'), now: NOW },
    });

    expect(getByText('Possible strict payload rejection')).not.toBeNull();
    expect(queryByText('Strict payload boundary rejected a value')).toBeNull();
    expect(container.textContent).not.toContain('The worker could not send');
  });

  test('an ordinary activity failure keeps only its error text', () => {
    const { getByText, queryByText } = render(TaskLedgerDetailView, {
      props: { task: failedTask('seeded inventory outage'), now: NOW },
    });

    expect(getByText('seeded inventory outage')).not.toBeNull();
    expect(queryByText('Strict payload boundary rejected a value')).toBeNull();
  });
});
