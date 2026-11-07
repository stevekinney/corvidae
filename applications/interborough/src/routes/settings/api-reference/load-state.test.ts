/**
 * What a tab of Settings › API reference shows while it has nothing to show: placeholders, an error
 * with Try again, and a read the person gave up on.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import LoadState from './load-state.svelte';

afterEach(cleanup);

describe('LoadState', () => {
  test('a failed read names the status the server answered with, and Try again reads again', async () => {
    let retried = 0;
    const view = render(LoadState, {
      props: {
        kind: 'error',
        status: 500,
        onCancel: () => undefined,
        onRetry: () => (retried += 1),
      },
    });

    expect(view.container.textContent).toContain('Couldn’t load the API reference.');
    expect(view.container.textContent).toContain('The server answered with an error (500).');
    // The board reads the error alone, with Try again.
    expect(view.container.textContent).not.toContain('Nothing you did caused it');
    await fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    expect(retried).toBe(1);
  });

  test('a failed read the server never answered says so, without a status', () => {
    const view = render(LoadState, {
      props: { kind: 'error', onCancel: () => undefined, onRetry: () => undefined },
    });

    expect(view.container.textContent).toContain('Interborough didn’t answer.');
    expect(view.container.textContent).not.toContain('(undefined)');
  });

  test('a read the person gave up on says so and offers Try again', async () => {
    let retried = 0;
    const view = render(LoadState, {
      props: { kind: 'canceled', onCancel: () => undefined, onRetry: () => (retried += 1) },
    });

    expect(view.getByTestId('api-reference-canceled').textContent).toContain(
      'Loading was canceled.',
    );
    await fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    expect(retried).toBe(1);
  });

  test('a read in flight is placeholders, with the tab row left to its page', () => {
    const view = render(LoadState, {
      props: { kind: 'loading', onCancel: () => undefined, onRetry: () => undefined },
    });

    expect(view.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(view.container.querySelector('[data-testid="api-reference-load-failed"]')).toBeNull();
  });
});
