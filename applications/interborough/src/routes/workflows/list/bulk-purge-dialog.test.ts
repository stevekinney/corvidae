import { requireElement } from '../../../../tests/dom.test-support.ts';

import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

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
    // Irreversibility is in the lead sentence, at body size, not in a footnote.
    expect(
      getByText(
        "Permanently deletes 47 finished workflows matching this filter. This can't be undone.",
      ),
    ).not.toBeNull();
    expect(
      getByText('Workflows still running, or still running their cleanup step, are kept.'),
    ).not.toBeNull();
    expect(getByText('These workflows will be deleted:')).not.toBeNull();
    const sample = getByRole('list', { name: 'These workflows will be deleted:' });
    expect(sample.textContent).toContain('wf-1');
    expect(sample.textContent).toContain('wf-2');
    // 47 matched and 2 named: the rest is said, not hidden.
    expect(getByText('…and 45 more.')).not.toBeNull();
  });

  test('the preview is static text: nothing in it is a live alert', async () => {
    const { getByLabelText, queryByRole } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview(),
        runPurge: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });

    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    expect(queryByRole('alert')).toBeNull();
  });

  test('the count in the lead sentence is singular for one workflow', async () => {
    const { getByText } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview({ matched: 1, sampleWorkflowIds: ['wf-only'] }),
        runPurge: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });

    await waitFor(() => {
      expect(
        getByText(
          "Permanently deletes 1 finished workflow matching this filter. This can't be undone.",
        ),
      ).not.toBeNull();
    });
  });

  test('while the dry run is in flight the dialog says so in a status region', async () => {
    const { getAllByRole, getAllByText } = render(BulkPurgeDialog, {
      props: {
        runDryRun: () => new Promise<BulkOperationDryRunResult>(() => {}),
        runPurge: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });

    expect(getAllByRole('status').length).toBeGreaterThan(0);
    // The words show in the dialog and are announced by the status region, so two elements carry them.
    await waitFor(() => {
      expect(getAllByText('Counting the workflows a purge would delete').length).toBeGreaterThan(0);
    });
  });

  test('the dialog styles let a long id wrap and use spacing tokens, not raw pixel margins', () => {
    const source = readFileSync(new URL('./bulk-purge-dialog.svelte', import.meta.url), 'utf8');
    const styles = source.slice(source.indexOf('<style>'));

    expect(styles).toMatch(/overflow-wrap:\s*anywhere/);
    expect(styles).not.toMatch(/margin[^;{}]*\d+px/);
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
    expect(getByText(/Permanently deletes 3 finished workflows/)).not.toBeNull();
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

  test('a preview that matches nothing says so, warns of nothing, and offers no purge button', async () => {
    const { getByText, queryByText, queryByRole } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview({ matched: 0, sampleWorkflowIds: [] }),
        runPurge: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });

    await waitFor(() => {
      expect(
        getByText('None of the matching workflows have finished, so there is nothing to purge.'),
      ).not.toBeNull();
    });
    // Nothing will be deleted, so there is no irreversibility to warn about and nothing to confirm.
    expect(queryByText(/can't be undone/)).toBeNull();
    expect(queryByText(/Permanently deletes/)).toBeNull();
    expect(queryByRole('alert')).toBeNull();
    expect(queryByRole('textbox')).toBeNull();
    expect(queryByRole('button', { name: /^Purge / })).toBeNull();
  });

  test('a stale confirmation token (Conflict) says the matching workflows changed, never the server message, and offers one "Refresh preview"', async () => {
    let dryRunCalls = 0;
    const { getByRole, getAllByRole, getByLabelText, getByText, queryByText } = render(
      BulkPurgeDialog,
      {
        props: {
          runDryRun: async () => {
            dryRunCalls += 1;
            return preview();
          },
          runPurge: async () => {
            throw new HttpClientError(409, 'Bulk confirmation token does not match', {
              faultCode: 'Conflict',
            });
          },
          onClose: () => {},
        },
      },
    );

    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    await fireEvent.input(getByLabelText(PHRASE_LABEL), {
      target: { value: 'purge 47 workflows' },
    });
    await fireEvent.click(getByRole('button', { name: 'Purge 47 workflows' }));

    await waitFor(() => {
      expect(getByText('The matching workflows changed')).not.toBeNull();
    });
    expect(getByText(/Check the new count before you purge\./)).not.toBeNull();
    // Nothing was deleted: the server checks the token before it touches a workflow.
    expect(getByText(/Nothing was purged\./)).not.toBeNull();
    expect(queryByText(/does not match/)).toBeNull();
    // The callout carries the one Refresh action; the footer does not repeat it.
    expect(getAllByRole('button', { name: 'Refresh preview' })).toHaveLength(1);
    expect(dryRunCalls).toBe(1);

    await fireEvent.click(getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => {
      expect(dryRunCalls).toBe(2);
    });
  });

  test('invalid input (InvalidParams) is not read as a stale preview: it shows the fault, never the changed-workflows callout', async () => {
    const { getByRole, getByLabelText, getByText, queryByText } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview(),
        runPurge: async () => {
          throw new HttpClientError(400, 'Field "filter.tags" must be an array', {
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
      expect(getByText('Field "filter.tags" must be an array')).not.toBeNull();
    });
    expect(queryByText('The matching workflows changed')).toBeNull();
    expect(queryByText(/Nothing was purged\./)).toBeNull();
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
