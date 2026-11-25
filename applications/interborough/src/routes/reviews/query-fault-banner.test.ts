import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';

import { RETRY_LABEL } from '../../app/copy/views.ts';
import QueryFaultBanner from './query-fault-banner.svelte';

describe('QueryFaultBanner', () => {
  test('renders the treatment title and message for a classified fault', async () => {
    const error = new HttpClientError(401, 'authentication required', {
      faultCode: 'Unauthorized',
    });
    const { getByText } = render(QueryFaultBanner, { props: { error, onRetry: () => {} } });

    expect(getByText('Not authorized')).not.toBeNull();
    expect(getByText('authentication required')).not.toBeNull();
  });

  test('falls back to the unknown treatment for a non-wire error', async () => {
    const { getByText } = render(QueryFaultBanner, {
      props: { error: new Error('offline'), onRetry: () => {} },
    });

    expect(getByText('Something went wrong')).not.toBeNull();
  });

  test('shows the remediation under the message and offers Retry only when the fault can be retried', async () => {
    const retryable = new HttpClientError(503, 'Unavailable', {
      retryable: true,
      remediation: 'Wait a moment, then read it again.',
    });
    const first = render(QueryFaultBanner, { props: { error: retryable, onRetry: () => {} } });
    expect(first.getByText('Wait a moment, then read it again.')).not.toBeNull();
    expect(first.getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
    first.unmount();

    const permanent = new HttpClientError(409, 'The review changed.', {
      retryable: false,
      remediation: 'Open the review again, then decide.',
    });
    const second = render(QueryFaultBanner, { props: { error: permanent, onRetry: () => {} } });
    expect(second.getByText('Open the review again, then decide.')).not.toBeNull();
    expect(second.queryByRole('button', { name: RETRY_LABEL })).toBeNull();
  });

  test('Retry calls onRetry', async () => {
    let retried = false;
    const error = new HttpClientError(500, 'boom');
    const { getByRole } = render(QueryFaultBanner, {
      props: {
        error,
        onRetry: () => {
          retried = true;
        },
      },
    });

    await fireEvent.click(getByRole('button', { name: RETRY_LABEL }));
    expect(retried).toBe(true);
  });
});
