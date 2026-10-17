/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init, so register happy-dom's globals first.
setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: ErrorState } = await import('./error-state.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('ErrorState rendering', () => {
  test('renders the title as a level-2 heading by default', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Could not load runs', description: 'The server did not respond.' },
    });
    const heading = container.querySelector('.cinder-error-state-title');
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent?.trim()).toBe('Could not load runs');
  });

  test('renders the description', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'The server did not respond.' },
    });
    expect(container.querySelector('.cinder-error-state-description')?.textContent?.trim()).toBe(
      'The server did not respond.',
    );
  });

  test('renders the detail only when provided', () => {
    const withDetail = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', detail: 'ECONNRESET' },
    });
    expect(withDetail.container.querySelector('.cinder-error-state-detail')?.textContent).toContain(
      'ECONNRESET',
    );
    cleanup();

    const withoutDetail = render(ErrorState, { props: { title: 'Failed', description: 'Nope.' } });
    expect(withoutDetail.container.querySelector('.cinder-error-state-detail')).toBeNull();
  });

  test('headingLevel overrides the title tag', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', headingLevel: 4 },
    });
    expect(container.querySelector('.cinder-error-state-title')?.tagName).toBe('H4');
  });

  test('clamps an out-of-range headingLevel back to a valid tag', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', headingLevel: 9 as never },
    });
    expect(container.querySelector('.cinder-error-state-title')?.tagName).toBe('H6');
  });

  test('merges the class prop onto the root and forwards native attributes', () => {
    const { container } = render(ErrorState, {
      props: {
        title: 'Failed',
        description: 'Nope.',
        class: 'extra',
        'data-testid': 'error-state-root',
      },
    });
    const root = container.querySelector('.cinder-error-state');
    expect(root?.classList.contains('extra')).toBe(true);
    expect(root?.getAttribute('data-testid')).toBe('error-state-root');
  });
});

describe('ErrorState alert semantics', () => {
  test('renders through a danger Alert with exactly one role="alert"', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', onRetry: () => {} },
    });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    const alert = container.querySelector('.cinder-alert');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.getAttribute('data-cinder-variant')).toBe('danger');
  });

  test('keeps a single role="alert" without a retry button', () => {
    const { container } = render(ErrorState, { props: { title: 'Failed', description: 'Nope.' } });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});

describe('ErrorState retry', () => {
  test('renders no button without onRetry', () => {
    const { container } = render(ErrorState, { props: { title: 'Failed', description: 'Nope.' } });
    expect(container.querySelector('button')).toBeNull();
  });

  test('renders a "Try again" button that calls onRetry', async () => {
    const onRetry = mock(() => {});
    const { getByRole } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', onRetry },
    });
    const button = getByRole('button', { name: 'Try again' });
    await fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('retryLabel overrides the button text', () => {
    const { getByRole } = render(ErrorState, {
      props: {
        title: 'Failed',
        description: 'Nope.',
        onRetry: () => {},
        retryLabel: 'Reload runs',
      },
    });
    expect(getByRole('button', { name: 'Reload runs' })).not.toBeNull();
  });
});

test('no console errors on render', () => {
  const originalError = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', detail: 'E1', onRetry: () => {} },
    });
    expect(errors).toHaveLength(0);
  } finally {
    console.error = originalError;
  }
});
