import { requireElement } from '../../../../tests/dom.test-support.ts';

import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import type { BulkOperationDryRunResult } from '@lostgradient/weft/testing';
import { HttpClientError } from '@lostgradient/weft/testing';

import { BULK_DIALOG_COPY } from '../../../app/copy/bulk-dialog.ts';
import { BULK_PURGE_COPY } from '../../../app/copy/bulk-purge.ts';
import BulkActionDialog from './bulk-action-dialog.svelte';
import BulkPurgeDialog from './bulk-purge-dialog.svelte';
import type { BulkCommitSummary } from './bulk-result-summary.ts';

function preview(overrides: Partial<BulkOperationDryRunResult> = {}): BulkOperationDryRunResult {
  return {
    dryRun: true,
    action: 'cancel',
    matched: 47,
    requestId: 'bulk:req-1',
    scope: {
      matched: 47,
      filter: { status: 'failed', type: 'payment-capture' },
      statuses: ['failed'],
      workflowTypes: ['payment-capture'],
      sampleWorkflowIds: ['wf-1', 'wf-2'],
      sampleLimit: 20,
    },
    sampleWorkflowIds: ['wf-1', 'wf-2'],
    confirmationToken: 'bulk:token-abc',
    confirmationTokenVersion: 1,
    ...overrides,
  };
}

const CONFLICT_SENTENCE = 'Bulk confirmation token does not match the current dry-run scope';
const ACTION_PHRASE = 'Type "cancel 47 workflows" to confirm';
const PURGE_PHRASE = 'Type "purge 47 workflows" to confirm';

/** The failure callout: the one place a fault is drawn. */
function callouts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.cinder-callout'));
}

/** Every button in the dialog's footer: the failure callout's action and the actions row. */
function footerButtonNames(): (string | undefined)[] {
  return Array.from(document.querySelectorAll('.cinder-modal__footer button')).map((button) =>
    button.textContent?.trim(),
  );
}

/** The two queries a typed confirmation needs, narrowed from what `render` returns. */
interface TypedConfirmationQueries {
  getByLabelText: (label: string) => HTMLElement;
  getByRole: (role: 'button', options: { name: string }) => HTMLElement;
}

async function typeAndConfirm(
  view: TypedConfirmationQueries,
  label: string,
  phrase: string,
  button: string,
): Promise<void> {
  await waitFor(() => {
    expect(view.getByLabelText(label)).not.toBeNull();
  });
  await fireEvent.input(view.getByLabelText(label), { target: { value: phrase } });
  await fireEvent.click(view.getByRole('button', { name: button }));
}

