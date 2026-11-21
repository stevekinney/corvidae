import { requireElement } from '../../../../tests/dom.test-support.ts';

import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { waitUntil } from '@lostgradient/testing/wait-until';

import type { BulkOperationDryRunResult } from '@lostgradient/weft';
import { HttpClientError } from '@lostgradient/weft';

import BulkPurgeDialog from './bulk-purge-dialog.svelte';
import type { BulkCommitSummary } from './bulk-result-summary.ts';

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
    const { getByLabelText, queryAllByRole } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview(),
        runPurge: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });

    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    // ConfirmDialog keeps its failure region mounted (empty) so a failure is announced when it
    // arrives; "static" means that region says nothing, not that it is absent.
    expect(queryAllByRole('alert').map((region) => region.textContent?.trim())).toEqual(['']);
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

  test('the dialog carries no styles of its own: the sample, the chip and the notes are ConfirmDialog options', async () => {
    for (const file of ['./bulk-purge-dialog.svelte', './bulk-action-dialog.svelte']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toContain('<style');
      expect(source).not.toContain('weft-bulk-dialog');
    }

    const { getByLabelText, getByRole, getByText } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview(),
        runPurge: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });
    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    // Cinder's options region wraps a long id and a long filter summary, so the page adds no CSS.
    const options = requireElement(
      document.querySelector('.cinder-confirm-dialog__options'),
      HTMLElement,
    );
    expect(options.contains(getByRole('list', { name: 'These workflows will be deleted:' }))).toBe(
      true,
    );
    expect(options.contains(getByText('status:completed, type:payment-capture'))).toBe(true);
    expect(options.querySelector('li code')?.textContent).toBe('wf-1');
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

  test('the dialog is titled for finished workflows, and while the purge runs it says it continues on the server', async () => {
    const { getByRole, getByLabelText, getByText, queryByText, container } = render(
      BulkPurgeDialog,
      {
        props: {
          runDryRun: async () => preview(),
          runPurge: () => new Promise<BulkCommitSummary>(() => {}),
          onClose: () => {},
        },
      },
    );

    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    expect(getByText('Purge finished workflows')).not.toBeNull();
    expect(queryByText('Purge terminal workflows')).toBeNull();

    await fireEvent.input(getByLabelText(PHRASE_LABEL), {
      target: { value: 'purge 47 workflows' },
    });
    await fireEvent.click(getByRole('button', { name: 'Purge 47 workflows' }));

    await waitFor(() => {
      expect(
        getByText('Purging. This keeps running on the server if you leave this page.'),
      ).not.toBeNull();
    });
    // No spaced em dash, and no talk of closing the dialog: the person may leave the page.
    expect(container.ownerDocument.body.textContent).not.toMatch(/ — |Closing this/);
  });

  test('a preview that matches nothing says so, warns of nothing, and offers no purge button', async () => {
    let closed = 0;
    const { getAllByRole, getByText, queryAllByRole, queryByText, queryByRole } = render(
      BulkPurgeDialog,
      {
        props: {
          runDryRun: async () => preview({ matched: 0, sampleWorkflowIds: [] }),
          runPurge: async () => ({ headline: 'unused', errors: [] }),
          onClose: () => {
            closed += 1;
          },
        },
      },
    );

    await waitFor(() => {
      expect(
        getByText('No finished workflows match this filter now, so there is nothing to purge.'),
      ).not.toBeNull();
    });
    // The one dismiss action is "Close": with nothing to purge there is nothing to cancel.
    expect(queryByRole('button', { name: 'Cancel' })).toBeNull();
    // The modal's own corner X is also named "Close"; the footer action is the one with the word.
    const footerClose = requireElement(
      getAllByRole('button').find((button) => button.textContent?.trim() === 'Close'),
      HTMLButtonElement,
    );
    await fireEvent.click(footerClose);
    expect(closed).toBe(1);
    // Nothing will be deleted, so there is no irreversibility to warn about and nothing to confirm.
    expect(queryByText(/can't be undone/)).toBeNull();
    expect(queryByText(/Permanently deletes/)).toBeNull();
    expect(queryAllByRole('alert').map((region) => region.textContent?.trim())).toEqual(['']);
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

  test('after Refresh preview the new preview moves focus to its lead sentence so the new count is read, and the first open does not', async () => {
    let dryRunCalls = 0;
    const { getByRole, getByLabelText, getByText } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => {
          dryRunCalls += 1;
          return dryRunCalls === 1 ? preview() : preview({ matched: 3, sampleWorkflowIds: [] });
        },
        runPurge: async () => {
          throw new HttpClientError(409, 'Bulk confirmation token does not match', {
            faultCode: 'Conflict',
          });
        },
        onClose: () => {},
      },
    });

    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    // First open: focus is Cinder's initial focus, not the lead sentence.
    const firstLead = requireElement(getByText(/Permanently deletes 47 finished/), HTMLElement);
    expect(firstLead.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).not.toBe(firstLead);

    await fireEvent.input(getByLabelText(PHRASE_LABEL), {
      target: { value: 'purge 47 workflows' },
    });
    await fireEvent.click(getByRole('button', { name: 'Purge 47 workflows' }));
    await waitFor(() => {
      expect(getByRole('button', { name: 'Refresh preview' })).not.toBeNull();
    });
    requireElement(getByRole('button', { name: 'Refresh preview' }), HTMLButtonElement).focus();
    await fireEvent.click(getByRole('button', { name: 'Refresh preview' }));

    await waitFor(() => {
      expect(getByLabelText('Type "purge 3 workflows" to confirm')).not.toBeNull();
    });
    const newLead = requireElement(getByText(/Permanently deletes 3 finished/), HTMLElement);
    await waitUntil(() => document.activeElement === newLead, {
      message: 'focus to land on the refreshed preview lead sentence',
    });
  });

  test('while the preview loads or refreshes the footer keeps a live Cancel and a disabled Purge, and focus stays inside the dialog', async () => {
    // The disabled button reads "Purge workflows" while there is no count to name yet.
    let dryRunCalls = 0;
    let closed = 0;
    let release: (value: BulkOperationDryRunResult) => void = () => {};
    const { getByRole, getByLabelText, queryByRole } = render(BulkPurgeDialog, {
      props: {
        runDryRun: () => {
          dryRunCalls += 1;
          if (dryRunCalls === 1) return Promise.resolve(preview());
          return new Promise<BulkOperationDryRunResult>((resolve) => {
            release = resolve;
          });
        },
        runPurge: async () => {
          throw new HttpClientError(409, 'Bulk confirmation token does not match', {
            faultCode: 'Conflict',
          });
        },
        onClose: () => {
          closed += 1;
        },
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
      expect(getByRole('button', { name: 'Refresh preview' })).not.toBeNull();
    });

    // The operator presses Refresh preview with the keyboard: it holds focus, then unmounts.
    const refresh = requireElement(
      getByRole('button', { name: 'Refresh preview' }),
      HTMLButtonElement,
    );
    refresh.focus();
    await fireEvent.click(refresh);

    await waitFor(() => {
      expect(queryByRole('button', { name: 'Refresh preview' }) === null).toBe(true);
    });
    // Loading again: the footer is still there, Cancel works and Purge cannot be pressed.
    const purge = requireElement(
      getByRole('button', { name: 'Purge workflows' }),
      HTMLButtonElement,
    );
    expect(purge.disabled).toBe(true);
    const cancel = requireElement(getByRole('button', { name: 'Cancel' }), HTMLButtonElement);
    expect(cancel.disabled).toBe(false);
    // Focus did not fall to <body>: it is on a control or the dialog's body, inside the dialog.
    const dialog = requireElement(document.querySelector('dialog'), HTMLDialogElement);
    await waitUntil(
      () => document.activeElement !== document.body && dialog.contains(document.activeElement),
      { message: 'focus to stay inside the dialog after Refresh preview unmounted' },
    );

    await fireEvent.click(cancel);
    expect(closed).toBe(1);

    release(preview());
    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    // Purge is back to its counted label once the new preview is in.
    expect(getByRole('button', { name: 'Purge 47 workflows' })).not.toBeNull();
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

  test('a failed commit says what was deleted and never retries with the same token: it offers Refresh preview, which runs the dry run again', async () => {
    let dryRunCalls = 0;
    let purgeCalls = 0;
    const { getByRole, getByLabelText, getByText, queryByRole } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => {
          dryRunCalls += 1;
          return preview();
        },
        runPurge: async () => {
          purgeCalls += 1;
          throw new HttpClientError(500, 'Purge deleted 30 workflows and failed for 17.', {
            faultCode: 'EngineFailure',
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
      expect(getByText('Purge deleted 30 workflows and failed for 17.')).not.toBeNull();
    });
    expect(getByText('Refresh the preview to see what is left.')).not.toBeNull();
    // The same-token retry is gone: nothing in the dialog sends the commit a second time.
    expect(queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(purgeCalls).toBe(1);

    await fireEvent.click(getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => {
      expect(getByLabelText(PHRASE_LABEL)).not.toBeNull();
    });
    expect(dryRunCalls).toBe(2);
    expect(purgeCalls).toBe(1);
    // A new preview needs a new confirmation: the phrase typed for the old one is gone.
    expect((getByLabelText(PHRASE_LABEL) as HTMLInputElement).value).toBe('');
  });

  test('a commit that never got an answer does not claim nothing was deleted', async () => {
    const { getByRole, getByLabelText, getByText, queryByText } = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview(),
        runPurge: async () => {
          throw new TypeError('Failed to fetch');
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
      expect(getByText('Refresh the preview to see what is left.')).not.toBeNull();
    });
    expect(getByRole('button', { name: 'Refresh preview' })).not.toBeNull();
    // Only the server's Conflict, raised before anything is touched, may say nothing was purged.
    expect(queryByText(/Nothing was purged/)).toBeNull();
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
