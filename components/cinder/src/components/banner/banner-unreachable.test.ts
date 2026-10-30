/// <reference lib="dom" />
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createRawSnippet, flushSync } from 'svelte';

import Banner from './banner.svelte';

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
    setup: () => {},
  }));
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('Banner unreachable preset', () => {
  test('uses the warning variant and names the region Connection problem', () => {
    const { container } = render(Banner, {
      props: { preset: 'unreachable', children: textSnippet("Can't reach the server.") },
    });
    const root = container.querySelector('.cinder-banner');
    expect(root?.getAttribute('data-cinder-preset')).toBe('unreachable');
    expect(root?.getAttribute('data-cinder-variant')).toBe('warning');
    expect(root?.getAttribute('role')).toBe('region');
    expect(root?.getAttribute('aria-label')).toBe('Connection problem');
  });

  test('overrides an explicit variant but keeps a consumer aria-label', () => {
    const { container } = render(Banner, {
      props: {
        preset: 'unreachable',
        variant: 'danger',
        'aria-label': 'Offline',
        children: textSnippet('Offline'),
      },
    });
    const root = container.querySelector('.cinder-banner');
    expect(root?.getAttribute('data-cinder-variant')).toBe('warning');
    expect(root?.getAttribute('aria-label')).toBe('Offline');
  });

  test('without a preset nothing marks the root and the variant label applies', () => {
    const { container } = render(Banner, {
      props: { variant: 'danger', children: textSnippet('Plain') },
    });
    const root = container.querySelector('.cinder-banner');
    expect(root?.hasAttribute('data-cinder-preset')).toBe(false);
    expect(root?.getAttribute('aria-label')).toBe('Error');
  });

  test('renders a Retry button only when onRetry is set, and calls it', async () => {
    const without = render(Banner, {
      props: { preset: 'unreachable', children: textSnippet('Down') },
    });
    expect(without.container.querySelector('.cinder-banner__actions')).toBeNull();
    cleanup();

    const onRetry = mock(() => {});
    const { getByRole } = render(Banner, {
      props: { preset: 'unreachable', onRetry, dismissible: false, children: textSnippet('Down') },
    });
    await fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('puts Retry before consumer actions and honours retryLabel', () => {
    const { container } = render(Banner, {
      props: {
        preset: 'unreachable',
        onRetry: () => {},
        retryLabel: 'Try again',
        dismissible: false,
        children: textSnippet('Down'),
        actions: createRawSnippet(() => ({ render: () => `<button>Status page</button>` })),
      },
    });
    const labels = [...container.querySelectorAll('.cinder-banner__actions button')].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).toEqual(['Try again', 'Status page']);
  });

  test('shows a stale-data notice with the age of the data', () => {
    const updatedAt = new Date(Date.now() - 120_000);
    const { container } = render(Banner, {
      props: {
        preset: 'unreachable',
        dataUpdatedAt: updatedAt,
        children: textSnippet('Down'),
      },
    });
    flushSync();
    const notice = container.querySelector('.cinder-banner__stale');
    expect(notice?.textContent).toContain('Showing data from');
    expect(notice?.querySelector('time')?.getAttribute('datetime')).toBe(updatedAt.toISOString());
    expect(notice?.querySelector('time')?.textContent).toContain('2 minutes ago');
  });

  test('omits the stale-data notice without dataUpdatedAt and honours staleDataLabel', () => {
    const without = render(Banner, {
      props: { preset: 'unreachable', children: textSnippet('Down') },
    });
    expect(without.container.querySelector('.cinder-banner__stale')).toBeNull();
    cleanup();
    const labelled = render(Banner, {
      props: {
        preset: 'unreachable',
        dataUpdatedAt: Date.now(),
        staleDataLabel: 'Last synced',
        children: textSnippet('Down'),
      },
    });
    expect(labelled.container.querySelector('.cinder-banner__stale')?.textContent).toContain(
      'Last synced',
    );
  });
});