describe('the footer is present in every phase', () => {
  test('params, loading, preview, committing and result keep one footer with its Cancel or Close', async () => {
    let release: (summary: BulkCommitSummary) => void = () => {};
    let releasePreview: (result: BulkOperationDryRunResult) => void = () => {};
    const view = render(BulkActionDialog, {
      props: {
        title: 'Bulk signal',
        verb: 'signal',
        destructive: false,
        parameters: createRawSnippet(() => ({ render: () => '<p>Signal name</p>' })),
        parametersValid: true,
        runDryRun: () =>
          new Promise<BulkOperationDryRunResult>((resolve) => {
            releasePreview = resolve;
          }),
        runCommit: () =>
          new Promise<BulkCommitSummary>((resolve) => {
            release = resolve;
          }),
        onClose: () => {},
      },
    });
    const footerNames = footerButtonNames;
    const footerCount = (): number => document.querySelectorAll('.cinder-modal__footer').length;

    // params: Cancel and Continue.
    expect(footerCount()).toBe(1);
    expect(footerNames()).toEqual(['Cancel', 'Continue']);

    // loading: Cancel and a confirm that cannot be pressed yet.
    await fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(footerNames()).toEqual(['Cancel', 'Signal workflows']);
    });
    expect(footerCount()).toBe(1);
    expect(
      requireElement(view.getByRole('button', { name: 'Signal workflows' }), HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // preview.
    releasePreview(preview());
    await waitFor(() => {
      expect(view.getByLabelText('Type "signal 47 workflows" to confirm')).not.toBeNull();
    });
    expect(footerCount()).toBe(1);
    expect(footerNames()).toEqual(['Cancel', 'Signal 47 workflows']);

    // committing: the same footer, its confirm busy and its Cancel inert.
    await fireEvent.input(view.getByLabelText('Type "signal 47 workflows" to confirm'), {
      target: { value: 'signal 47 workflows' },
    });
    await fireEvent.click(view.getByRole('button', { name: 'Signal 47 workflows' }));
    await waitFor(() => {
      expect(view.getByText(/keeps running on the server/)).not.toBeNull();
    });
    expect(footerCount()).toBe(1);
    expect(footerNames()).toEqual(['Cancel', 'Signal 47 workflows']);
    expect(
      document.querySelector('.cinder-modal__footer button[aria-disabled="true"]'),
    ).not.toBeNull();

    // result: nothing is left to confirm, so the footer holds one Close.
    release({ headline: 'Signalled 47 of 47 workflows', errors: [] });
    await waitFor(() => {
      expect(view.getByText('Signalled 47 of 47 workflows')).not.toBeNull();
    });
    expect(footerCount()).toBe(1);
    expect(footerNames()).toEqual(['Close']);
  });

  test('a fault keeps the footer, with the callout above its one Close', async () => {
    const view = render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        runDryRun: async () => {
          throw new HttpClientError(500, 'Internal server error');
        },
        runCommit: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Retry' })).not.toBeNull();
    });
    expect(document.querySelectorAll('.cinder-modal__footer')).toHaveLength(1);
    expect(footerButtonNames()).toEqual(['Retry', 'Close']);
  });
});

