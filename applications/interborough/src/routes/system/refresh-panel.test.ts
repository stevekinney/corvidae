/**
 * Component tests for `<RefreshPanel>` (COR-166): what it shows from
 * `weft.workflows.refresh.diagnostics`, and every non-success state.
 * Actions and their outcomes live in `refresh-panel-actions.test.ts`.
 */
import { fireEvent, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  DIAGNOSTICS_METHOD,
  installedSource,
  renderRefreshPanel,
} from './refresh-panel-fixtures.test-support.ts';
import { ScriptedFetch, jsonRpcRequests } from './system-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

function definitionFor(term: HTMLElement): string {
  expect(term.tagName).toBe('DT');
  return (term.nextElementSibling?.textContent ?? '').trim();
}

describe('RefreshPanel', () => {
  test('shows the current and candidate identity, ETag, state, and last check from the operation', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, { sources: [installedSource()] });

    const { findByLabelText, findByText } = await renderRefreshPanel();
    const source = await findByLabelText('Refresh source order-processing');
    const inside = within(source);

    expect(await findByText('Installed, not activated')).not.toBeNull();
    expect(definitionFor(inside.getByText('Current revision'))).toBe('rev-1');
    expect(definitionFor(inside.getByText('Candidate revision'))).toBe('rev-2');
    expect(definitionFor(inside.getByText('ETag'))).toBe('sha256:etag-2');
    expect(definitionFor(inside.getByText('Current digest'))).not.toBe('Not reported');
    expect(definitionFor(inside.getByText('Candidate contract hash'))).not.toBe('Not reported');
    expect(definitionFor(inside.getByText('Last check'))).toContain('2023-11-14');
  });

  test('asks for exactly this workflow', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, { sources: [installedSource()] });

    const { findByLabelText } = await renderRefreshPanel();
    await findByLabelText('Refresh source order-processing');

    expect(jsonRpcRequests(scripted.calls, DIAGNOSTICS_METHOD).map((r) => r.params)).toEqual([
      { name: 'order-processing' },
    ]);
  });

  test('a manual-maintenance source shows no polling policy', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, { sources: [installedSource()] });

    const { findByText, queryByText } = await renderRefreshPanel();

    expect(await findByText('Manual maintenance')).not.toBeNull();
    expect(queryByText('Polling', { exact: true })).toBeNull();
    expect(queryByText('Maximum backoff')).toBeNull();
    expect(queryByText('Next check')).toBeNull();
  });

  test('a polling source shows the policy, backoff, and next check the server reports', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, {
      polling: {
        intervalMilliseconds: 60_000,
        maxBackoffMilliseconds: 900_000,
        backoffMilliseconds: 120_000,
        nextCheckAt: 1_700_000_030_000,
      },
      sources: [installedSource()],
    });

    const { findByText, getByText, queryByText } = await renderRefreshPanel();

    expect(await findByText('Polling', { exact: true })).not.toBeNull();
    expect(definitionFor(getByText('Interval'))).toBe('1m');
    expect(definitionFor(getByText('Maximum backoff'))).toBe('15m');
    expect(definitionFor(getByText('Current backoff'))).toBe('2m');
    expect(definitionFor(getByText('Next check'))).toContain('2023-11-14');
    expect(queryByText('Manual maintenance')).toBeNull();
  });

  test('a failed source names the bounded reason in words', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, {
      sources: [installedSource({ state: 'failed', reason: 'integrity' })],
    });

    const { findByText } = await renderRefreshPanel();

    expect(await findByText(/Last check failed: Integrity check failed/)).not.toBeNull();
    expect(await findByText('Failed')).not.toBeNull();
  });

  test('a source that was never checked reads Never checked, with no candidate', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, {
      sources: [{ name: 'order-processing', state: 'idle' }],
    });

    const { findByText, queryByRole } = await renderRefreshPanel();

    expect(await findByText('Never checked')).not.toBeNull();
    expect(await findByText('No candidate')).not.toBeNull();
    expect(queryByRole('button', { name: 'Activate candidate' })).toBeNull();
  });

  test('offers Activate candidate only while a candidate is not the active revision', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, { sources: [installedSource()] });
    const pending = await renderRefreshPanel();
    expect(await pending.findByRole('button', { name: 'Activate candidate' })).not.toBeNull();
    pending.unmount();

    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, {
      sources: [
        installedSource({
          candidate: { revision: 'rev-1', digest: 'sha256:d', contractHash: 'sha256:c' },
        }),
      ],
    });
    const settled = await renderRefreshPanel();
    await settled.findByText('Candidate revision');

    expect(settled.queryByRole('button', { name: 'Activate candidate' })).toBeNull();
  });

  test('a failed check with no candidate never offers Activate candidate', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, {
      sources: [
        {
          name: 'order-processing',
          state: 'failed',
          reason: 'warming',
          current: { revision: 'rev-1', generation: 3 },
        },
      ],
    });

    const { findByText, queryByRole } = await renderRefreshPanel();
    await findByText(/Last check failed: Warming failed/);

    expect(queryByRole('button', { name: 'Activate candidate' })).toBeNull();
  });

  test('an installed candidate followed by a 304 stays activatable', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, {
      sources: [installedSource({ state: 'not-modified' })],
    });

    const { findByRole, findByText } = await renderRefreshPanel();

    expect(await findByText('Not modified')).not.toBeNull();
    expect(await findByRole('button', { name: 'Activate candidate' })).not.toBeNull();
  });

  test('shows an empty state when no refresh source is registered', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, { sources: [] });

    const { findByText } = await renderRefreshPanel();

    expect(await findByText(/No refresh source is registered for this workflow/)).not.toBeNull();
  });

  test('shows a loading status before the answer arrives', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcDeferred(DIAGNOSTICS_METHOD, new Promise(() => {}));

    const { getByRole } = await renderRefreshPanel();

    expect(getByRole('status', { name: 'Loading refresh sources' })).not.toBeNull();
  });

  test('without workflows:read it says so and asks the server nothing', async () => {
    scripted = new ScriptedFetch();

    const { getByText } = await renderRefreshPanel(['workflows:admin']);

    expect(getByText('Requires workflows:read to view refresh sources.')).not.toBeNull();
    expect(jsonRpcRequests(scripted.calls, DIAGNOSTICS_METHOD)).toHaveLength(0);
  });

  test('shows the denial when the server refuses the read', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcError(DIAGNOSTICS_METHOD, {
      code: -32003,
      message: 'Requires workflows:read.',
      data: { httpStatus: 403, weftCode: 'Forbidden' },
    });

    const { findByText } = await renderRefreshPanel();

    expect(await findByText('Not authorized')).not.toBeNull();
  });

  test('shows a server fault with a retry', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcError(DIAGNOSTICS_METHOD, {
      code: -32004,
      message: 'The refresh read is unavailable.',
      data: { httpStatus: 404, weftCode: 'NotFound' },
    });

    const { findByRole } = await renderRefreshPanel();
    const panel = await findByRole('region', { name: 'Conditional refresh' });

    expect(await within(panel).findByRole('button', { name: 'Retry' })).not.toBeNull();
  });

  test('shows a malformed-response alert, and no source, for an unrecognized payload', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, { sources: [{ name: 'order-processing' }] });

    const { findByRole, queryByText } = await renderRefreshPanel();
    const panel = await findByRole('region', { name: 'Conditional refresh' });
    const alert = await within(panel).findByRole('alert');

    await waitFor(() => expect(alert.textContent).toContain("doesn't recognize"));
    expect(queryByText('Current revision')).toBeNull();
  });

  test('keeps the last answer on screen, and says it is stale, when a re-read fails', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, { sources: [installedSource()] });
    scripted.routeJsonRpcMethod('weft.workflows.refresh', { status: 'not-modified' });

    const { findByRole, findByText } = await renderRefreshPanel();
    await findByText('Candidate revision');
    scripted.routeJsonRpcError(DIAGNOSTICS_METHOD, {
      code: -32004,
      message: 'The refresh read is unavailable.',
      data: { httpStatus: 404, weftCode: 'NotFound' },
    });
    await fireEvent.click(await findByRole('button', { name: 'Check now' }));

    expect(
      await findByText('Showing the last answer. Re-reading the refresh sources failed.'),
    ).not.toBeNull();
    expect(await findByText('Candidate revision')).not.toBeNull();
  });
});
