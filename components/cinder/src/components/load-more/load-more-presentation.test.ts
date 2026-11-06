import { describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { setupLoadMoreTests } from './load-more-test-support.ts';

setupHappyDom();
setupLoadMoreTests(cleanup);

const { default: LoadMore } = await import('./load-more.svelte');

describe('LoadMore', () => {
  test('calls onError when onLoadMore rejects', async () => {
    let seen: unknown;
    const { getByRole } = render(LoadMore, {
      props: {
        onLoadMore: async () => {
          throw new Error('failed');
        },
        onError: (error: unknown) => {
          seen = error;
        },
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Load more' }));

    await waitFor(() => {
      expect(seen).toBeInstanceOf(Error);
    });
  });

  test('announces the end-of-list message when hasMore is false on initial mount', async () => {
    // statusText is `$derived(hasMore ? '' : endOfListMessage)`, so an initially-exhausted
    // list announces its state — more correct than staying silent for an empty list. The
    // shared VisuallyHiddenLiveRegion blanks-then-sets on the next task (setTimeout(0), so a
    // repeated message still re-announces), so waitFor until the text lands.
    const { getByRole } = render(LoadMore, {
      props: {
        onLoadMore: () => {},
        hasMore: false,
        endOfListMessage: 'All caught up',
      },
    });
    await waitFor(() => {
      expect(getByRole('status').textContent?.trim()).toBe('All caught up');
    });
  });

  test('announces the end-of-list message only after hasMore transitions to false', async () => {
    const rendered = render(LoadMore, {
      props: {
        onLoadMore: () => {},
        hasMore: true,
        endOfListMessage: 'Nothing else to load',
      },
    });

    expect(rendered.getByRole('status').textContent?.trim()).toBe('');

    await rendered.rerender({
      onLoadMore: () => {},
      hasMore: false,
      endOfListMessage: 'Nothing else to load',
    });

    await waitFor(() => {
      expect(rendered.getByRole('status').textContent?.trim()).toBe('Nothing else to load');
    });
  });

  test('disables the button while loading unless the component is in retry mode', () => {
    const { getByRole } = render(LoadMore, {
      props: {
        onLoadMore: () => {},
        loading: true,
      },
    });

    const button = requiredInstance(getByRole('button', { name: 'Load more' }), HTMLButtonElement);
    expect(button.disabled).toBe(true);
  });

  test('shows a busy state while awaiting onLoadMore before the parent flips loading', async () => {
    let resolveRequest: (() => void) | undefined;

    const { container, getByRole } = render(LoadMore, {
      props: {
        onLoadMore: () =>
          new Promise<void>((resolve) => {
            resolveRequest = resolve;
          }),
      },
    });

    const button = requiredInstance(getByRole('button', { name: 'Load more' }), HTMLButtonElement);

    await fireEvent.click(button);

    await waitFor(() => {
      expect(button.disabled).toBe(true);
      expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('true');
      expect(container.querySelector('.cinder-load-more__spinner')).toBeDefined();
    });

    resolveRequest?.();

    await waitFor(() => {
      expect(button.disabled).toBe(false);
      expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('false');
    });
  });

  test('shows "Showing N of M" beside the button when both counts are given', () => {
    const { getByText, getByRole } = render(LoadMore, {
      props: { onLoadMore: () => {}, hasMore: true, loadedCount: 10, totalCount: 19 },
    });

    expect(getByText('Showing 10 of 19')).toBeDefined();
    expect(getByRole('button', { name: 'Load more' })).toBeDefined();
  });

  test('names what it counts after the numbers when countNoun is given', () => {
    const { getByText } = render(LoadMore, {
      props: {
        onLoadMore: () => {},
        hasMore: true,
        loadedCount: 3,
        totalCount: 12,
        countNoun: 'waiting tasks',
      },
    });

    expect(getByText('Showing 3 of 12 waiting tasks')).toBeDefined();
  });

  test('shows no count unless both numbers are valid', () => {
    const { container } = render(LoadMore, {
      props: { onLoadMore: () => {}, hasMore: true, loadedCount: 10 },
    });

    expect(container.querySelector('.cinder-load-more__summary')).toBeNull();
  });

  test('keeps the count after the last page and drops the button', () => {
    const { getByText, queryByRole } = render(LoadMore, {
      props: { onLoadMore: () => {}, hasMore: false, loadedCount: 19, totalCount: 19 },
    });

    expect(getByText('Showing 19 of 19')).toBeDefined();
    expect(queryByRole('button')).toBeNull();
  });

  test('a failed load keeps the count and offers Try again', async () => {
    const { getByRole, findByRole } = render(LoadMore, {
      props: {
        onLoadMore: async () => {
          throw new Error('offline');
        },
        hasMore: true,
        loadedCount: 10,
        totalCount: 19,
        itemLabel: 'runs',
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Load more' }));

    const failure = await findByRole('alert');
    expect(failure.textContent).toBe('Couldn’t load more runs. Showing 10 of 19.');
    expect(getByRole('button', { name: 'Try again' })).toBeDefined();
  });

  test('a failed load reads generically without counts, and errorMessage replaces it', async () => {
    const failing = async () => {
      throw new Error('offline');
    };
    const first = render(LoadMore, { props: { onLoadMore: failing, hasMore: true } });
    await fireEvent.click(first.getByRole('button', { name: 'Load more' }));
    const firstFailure = await first.findByRole('alert');
    expect(firstFailure.textContent).toBe('Couldn’t load more items.');
    cleanup();

    const second = render(LoadMore, {
      props: { onLoadMore: failing, hasMore: true, errorMessage: 'The server said no.' },
    });
    await fireEvent.click(second.getByRole('button', { name: 'Load more' }));
    const secondFailure = await second.findByRole('alert');
    expect(secondFailure.textContent).toBe('The server said no.');
  });

  test('opens in the failed state when failed is set, with the count and a retry button', () => {
    const { getByRole, getByText } = render(LoadMore, {
      props: {
        onLoadMore: () => {},
        hasMore: true,
        failed: true,
        loadedCount: 10,
        totalCount: 4236,
        itemLabel: 'keys',
        retryLabel: 'Load more',
      },
    });

    expect(getByRole('alert').textContent).toBe('Couldn’t load more keys. Showing 10 of 4,236.');
    expect(getByText('Load more')).toBeDefined();
  });

  test('the footer variant bolds the first sentence of the failure and leaves the count plain', () => {
    const { container } = render(LoadMore, {
      props: {
        onLoadMore: () => {},
        hasMore: true,
        failed: true,
        variant: 'footer',
        loadedCount: 10,
        totalCount: 19,
        itemLabel: 'keys',
      },
    });

    const root = requiredInstance(container.querySelector('.cinder-load-more'), HTMLElement);
    expect(root.getAttribute('data-cinder-variant')).toBe('footer');
    const strong = requiredInstance(container.querySelector('strong'), HTMLElement);
    expect(strong.textContent).toBe('Couldn’t load more keys.');
    expect(
      requiredInstance(container.querySelector('[role="alert"]'), HTMLElement).textContent,
    ).toBe('Couldn’t load more keys. Showing 10 of 19.');
  });

  test('the centered footer keeps the failure as one plain sentence', () => {
    const { container } = render(LoadMore, {
      props: { onLoadMore: () => {}, hasMore: true, failed: true, itemLabel: 'runs' },
    });

    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('.cinder-load-more')?.hasAttribute('data-cinder-variant')).toBe(
      false,
    );
  });
});
