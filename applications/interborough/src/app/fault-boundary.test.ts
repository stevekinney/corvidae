/**
 * Component tests for `<FaultBoundary>` (plan §10.4, §11.2, T1.5). Run with
 * `--conditions browser --conditions svelte` (repo-wide `bun run test`) —
 * see `tests/setup.ts`. Drives the boundary through a real `<svelte:boundary>`
 * via `fault-boundary.test-harness.svelte` rather than mocking it: a
 * `<svelte:boundary>` error handler is compiled Svelte template behavior,
 * not something that survives being stubbed.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';

import type { FaultTreatment } from '../lib/faults.ts';
import { RETRY_LABEL } from './copy/views.ts';
import FaultBoundaryHarness from './fault-boundary.test-harness.svelte';

async function renderHarness(props: {
  error: unknown;
  shouldThrow?: boolean;
  onFault?: (treatment: FaultTreatment, error: unknown) => void;
}) {
  return render(FaultBoundaryHarness, { props });
}

/**
 * The tone and role of the Cinder `ErrorState` a fault is drawn on: a failure is `danger` and its
 * body is an alert; a fault of the neutral tone (`not-found`, `not-supported`) is a plain group that
 * the box around it announces as the alert, so every kind is one.
 */
function rowOf(container: HTMLElement): { tone: string | null; role: string | null } {
  return {
    tone: container.querySelector('.cinder-error-state')?.getAttribute('data-cinder-tone') ?? null,
    role: container.querySelector('.cinder-error-state-body')?.getAttribute('role') ?? null,
  };
}