describe('every fault is one callout with its re-run action in the same slot', () => {
  test('a failed dry run: one danger callout, Retry inside it, no footer re-run button', async () => {
    let dryRunCalls = 0;
    const view = render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        runDryRun: async () => {
          dryRunCalls += 1;
          if (dryRunCalls === 1) throw new HttpClientError(500, 'Internal server error');
          return preview();
        },
        runCommit: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });
    await waitFor(() => {
      expect(view.getByText('Internal server error')).not.toBeNull();
    });
    expect(callouts()).toHaveLength(1);
    expect(callouts()[0]?.getAttribute('data-cinder-variant')).toBe('danger');
    const retry = view.getByRole('button', { name: 'Retry' });
    expect(callouts()[0]?.contains(retry)).toBe(true);
    // The footer's own row holds Close alone.
    expect(
      Array.from(document.querySelectorAll('.cinder-confirm-dialog__actions button')).map(
        (button) => button.textContent?.trim(),
      ),
    ).toEqual(['Close']);

    await fireEvent.click(retry);
    await waitFor(() => {
      expect(view.getByLabelText(ACTION_PHRASE)).not.toBeNull();
    });
    // The fault is gone with the preview: no callout, no re-run action.
    expect(callouts()).toHaveLength(0);
  });

  test('a stale preview in a bulk action: one warning callout, Refresh preview inside it', async () => {
    const view = render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        runDryRun: async () => preview(),
        runCommit: async () => {
          throw new HttpClientError(409, 'Bulk confirmation token does not match', {
            faultCode: 'Conflict',
          });
        },
        onClose: () => {},
      },
    });
    await typeAndConfirm(view, ACTION_PHRASE, 'cancel 47 workflows', 'Cancel 47 workflows');
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Refresh preview' })).not.toBeNull();
    });
    expect(callouts()).toHaveLength(1);
    expect(callouts()[0]?.getAttribute('data-cinder-variant')).toBe('warning');
    expect(callouts()[0]?.contains(view.getByRole('button', { name: 'Refresh preview' }))).toBe(
      true,
    );
    expect(view.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Cancel 47 workflows' })).toBeNull();
  });

  test('a failed commit in a bulk action: one danger callout, Retry inside it, no armed confirm', async () => {
    const view = render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        runDryRun: async () => preview(),
        runCommit: async () => {
          throw new HttpClientError(500, 'Internal server error');
        },
        onClose: () => {},
      },
    });
    await typeAndConfirm(view, ACTION_PHRASE, 'cancel 47 workflows', 'Cancel 47 workflows');
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Retry' })).not.toBeNull();
    });
    expect(callouts()).toHaveLength(1);
    expect(callouts()[0]?.getAttribute('data-cinder-variant')).toBe('danger');
    expect(callouts()[0]?.contains(view.getByRole('button', { name: 'Retry' }))).toBe(true);
    expect(footerButtonNames()).toEqual(['Retry', 'Close']);
  });

  test('a stale preview in a purge: one warning callout, Refresh preview inside it', async () => {
    const view = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview({ action: 'purge' }),
        runPurge: async () => {
          throw new HttpClientError(409, 'Bulk confirmation token does not match', {
            faultCode: 'Conflict',
          });
        },
        onClose: () => {},
      },
    });
    await typeAndConfirm(view, PURGE_PHRASE, 'purge 47 workflows', 'Purge 47 workflows');
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Refresh preview' })).not.toBeNull();
    });
    expect(callouts()).toHaveLength(1);
    expect(callouts()[0]?.getAttribute('data-cinder-variant')).toBe('warning');
    expect(callouts()[0]?.contains(view.getByRole('button', { name: 'Refresh preview' }))).toBe(
      true,
    );
    expect(footerButtonNames()).toEqual(['Refresh preview', 'Close']);
  });

  test('a failed purge commit: one danger callout, Refresh preview inside it, never the same token', async () => {
    let purgeCalls = 0;
    const view = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview({ action: 'purge' }),
        runPurge: async () => {
          purgeCalls += 1;
          throw new HttpClientError(500, 'Purge deleted 30 workflows and failed for 17.');
        },
        onClose: () => {},
      },
    });
    await typeAndConfirm(view, PURGE_PHRASE, 'purge 47 workflows', 'Purge 47 workflows');
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Refresh preview' })).not.toBeNull();
    });
    expect(callouts()).toHaveLength(1);
    expect(callouts()[0]?.getAttribute('data-cinder-variant')).toBe('danger');
    expect(callouts()[0]?.contains(view.getByRole('button', { name: 'Refresh preview' }))).toBe(
      true,
    );
    expect(view.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(purgeCalls).toBe(1);
  });

  test('a failed purge dry run: one danger callout, Retry inside it', async () => {
    const view = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => {
          throw new HttpClientError(500, 'Internal server error');
        },
        runPurge: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Retry' })).not.toBeNull();
    });
    expect(callouts()).toHaveLength(1);
    expect(callouts()[0]?.getAttribute('data-cinder-variant')).toBe('danger');
    expect(callouts()[0]?.contains(view.getByRole('button', { name: 'Retry' }))).toBe(true);
    expect(footerButtonNames()).toEqual(['Retry', 'Close']);
  });
});

