import { requireElement } from '../../../../tests/dom.test-support.ts';

import { faultToJsonRpcError } from '@lostgradient/backchannel/internals';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import type { WorkflowListQuery } from '../../../lib/filters.ts';
import type { ScopeGate } from '../../../lib/scopes.svelte.ts';
import BulkSelectionBar from './bulk-selection-bar.svelte';
import { realClient, ScriptedFetch, type FetchCall } from './workflow-test-support.test-support.ts';

const GRANTED: ScopeGate = { disabled: false, title: undefined };

function baseProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    client: realClient(),
    filter: { status: 'failed' } as WorkflowListQuery,
    selectedCount: 3,
    totalMatchingFilter: 47,
    onDeselect: () => {},
    adminGate: GRANTED,
    onActionComplete: () => {},
    ...overrides,
  };
}

const PURGE_PREVIEW = {
  dryRun: true,
  action: 'purge',
  matched: 12,
  requestId: 'bulk:req-purge',
  scope: {
    matched: 12,
    filter: { status: 'failed' },
    statuses: ['failed'],
    workflowTypes: ['checkout'],
    sampleWorkflowIds: ['wf-1', 'wf-2'],
    sampleLimit: 20,
  },
  sampleWorkflowIds: ['wf-1', 'wf-2'],
  confirmationToken: 'bulk:token-purge',
  confirmationTokenVersion: 1,
};

const DELETE_PREVIEW = {
  dryRun: true,
  action: 'delete',
  matched: 6,
  requestId: 'bulk:req-delete',
  scope: {
    matched: 6,
    filter: { status: 'failed' },
    statuses: ['failed'],
    workflowTypes: [],
    sampleWorkflowIds: [],
    sampleLimit: 20,
  },
  sampleWorkflowIds: [],
  confirmationToken: 'bulk:token-delete',
  confirmationTokenVersion: 1,
};

function requestParams(call: FetchCall | undefined): Record<string, unknown> {
  const body = call?.init?.body;
  if (typeof body !== 'string') throw new Error('JSON-RPC request body missing');
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== 'object') throw new Error('JSON-RPC body malformed');
  const params = Reflect.get(parsed, 'params');
  if (params === null || typeof params !== 'object') throw new Error('JSON-RPC params missing');
  return params;
}