describe('FaultBoundary', () => {
  test('renders children normally when nothing throws', async () => {
    const { findByTestId, queryByRole } = await renderHarness({
      error: new HttpClientError(404, 'not found'),
      shouldThrow: false,
    });

    expect(await findByTestId('recovered')).not.toBeNull();
    expect(queryByRole('alert')).toBeNull();
  });

  test('not-found: shows the banner with the server message', async () => {
    const { container, findByRole, findByText } = await renderHarness({
      error: new HttpClientError(404, 'workflow wf-1 not found'),
    });

    const banner = await findByRole('alert');
    expect(banner.getAttribute('data-tone')).toBe('neutral');
    expect(await findByText('Not found')).not.toBeNull();
    expect(await findByText('workflow wf-1 not found')).not.toBeNull();
    // Cinder's neutral tone is a plain group, which the announcing box wraps.
    expect(rowOf(container)).toEqual({ tone: 'neutral', role: 'group' });
  });

  test('conflict: spent idempotency key shows the extra explanation', async () => {
    const error = new HttpClientError(409, 'a workflow with this id was already started', {
      faultCode: 'Conflict',
      weftCode: 'IdempotencyKeyPurgedError',
    });
    const { container, findByRole, findByText } = await renderHarness({ error });

    await findByRole('alert');
    expect(rowOf(container)).toEqual({ tone: 'danger', role: 'alert' });
    expect(await findByText('Conflict')).not.toBeNull();
    expect(
      await findByText(
        'This idempotency key has already been used and its run was purged — start with a new key.',
        { exact: false },
      ),
    ).not.toBeNull();
  });

  test('conflict: a plain conflict does not show the spent-key explanation', async () => {
    const error = new HttpClientError(409, 'plain conflict', { faultCode: 'Conflict' });
    const { findByRole, queryByText } = await renderHarness({ error });

    await findByRole('alert');
    expect(queryByText('This idempotency key has already been used', { exact: false })).toBeNull();
  });

  test('invalid: shows the invalid-input badge', async () => {
    const error = new HttpClientError(400, 'invalid params', { faultCode: 'InvalidParams' });
    const { container, findByRole, findByText } = await renderHarness({ error });

    await findByRole('alert');
    expect(rowOf(container).tone).toBe('danger');
    expect(await findByText('Invalid input')).not.toBeNull();
  });

  test('unauthorized (401): shows the not-authorized badge with the server message', async () => {
    const error = new HttpClientError(401, 'no credential', { faultCode: 'Unauthorized' });
    const { container, findByRole, findByText } = await renderHarness({ error });

    await findByRole('alert');
    expect(rowOf(container).tone).toBe('danger');
    expect(await findByText('Not authorized')).not.toBeNull();
    expect(await findByText('no credential')).not.toBeNull();
  });

  test('unauthorized (403): shows the same not-authorized badge with its own server message', async () => {
    const error = new HttpClientError(403, 'scope denied', { faultCode: 'Forbidden' });
    const { container, findByRole, findByText } = await renderHarness({ error });

    await findByRole('alert');
    expect(rowOf(container).tone).toBe('danger');
    expect(await findByText('scope denied')).not.toBeNull();
  });

  test('not-supported: shows the not-supported badge', async () => {
    const error = new HttpClientError(501, 'not implemented', { faultCode: 'NotImplemented' });
    const { container, findByRole, findByText } = await renderHarness({ error });

    const banner = await findByRole('alert');
    expect(banner.getAttribute('data-tone')).toBe('neutral');
    expect(await findByText('Not supported')).not.toBeNull();
    expect(rowOf(container).tone).toBe('neutral');
  });

  test('internal: REST-masked 500 shows the try-via-JSON-RPC hint', async () => {
    const error = new HttpClientError(500, 'Internal server error');
    const { container, findByRole, findByText } = await renderHarness({ error });

    await findByRole('alert');
    expect(rowOf(container).tone).toBe('danger');
    expect(await findByText('Something went wrong')).not.toBeNull();
    expect(
      await findByText('The REST API hides internal error detail', { exact: false }),
    ).not.toBeNull();
  });

  test('internal: an unmasked fault (real faultCode) does not show the try-via-JSON-RPC hint', async () => {
    const error = new HttpClientError(500, 'engine failure', { faultCode: 'EngineFailure' });
    const { findByRole, queryByText } = await renderHarness({ error });

    await findByRole('alert');
    expect(queryByText('The REST API hides internal error detail', { exact: false })).toBeNull();
  });

  test('internal: a plain Error (not a wire fault) shows a collapsible stack-trace trigger', async () => {
    // Cinder's own `collapsible.test.ts` already covers click-to-open — this
    // only proves FaultBoundary wires the trigger for the right error shape.
    const error = new Error('capturePayment threw');
    error.name = 'PaymentDeclinedError';
    const { findByRole, findByText } = await renderHarness({ error });

    await findByRole('alert');
    expect(await findByText('PaymentDeclinedError')).not.toBeNull();
  });

  test("internal: an HttpClientError does NOT show a stack-trace trigger (its .stack is only client-side plumbing, never the server's)", async () => {
    const error = new HttpClientError(500, 'Internal server error');
    const { findByRole, getAllByRole } = await renderHarness({ error });

    await findByRole('alert');
    // The banner's Retry button is the only button — no Collapsible trigger
    // (which would be named after `error.name`, `'HttpClientError'`) exists.
    const buttons = getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent?.trim()).toBe(RETRY_LABEL);
  });

  test('onFault reports the classified treatment and the raw error exactly once, before the banner is interactive', async () => {
    const error = new HttpClientError(404, 'not found');
    const reported: Array<{ treatment: FaultTreatment; error: unknown }> = [];
    const { findByRole } = await renderHarness({
      error,
      onFault: (treatment, raisedError) => reported.push({ treatment, error: raisedError }),
    });

    await findByRole('alert');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toBe(error);
    expect(reported[0]?.treatment).toEqual({ kind: 'not-found', message: 'not found' });
  });

  test('Retry re-renders the children once the underlying issue is fixed', async () => {
    const error = new HttpClientError(404, 'not found');
    const { findByRole, findByTestId, rerender, queryByRole } = await renderHarness({ error });

    const banner = await findByRole('alert');
    expect(banner).not.toBeNull();

    await rerender({ error, shouldThrow: false });
    // Merely fixing the underlying condition does not recover on its own —
    // the boundary only re-renders children when `reset()` runs.
    expect(await findByRole('alert')).not.toBeNull();

    await fireEventClick(await findByRole('button', { name: RETRY_LABEL }));

    expect(await findByTestId('recovered')).not.toBeNull();
    expect(queryByRole('alert')).toBeNull();
  });

  describe('remediation and Retry (COR-2560)', () => {
    const REMEDIATION = 'Check that the server is running, then try again.';

    test('shows the fault’s remediation as its own line under the description, never as the title', async () => {
      const error = new HttpClientError(503, 'The server is restarting.', {
        retryable: true,
        remediation: REMEDIATION,
      });
      const { container, findByText } = await renderHarness({ error });

      const remediation = await findByText(REMEDIATION);
      expect(remediation.classList.contains('cinder-error-state-remediation')).toBe(true);
      const title = container.querySelector('.cinder-error-state-title');
      expect(title?.textContent?.trim()).toBe('Something went wrong');
      expect(title?.textContent).not.toContain(REMEDIATION);
      // Description, then remediation, in reading order.
      const description = await findByText('The server is restarting.');
      expect(
        description.compareDocumentPosition(remediation) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    test('shows no remediation line when the fault carries none', async () => {
      const error = new HttpClientError(503, 'The server is restarting.');
      const { container, findByText } = await renderHarness({ error });

      await findByText('The server is restarting.');
      expect(container.querySelector('.cinder-error-state-remediation')).toBeNull();
    });

    test('offers Retry for a retryable fault', async () => {
      const error = new HttpClientError(503, 'Unavailable', { retryable: true });
      const { findByRole } = await renderHarness({ error });

      expect(await findByRole('button', { name: RETRY_LABEL })).not.toBeNull();
    });

    test('offers Retry for a fault that says nothing about retrying', async () => {
      const error = new HttpClientError(503, 'Unavailable');
      const { findByRole } = await renderHarness({ error });

      expect(await findByRole('button', { name: RETRY_LABEL })).not.toBeNull();
    });

    test('offers no Retry for a fault that is not retryable, and still shows its remediation', async () => {
      const error = new HttpClientError(409, 'The workflow changed.', {
        retryable: false,
        remediation: 'Read the workflow again, then send the new revision.',
      });
      const { findByText, queryByRole } = await renderHarness({ error });

      expect(
        await findByText('Read the workflow again, then send the new revision.'),
      ).not.toBeNull();
      expect(queryByRole('button', { name: RETRY_LABEL })).toBeNull();
    });
  });
});

async function fireEventClick(element: Element): Promise<void> {
  await fireEvent.click(element);
}
