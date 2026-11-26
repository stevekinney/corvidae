/**
 * Component tests for `<QueryFaultBanner>` (plan §10.4). Covers a
 * representative slice of the six treatments plus the retry affordance —
 * full per-code coverage already lives in `fault-boundary.test.ts`
 * (Foundation); this file proves this component reads `error` through the
 * same `faultTreatment` classification and renders the shared banner
 * classes.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft/testing';

import { RETRY_LABEL } from '../../app/copy/views.ts';
import QueryFaultBanner from './query-fault-banner.svelte';

describe('QueryFaultBanner', () => {
  test('renders the not-found treatment with a neutral tone', async () => {
    const error = new HttpClientError(404, 'Workflow wf_missing not found.');
    const { container, getByText } = render(QueryFaultBanner, { props: { error } });

    expect(getByText('Not found')).not.toBeNull();
    expect(getByText('Workflow wf_missing not found.')).not.toBeNull();
    expect(container.querySelector('[data-cinder-tone="neutral"]')).not.toBeNull();
  });

  test('renders the unauthorized treatment with a danger tone', async () => {
    const error = new HttpClientError(403, 'Requires system:admin.', { faultCode: 'Forbidden' });
    const { container, getByText } = render(QueryFaultBanner, { props: { error } });

    expect(getByText('Not authorized')).not.toBeNull();
    expect(container.querySelector('[data-cinder-tone="danger"]')).not.toBeNull();
  });

  test('shows the remediation as a line under the message, and Retry when the fault is retryable', async () => {
    const error = new HttpClientError(503, 'The server is restarting.', {
      retryable: true,
      remediation: 'Wait a moment, then read it again.',
    });
    const { container, getByRole, getByText } = render(QueryFaultBanner, {
      props: { error, onRetry: () => {} },
    });

    expect(getByText('Wait a moment, then read it again.').className).toContain(
      'cinder-error-state-remediation',
    );
    expect(container.querySelector('.cinder-error-state-title')?.textContent?.trim()).toBe(
      'Something went wrong',
    );
    expect(getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
  });

  test('names what failed to load in the title, whatever the fault, when the screen knows', async () => {
    for (const error of [
      new HttpClientError(403, 'Requires system:admin.', { faultCode: 'Forbidden' }),
      new HttpClientError(503, 'The server is not ready.'),
      new HttpClientError(409, 'It changed.', { faultCode: 'Conflict' }),
    ]) {
      const { container, getByRole, unmount } = render(QueryFaultBanner, {
        props: { error, subject: 'the server lease', onRetry: () => {} },
      });
      expect(getByRole('heading', { name: 'Couldn’t load the server lease' })).not.toBeNull();
      expect(container.querySelector('.cinder-error-state-title')?.textContent).not.toContain(
        error.message,
      );
      unmount();
    }
  });

  test('offers no Retry for a fault that is not retryable', async () => {
    const error = new HttpClientError(409, 'The workflow changed.', {
      retryable: false,
      remediation: 'Read the workflow again, then send the new revision.',
    });
    const { getByText, queryByRole } = render(QueryFaultBanner, {
      props: { error, onRetry: () => {} },
    });

    expect(getByText('Read the workflow again, then send the new revision.')).not.toBeNull();
    expect(queryByRole('button', { name: RETRY_LABEL })).toBeNull();
  });

  test('shows a Retry button and calls onRetry when clicked', async () => {
    let retried = 0;
    const error = new HttpClientError(500, 'boom');
    const { getByRole } = render(QueryFaultBanner, {
      props: { error, onRetry: () => (retried += 1) },
    });

    await fireEvent.click(getByRole('button', { name: RETRY_LABEL }));
    expect(retried).toBe(1);
  });

  test('omits the Retry button when onRetry is not provided', async () => {
    const error = new HttpClientError(500, 'boom');
    const { queryByRole } = render(QueryFaultBanner, { props: { error } });
    expect(queryByRole('button', { name: RETRY_LABEL })).toBeNull();
  });

  test('an unclassifiable error falls back to the internal treatment', async () => {
    const { getByText } = render(QueryFaultBanner, { props: { error: new Error('network down') } });
    expect(getByText('Something went wrong')).not.toBeNull();
  });
});