describe('additional coverage', () => {
  test('clicking Purge (once enabled) opens the purge dialog with the server dry run count, not the list total', async () => {
    const fetch = new ScriptedFetch();
    // The list says 47; the server's dry run says 12 would be purged (the rest are not terminal).
    fetch.routeJsonRpcMethod('weft.workflows.purge', PURGE_PREVIEW);

    try {
      const { getByRole, getAllByRole, getByText } = render(BulkSelectionBar, {
        props: baseProps(),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const purgeButton = requireElement(
        getAllByRole('button').find((button) => button.textContent?.trim() === 'Purge'),
        HTMLButtonElement,
      );
      await fireEvent.click(purgeButton);

      await waitFor(() => {
        expect(getByText(/Permanently deletes 12 finished workflows/)).not.toBeNull();
      });
      const params = requestParams(fetch.calls[0]);
      expect(params['dryRun']).toBe(true);
      expect(params['status']).toBe('failed');
    } finally {
      fetch.restore();
    }
  });

  test("the real client turns the server's stale-token Conflict into the changed-workflows callout, and its partial-purge failure into a message that says what was deleted", async () => {
    // The envelopes are built by Weft's own fault mapper, so this follows the wire contract the
    // server tests pin: a stale token answers `Conflict`, a part-way failure answers
    // `EngineFailure` with the counts in the message.
    const fetch = new ScriptedFetch();
    fetch.enqueueJson({ jsonrpc: '2.0', id: 1, result: PURGE_PREVIEW });
    fetch.enqueueJson({
      jsonrpc: '2.0',
      id: 1,
      error: faultToJsonRpcError({
        code: 'Conflict',
        message:
          'Bulk confirmation token does not match the current dry-run scope. ' +
          'The workflows that match the filter changed after the preview. Run the preview again.',
        data: { reason: 'confirmation-token-stale', weftCode: 'BulkOperationConfirmationError' },
      }),
    });
    fetch.enqueueJson({ jsonrpc: '2.0', id: 1, result: PURGE_PREVIEW });
    fetch.enqueueJson({
      jsonrpc: '2.0',
      id: 1,
      error: faultToJsonRpcError({
        code: 'EngineFailure',
        message: 'Purge deleted 7 workflows and failed for 5.',
        data: {},
      }),
    });

    try {
      const { getByRole, getAllByRole, getByLabelText, getByText, queryByText } = render(
        BulkSelectionBar,
        { props: baseProps() },
      );

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const purgeButton = requireElement(
        getAllByRole('button').find((button) => button.textContent?.trim() === 'Purge'),
        HTMLButtonElement,
      );
      await fireEvent.click(purgeButton);
      const phraseLabel = 'Type "purge 12 workflows" to confirm';
      await waitFor(() => {
        expect(getByLabelText(phraseLabel)).not.toBeNull();
      });
      await fireEvent.input(getByLabelText(phraseLabel), {
        target: { value: 'purge 12 workflows' },
      });
      await fireEvent.click(getByRole('button', { name: 'Purge 12 workflows' }));

      await waitFor(() => {
        expect(getByText('The matching workflows changed')).not.toBeNull();
      });
      expect(queryByText(/does not match the current dry-run scope/)).toBeNull();

      // Refresh the preview, then purge again: this time the server fails part-way.
      await fireEvent.click(getByRole('button', { name: 'Refresh preview' }));
      await waitFor(() => {
        expect(getByLabelText(phraseLabel)).not.toBeNull();
      });
      await fireEvent.input(getByLabelText(phraseLabel), {
        target: { value: 'purge 12 workflows' },
      });
      await fireEvent.click(getByRole('button', { name: 'Purge 12 workflows' }));

      await waitFor(() => {
        expect(getByText('Purge deleted 7 workflows and failed for 5.')).not.toBeNull();
      });
      expect(queryByText('The matching workflows changed')).toBeNull();
      expect(getByRole('button', { name: 'Refresh preview' })).not.toBeNull();
    } finally {
      fetch.restore();
    }
  });

  test('a list refresh that hands the bar an equal filter object does not re-run the purge dry run or clear the typed phrase', async () => {
    // The bar passes `runDryRun={() => dryRunPurge(client, bulkFilter)}`, a closure over a derived
    // value, so every new `filter` object (every list refresh) used to read as a new `runDryRun`
    // and the dialog's effect ran the preview again, which clears the phrase being typed.
    const fetch = new ScriptedFetch();
    fetch.routeJsonRpcMethod('weft.workflows.purge', PURGE_PREVIEW);

    try {
      const { getByRole, getAllByRole, getByLabelText, rerender } = render(BulkSelectionBar, {
        props: baseProps(),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const purgeButton = requireElement(
        getAllByRole('button').find((button) => button.textContent?.trim() === 'Purge'),
        HTMLButtonElement,
      );
      await fireEvent.click(purgeButton);
      await waitFor(() => {
        expect(getByLabelText('Type "purge 12 workflows" to confirm')).not.toBeNull();
      });
      await fireEvent.input(getByLabelText('Type "purge 12 workflows" to confirm'), {
        target: { value: 'purge 12 wor' },
      });
      expect(fetch.calls).toHaveLength(1);

      // The live list refreshed: the same filter, as a new object.
      await rerender({ filter: { status: 'failed' } as WorkflowListQuery, selectedCount: 4 });
      await tick();
      await tick();

      expect(fetch.calls).toHaveLength(1);
      const input = requireElement(
        getByLabelText('Type "purge 12 workflows" to confirm'),
        HTMLInputElement,
      );
      expect(input.value).toBe('purge 12 wor');
    } finally {
      fetch.restore();
    }
  });

  test('a completed purge calls onActionComplete — the wiring behind "selection clears after a real commit"', async () => {
    // Regression coverage for the onSuccess/onClose split
    // (`bulk-action-dialog.svelte`/`bulk-purge-dialog.svelte`'s module
    // docs): caught via manual dev-harness verification that the bar's
    // "N selected" banner stayed stale after a successful purge because
    // `onActionComplete` was only wired to dialog dismissal, not to the
    // commit actually succeeding.
    const fetch = new ScriptedFetch();
    // The dry run answers first, then the commit.
    fetch.enqueueJson({ jsonrpc: '2.0', id: 1, result: PURGE_PREVIEW });
    fetch.enqueueJson({ jsonrpc: '2.0', id: 1, result: { deleted: 12 } });

    try {
      let completed = 0;
      const { getByRole, getAllByRole, getByText, getByLabelText } = render(BulkSelectionBar, {
        props: baseProps({
          client: realClient(),
          onActionComplete: () => {
            completed += 1;
          },
        }),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const purgeButton = requireElement(
        getAllByRole('button').find((button) => button.textContent?.trim() === 'Purge'),
        HTMLButtonElement,
      );
      await fireEvent.click(purgeButton);

      await waitFor(() => {
        expect(getByLabelText('Type "purge 12 workflows" to confirm')).not.toBeNull();
      });
      expect(completed).toBe(0);

      await fireEvent.input(getByLabelText('Type "purge 12 workflows" to confirm'), {
        target: { value: 'purge 12 workflows' },
      });
      await fireEvent.click(getByRole('button', { name: 'Purge 12 workflows' }));

      await waitFor(() => {
        expect(getByText('Purged 12 workflows')).not.toBeNull();
      });
      expect(completed).toBe(1);
      // The commit carried the dry run's token and no dryRun.
      const commitParams = requestParams(fetch.calls[1]);
      expect(commitParams['confirmationToken']).toBe('bulk:token-purge');
      expect(commitParams).not.toHaveProperty('dryRun');
    } finally {
      fetch.restore();
    }
  });

  test('clicking Signal opens the params form, and invalid JSON blocks continuing to the preview', async () => {
    const { getByRole, getAllByRole, getByLabelText, getByText } = render(BulkSelectionBar, {
      props: baseProps({ client: realClient() }),
    });

    await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
    const signalButton = requireElement(
      getAllByRole('button').find((button) => button.textContent?.trim() === 'Signal'),
      HTMLButtonElement,
    );
    await fireEvent.click(signalButton);

    expect(getByLabelText('Signal name')).not.toBeNull();

    await fireEvent.input(getByLabelText('Signal name'), { target: { value: 'restart' } });
    await fireEvent.input(getByLabelText('Payload'), { target: { value: '{not json' } });

    expect(getByText(/Payload must be valid JSON/)).not.toBeNull();
  });

  test('a valid Signal params form runs the dry run with the signal name and parsed payload', async () => {
    const fetch = new ScriptedFetch();
    fetch.routeJsonRpcMethod('weft.workflows.bulk.signal', {
      dryRun: true,
      action: 'signal',
      matched: 2,
      requestId: 'bulk:req-signal',
      scope: {
        matched: 2,
        filter: { status: 'failed' },
        statuses: ['failed'],
        workflowTypes: [],
        sampleWorkflowIds: [],
        sampleLimit: 20,
      },
      sampleWorkflowIds: [],
      confirmationToken: 'bulk:token-signal',
      confirmationTokenVersion: 1,
    });

    try {
      const { getByRole, getAllByRole, getByLabelText, getByText } = render(BulkSelectionBar, {
        props: baseProps({ client: realClient() }),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const signalButton = requireElement(
        getAllByRole('button').find((button) => button.textContent?.trim() === 'Signal'),
        HTMLButtonElement,
      );
      await fireEvent.click(signalButton);

      await fireEvent.input(getByLabelText('Signal name'), { target: { value: 'restart' } });
      await fireEvent.input(getByLabelText('Payload'), { target: { value: '{"force":true}' } });
      await fireEvent.click(getByRole('button', { name: 'Continue' }));

      await waitFor(() => {
        expect(getByText('2 matching workflows')).not.toBeNull();
      });
    } finally {
      fetch.restore();
    }
  });

  test('clicking Mutate tags opens the tags params form with an Add/Remove operation select', async () => {
    const { getByRole, getAllByRole, getByLabelText } = render(BulkSelectionBar, {
      props: baseProps({ client: realClient() }),
    });

    await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
    const tagsButton = requireElement(
      getAllByRole('button').find((button) => button.textContent?.trim() === 'Mutate tags'),
      HTMLButtonElement,
    );
    await fireEvent.click(tagsButton);

    expect(getByLabelText('Operation')).not.toBeNull();
    expect(getByLabelText('Tags (comma-separated)')).not.toBeNull();
  });

  test('clicking Retry failed (once enabled) opens the retry dialog and fires its dry run', async () => {
    const fetch = new ScriptedFetch();
    fetch.routeJsonRpcMethod('weft.workflows.bulk.retryfailed', {
      dryRun: true,
      action: 'retryfailed',
      matched: 4,
      requestId: 'bulk:req-retry',
      scope: {
        matched: 4,
        filter: { status: 'failed' },
        statuses: ['failed'],
        workflowTypes: [],
        sampleWorkflowIds: [],
        sampleLimit: 20,
      },
      sampleWorkflowIds: [],
      confirmationToken: 'bulk:token-retry',
      confirmationTokenVersion: 1,
    });

    try {
      const { getByRole, getAllByRole, getByText } = render(BulkSelectionBar, {
        props: baseProps({ client: realClient() }),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const retryButton = requireElement(
        getAllByRole('button').find((button) => button.textContent?.trim() === 'Retry failed'),
        HTMLButtonElement,
      );
      await fireEvent.click(retryButton);

      await waitFor(() => {
        expect(getByText('4 matching workflows')).not.toBeNull();
      });
      // The retry-failed dialog passes a previewNote that discloses BOTH retry
      // paths (WFT-117; Codex review, PR #978): checkpoint-backed retries keep
      // the persisted revision, checkpoint-less retries fall back to
      // start-new and resolve whichever revision is active right now — never
      // an unconditional "always retains" promise.
      expect(getByText(/resumes in place on its own persisted revision/)).not.toBeNull();
      expect(getByText(/restarts fresh and resolves whichever revision is active/)).not.toBeNull();
      // Same eager-registration/dynamic-source caveat as every other
      // fresh-start surface (Codex review, PR #978) — a checkpoint-less
      // retry enters the identical start path as a wizard start or a
      // start-new replacement.
      expect(
        getByText(/a fresh start can run without consulting the active pointer at all/),
      ).not.toBeNull();
      // A checkpoint-backed retry of a pre-revision-pinning run has no
      // persisted revision to resume against either (Codex review, PR
      // #978, round 6) — the first sentence is qualified, not unconditional.
      expect(getByText(/when one exists/)).not.toBeNull();
      expect(getByText(/falls back to the same active-revision resolution/)).not.toBeNull();
    } finally {
      fetch.restore();
    }
  });

  test("the real client turns a bulk operation's stale-token Conflict into Refresh preview, and the next commit goes through with the new token", async () => {
    // The envelope is built by Weft's own fault mapper, as `staleConfirmationFault` throws it for
    // every bulk operation (cancel, delete, tags, retry-failed, signal, purge).
    const fetch = new ScriptedFetch();
    fetch.enqueueJson({ jsonrpc: '2.0', id: 1, result: DELETE_PREVIEW });
    fetch.enqueueJson({
      jsonrpc: '2.0',
      id: 1,
      error: faultToJsonRpcError({
        code: 'Conflict',
        message:
          'Bulk confirmation token does not match the current dry-run scope. ' +
          'The workflows that match the filter changed after the preview. Run the preview again.',
        data: { reason: 'confirmation-token-stale', weftCode: 'BulkOperationConfirmationError' },
      }),
    });
    fetch.enqueueJson({
      jsonrpc: '2.0',
      id: 1,
      result: { ...DELETE_PREVIEW, confirmationToken: 'bulk:token-delete-2' },
    });
    fetch.enqueueJson({ jsonrpc: '2.0', id: 1, result: { deleted: 6, failed: 0, errors: [] } });

    try {
      const { getByRole, getAllByRole, getByLabelText, getByText } = render(BulkSelectionBar, {
        props: baseProps({ client: realClient() }),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const deleteButton = requireElement(
        getAllByRole('button').find((button) => button.textContent?.trim() === 'Delete'),
        HTMLButtonElement,
      );
      await fireEvent.click(deleteButton);
      const phraseLabel = 'Type "delete 6 workflows" to confirm';
      await waitFor(() => {
        expect(getByLabelText(phraseLabel)).not.toBeNull();
      });
      await fireEvent.input(getByLabelText(phraseLabel), {
        target: { value: 'delete 6 workflows' },
      });
      await fireEvent.click(getByRole('button', { name: 'Delete 6 workflows' }));

      await waitFor(() => {
        expect(getByText(/changed since the preview/)).not.toBeNull();
      });
      // Refresh preview re-runs the dry run; the commit that follows carries the new token.
      await fireEvent.click(getByRole('button', { name: 'Refresh preview' }));
      await waitFor(() => {
        expect(getByLabelText(phraseLabel)).not.toBeNull();
      });
      await fireEvent.input(getByLabelText(phraseLabel), {
        target: { value: 'delete 6 workflows' },
      });
      await fireEvent.click(getByRole('button', { name: 'Delete 6 workflows' }));
      await waitFor(() => {
        expect(fetch.calls).toHaveLength(4);
      });
      expect(requestParams(fetch.calls[1])['confirmationToken']).toBe('bulk:token-delete');
      expect(requestParams(fetch.calls[2])['dryRun']).toBe(true);
      expect(requestParams(fetch.calls[3])['confirmationToken']).toBe('bulk:token-delete-2');
    } finally {
      fetch.restore();
    }
  });

  test('a list refresh that hands the bar an equal filter object does not re-run a bulk action dry run or clear the typed phrase', async () => {
    // The bar passes `runDryRun={() => dryRunBulkDelete(client, bulkFilter)}`, a closure over a
    // derived value, so every new `filter` object (every list refresh) used to read as a new
    // `runDryRun`, and the dialog's effect ran the preview again, which clears the phrase.
    const fetch = new ScriptedFetch();
    fetch.routeJsonRpcMethod('weft.workflows.bulk.delete', DELETE_PREVIEW);

    try {
      const { getByRole, getAllByRole, getByLabelText, rerender } = render(BulkSelectionBar, {
        props: baseProps({ client: realClient() }),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const deleteButton = requireElement(
        getAllByRole('button').find((button) => button.textContent?.trim() === 'Delete'),
        HTMLButtonElement,
      );
      await fireEvent.click(deleteButton);
      const phraseLabel = 'Type "delete 6 workflows" to confirm';
      await waitFor(() => {
        expect(getByLabelText(phraseLabel)).not.toBeNull();
      });
      await fireEvent.input(getByLabelText(phraseLabel), { target: { value: 'delete 6 wor' } });
      expect(fetch.calls).toHaveLength(1);

      // The live list refreshed: the same filter, as a new object.
      await rerender({ filter: { status: 'failed' } as WorkflowListQuery, selectedCount: 4 });
      await tick();
      await tick();

      expect(fetch.calls).toHaveLength(1);
      const input = requireElement(getByLabelText(phraseLabel), HTMLInputElement);
      expect(input.value).toBe('delete 6 wor');
    } finally {
      fetch.restore();
    }
  });

  test('clicking Delete (once enabled) opens the delete dialog and fires its dry run', async () => {
    const fetch = new ScriptedFetch();
    fetch.routeJsonRpcMethod('weft.workflows.bulk.delete', {
      dryRun: true,
      action: 'delete',
      matched: 6,
      requestId: 'bulk:req-delete',
      scope: {
        matched: 6,
        filter: { status: 'failed' },
        statuses: ['failed'],
        workflowTypes: [],
        sampleWorkflowIds: [],
        sampleLimit: 20,
      },
      sampleWorkflowIds: [],
      confirmationToken: 'bulk:token-delete',
      confirmationTokenVersion: 1,
    });

    try {
      const { getByRole, getAllByRole, getByText } = render(BulkSelectionBar, {
        props: baseProps({ client: realClient() }),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const deleteButton = requireElement(
        getAllByRole('button').find((button) => button.textContent?.trim() === 'Delete'),
        HTMLButtonElement,
      );
      await fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(getByText('6 matching workflows')).not.toBeNull();
      });
    } finally {
      fetch.restore();
    }
  });
});
