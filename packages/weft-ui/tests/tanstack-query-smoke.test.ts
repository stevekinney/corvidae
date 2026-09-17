/**
 * Mount the real query provider and a consuming component to verify that
 * accessor options and reactive result properties resolve and render data.
 */
import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import TanstackQuerySmoke from './tanstack-query-smoke.svelte';

describe('TanStack Query Svelte 5 smoke test', () => {
  test('createQuery resolves data and its reactive result updates the DOM', async () => {
    const { getByTestId } = render(TanstackQuerySmoke);

    await waitFor(() => {
      expect(getByTestId('data').textContent).toBe('tanstack-query-ok');
    });
    expect(getByTestId('status').textContent).toBe('success');
  });
});