describe('a fault keeps what was asked (design round 1, B3)', () => {
  test('a failed commit still shows the count and the filter, under the title', async () => {
    const view = render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        runDryRun: async () => preview(),
        runCommit: async () => {
          throw new HttpClientError(500, 'Internal server error');
        },
        onClose: () => {},
      },
    });
    await typeAndConfirm(view, ACTION_PHRASE, 'cancel 47 workflows', 'Cancel 47 workflows');
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Retry' })).not.toBeNull();
    });
    expect(view.getByText('47 matching workflows')).not.toBeNull();
    expect(view.getByText('status:failed, type:payment-capture')).not.toBeNull();
    // The typed field is gone with the preview it confirmed: nothing is left to type.
    expect(view.queryByRole('textbox')).toBeNull();
  });

  test('a failed dry run has no count, but keeps what it is for and the filter, known before it', async () => {
    const view = render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        filterChip: 'status:failed',
        runDryRun: async () => {
          throw new HttpClientError(500, 'Internal server error');
        },
        runCommit: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.cinder-callout')).toHaveLength(1);
    });
    expect(view.getByText(BULK_DIALOG_COPY.purpose)).not.toBeNull();
    expect(view.getByText('status:failed')).not.toBeNull();
    // No count to name: nothing in it says "matching workflows" with a number.
    expect(view.queryByText(/\d+ matching workflow/)).toBeNull();
  });

  test('a failed dry run with no filter to show still has its purpose, and no empty chip', async () => {
    const view = render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        runDryRun: async () => {
          throw new HttpClientError(500, 'Internal server error');
        },
        runCommit: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });
    await waitFor(() => {
      expect(view.getByText(BULK_DIALOG_COPY.purpose)).not.toBeNull();
    });
    expect(document.querySelector('.cinder-confirm-dialog__options code')).toBeNull();
  });
});

describe('every fault has our own title, and the server message is the body (design round 2, item 5)', () => {
  const callout = (): HTMLElement =>
    requireElement(document.querySelector('.cinder-callout'), HTMLElement);
  const titleOf = (): string | null | undefined =>
    callout().querySelector('.cinder-callout__title')?.textContent;

  test('a failed dry run', async () => {
    render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        runDryRun: async () => {
          throw new HttpClientError(500, 'Internal server error');
        },
        runCommit: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.cinder-callout')).toHaveLength(1);
    });
    expect(titleOf()).toBe(BULK_DIALOG_COPY.dryRunFailed);
    expect(callout().textContent).toContain('Internal server error');
  });

  test('a failed commit in a bulk action names the verb', async () => {
    const view = render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        runDryRun: async () => preview(),
        runCommit: async () => {
          throw new HttpClientError(500, 'Internal server error');
        },
        onClose: () => {},
      },
    });
    await typeAndConfirm(view, ACTION_PHRASE, 'cancel 47 workflows', 'Cancel 47 workflows');
    await waitFor(() => {
      expect(document.querySelectorAll('.cinder-callout')).toHaveLength(1);
    });
    expect(titleOf()).toBe(BULK_DIALOG_COPY.commitFailed('cancel'));
    expect(titleOf()).not.toContain('Internal server error');
  });

  test('a partly done purge has the purge title, with the server message under it', async () => {
    const view = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview({ action: 'purge' }),
        runPurge: async () => {
          throw new HttpClientError(500, 'Purge deleted 30 workflows and failed for 17.');
        },
        onClose: () => {},
      },
    });
    await typeAndConfirm(view, PURGE_PHRASE, 'purge 47 workflows', 'Purge 47 workflows');
    await waitFor(() => {
      expect(document.querySelectorAll('.cinder-callout')).toHaveLength(1);
    });
    expect(titleOf()).toBe(BULK_PURGE_COPY.failed.title);
    expect(titleOf()).not.toContain('Purge deleted 30');
    expect(view.getByText('Purge deleted 30 workflows and failed for 17.')).not.toBeNull();
  });
});

