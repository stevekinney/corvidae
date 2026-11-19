import { requireElement } from '../../../../tests/dom.test-support.ts';

import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { BulkOperationDryRunResult } from '@lostgradient/weft';
import { HttpClientError } from '@lostgradient/weft';

import BulkPurgeDialog from './bulk-purge-dialog.svelte';

function preview(overrides: Partial<BulkOperationDryRunResult> = {}): BulkOperationDryRunResult {
  return {
    dryRun: true,
    action: 'purge',
    matched: 47,
    requestId: 'bulk:req-purge',
    scope: {
      matched: 47,
      filter: { status: 'completed', type: 'payment-capture' },
      statuses: ['completed'],
      workflowTypes: ['payment-capture'],
      sampleWorkflowIds: ['wf-1', 'wf-2'],
      sampleLimit: 20,
    },
    sampleWorkflowIds: ['wf-1', 'wf-2'],
    confirmationToken: 'bulk:token-purge',
    confirmationTokenVersion: 1,
    ...overrides,
  };
}

const PHRASE_LABEL = 'Type "purge 47 workflows" to confirm';

describe('BulkPurgeDialog', () => {
  test('shows the server matched count and the sample of ids from the dry run', async () => {
    const { getByText, getByLabelText, getByRole } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview(),
        runPurge: async () => ({ headline: 'Purged 47 workflows', errors: [] }),
        onClose: () => {},
      },
    });

    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    expect(getByText('47 terminal workflows')).not.toBeNull();
    const sample = getByRole('list', { name: 'Workflows the purge would remove' });
    expect(sample.textContent).toContain('wf-1');
    expect(sample.textContent).toContain('wf-2');
    // 47 matched and 2 named: the rest is said, not hidden.
    expect(getByText('…and 45 more.')).not.toBeNull();
  });

  test('the matched count is the dry run, not a count the caller already held', async () => {
    const { getByText, getByLabelText } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview({ matched: 3, sampleWorkflowIds: ['wf-a', 'wf-b', 'wf-c'] }),
        runPurge: async () => ({ headline: 'Purged 3 workflows', errors: [] }),
        onClose: () => {},
      },
    });

    await waitFor(() => {
      expect(getByLabelText('Type "purge 3 workflows" to confirm')).not.toBeNull();
    });
    expect(getByText('3 terminal workflows')).not.toBeNull();
  });

  test('commits with the dry run confirmation token and the matched count, after the phrase is typed', async () => {
    const received: { call?: { token: string; matched: number } } = {};
    let succeeded = 0;
    const { getByRole, getByLabelText, getByText } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview(),
        runPurge: async (token: string, matched: number) => {
          received.call = { token, matched };
          return { headline: 'Purged 47 workflows', errors: [] };
        },
        onClose: () => {},
        onSuccess: () => {
          succeeded += 1;
        },
      },
    });

    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    const confirmButton = requireElement(
      getByRole('button', { name: 'Purge 47 workflows' }),
      HTMLButtonElement,
    );
    expect(confirmButton.disabled).toBe(true);

    await fireEvent.input(getByLabelText(PHRASE_LABEL), {
      target: { value: 'purge 47 workflows' },
    });
    await fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(getByText('Purged 47 workflows')).not.toBeNull();
    });
    expect(received.call).toEqual({ token: 'bulk:token-purge', matched: 47 });
    expect(succeeded).toBe(1);
  });

  test('a preview that matches nothing offers no purge button', async () => {
    const { getByText, queryByRole } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview({ matched: 0, sampleWorkflowIds: [] }),
        runPurge: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });

    await waitFor(() => {
      expect(getByText(/nothing to do/)).not.toBeNull();
    });
    expect(queryByRole('button', { name: /^Purge / })).toBeNull();
  });

  test('a stale confirmation token (InvalidParams) offers "Refresh preview" and runs a fresh dry run', async () => {
    let dryRunCalls = 0;
    const { getByRole, getByLabelText, getByText } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => {
          dryRunCalls += 1;
          return preview();
        },
        runPurge: async () => {
          throw new HttpClientError(400, 'Bulk confirmation token does not match', {
            faultCode: 'InvalidParams',
          });
        },
        onClose: () => {},
      },
    });

    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    await fireEvent.input(getByLabelText(PHRASE_LABEL), {
      target: { value: 'purge 47 workflows' },
    });
    await fireEvent.click(getByRole('button', { name: 'Purge 47 workflows' }));

    await waitFor(() => {
      expect(getByText(/changed since the preview/)).not.toBeNull();
    });
    expect(dryRunCalls).toBe(1);

    await fireEvent.click(getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => {
      expect(dryRunCalls).toBe(2);
    });
  });

  test('a failed dry run offers Retry, which runs the dry run again', async () => {
    let dryRunCalls = 0;
    const { getByRole, getByLabelText } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => {
          dryRunCalls += 1;
          if (dryRunCalls === 1) throw new HttpClientError(500, 'Internal server error');
          return preview();
        },
        runPurge: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Retry' })).not.toBeNull();
    });
    await fireEvent.click(getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    expect(dryRunCalls).toBe(2);
  });
});