describe('the bulk and purge flows word the same things the same way (design round 1, B5)', () => {
  test('one committing note', async () => {
    const hold = new Promise<BulkCommitSummary>(() => {});
    const action = render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        runDryRun: async () => preview(),
        runCommit: () => hold,
        onClose: () => {},
      },
    });
    await typeAndConfirm(action, ACTION_PHRASE, 'cancel 47 workflows', 'Cancel 47 workflows');
    await waitFor(() => {
      expect(action.getByText(BULK_DIALOG_COPY.committing)).not.toBeNull();
    });
    action.unmount();
    const purge = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview({ action: 'purge' }),
        runPurge: () => hold,
        onClose: () => {},
      },
    });
    await typeAndConfirm(purge, PURGE_PHRASE, 'purge 47 workflows', 'Purge 47 workflows');
    await waitFor(() => {
      expect(purge.getByText(BULK_DIALOG_COPY.committing)).not.toBeNull();
    });
  });

  test('one stale notice, never the server sentence as a title', async () => {
    const stale = async (): Promise<never> => {
      throw new HttpClientError(409, CONFLICT_SENTENCE, { faultCode: 'Conflict' });
    };
    const action = render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        runDryRun: async () => preview(),
        runCommit: stale,
        onClose: () => {},
      },
    });
    await typeAndConfirm(action, ACTION_PHRASE, 'cancel 47 workflows', 'Cancel 47 workflows');
    await waitFor(() => {
      expect(action.getByText(BULK_DIALOG_COPY.stale.title)).not.toBeNull();
    });
    expect(action.getByText(BULK_DIALOG_COPY.stale.body)).not.toBeNull();
    expect(action.queryByText(CONFLICT_SENTENCE)).toBeNull();
    action.unmount();
    const purge = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview({ action: 'purge' }),
        runPurge: stale,
        onClose: () => {},
      },
    });
    await typeAndConfirm(purge, PURGE_PHRASE, 'purge 47 workflows', 'Purge 47 workflows');
    await waitFor(() => {
      expect(purge.getByText(BULK_DIALOG_COPY.stale.title)).not.toBeNull();
    });
    expect(purge.getByText(BULK_DIALOG_COPY.stale.body)).not.toBeNull();
  });

  test('one zero-matches sentence, with its own subject and action', async () => {
    const action = render(BulkActionDialog, {
      props: {
        title: 'Bulk cancel',
        verb: 'cancel',
        runDryRun: async () => preview({ matched: 0 }),
        runCommit: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });
    await waitFor(() => {
      expect(action.getByText(BULK_DIALOG_COPY.nothingMatches('workflows', 'do'))).not.toBeNull();
    });
    action.unmount();
    const purge = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview({ action: 'purge', matched: 0 }),
        runPurge: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });
    await waitFor(() => {
      expect(
        purge.getByText(BULK_DIALOG_COPY.nothingMatches('finished workflows', 'purge')),
      ).not.toBeNull();
    });
  });
});

describe('the purge shows a few ids, so the typed field stays in view (design round 1, B2)', () => {
  test('at most five of the sample are listed, and the rest are counted', async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `wf-${String(index + 1)}`);
    const view = render(BulkPurgeDialog, {
      props: {
        runDryRun: async () => preview({ action: 'purge', sampleWorkflowIds: ids, matched: 47 }),
        runPurge: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });
    await waitFor(() => {
      expect(view.getByLabelText(PURGE_PHRASE)).not.toBeNull();
    });
    const list = view.getByRole('list', { name: 'These workflows will be deleted:' });
    expect(list.querySelectorAll('li')).toHaveLength(5);
    expect(view.getByText('…and 42 more.')).not.toBeNull();
  });
});

describe('the parameters phase', () => {
  test('Continue cannot be pressed until the parameters are valid', async () => {
    const view = render(BulkActionDialog, {
      props: {
        title: 'Bulk signal',
        verb: 'signal',
        destructive: false,
        parameters: createRawSnippet(() => ({ render: () => '<p>Signal name</p>' })),
        parametersValid: false,
        runDryRun: async () => preview(),
        runCommit: async () => ({ headline: 'unused', errors: [] }),
        onClose: () => {},
      },
    });
    expect(
      requireElement(view.getByRole('button', { name: 'Continue' }), HTMLButtonElement).disabled,
    ).toBe(true);
    await view.rerender({ parametersValid: true });
    await waitFor(() => {
      expect(
        requireElement(view.getByRole('button', { name: 'Continue' }), HTMLButtonElement).disabled,
      ).toBe(false);
    });
  });
});
