/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import.
setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: Pagination } = await import('./pagination.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function stepButtons(container: HTMLElement) {
  return {
    previous: requiredInstance(
      container.querySelector('button[aria-label="Go to previous page"]'),
      HTMLButtonElement,
    ),
    next: requiredInstance(
      container.querySelector('button[aria-label="Go to next page"]'),
      HTMLButtonElement,
    ),
  };
}

describe('Pagination callback mode', () => {
  test('activating Next calls onNext with no arguments and leaves currentPage unchanged', async () => {
    let currentPage = 4;
    const nextCalls: unknown[][] = [];
    const { container } = render(Pagination, {
      props: {
        get currentPage() {
          return currentPage;
        },
        set currentPage(value: number) {
          currentPage = value;
        },
        hasNextPage: true,
        onNext: (...args: unknown[]) => {
          nextCalls.push(args);
        },
      },
    });

    await fireEvent.click(stepButtons(container).next);

    expect(nextCalls).toEqual([[]]);
    expect(currentPage).toBe(4);
  });

  test('activating Previous calls onPrevious with no arguments and leaves currentPage unchanged', async () => {
    let currentPage = 4;
    const previousCalls: unknown[][] = [];
    const { container } = render(Pagination, {
      props: {
        get currentPage() {
          return currentPage;
        },
        set currentPage(value: number) {
          currentPage = value;
        },
        hasPreviousPage: true,
        onPrevious: (...args: unknown[]) => {
          previousCalls.push(args);
        },
      },
    });

    await fireEvent.click(stepButtons(container).previous);

    expect(previousCalls).toEqual([[]]);
    expect(currentPage).toBe(4);
  });

  test('either callback alone enables callback mode', async () => {
    let nextCalls = 0;
    const { container } = render(Pagination, {
      props: {
        currentPage: 1,
        totalPages: 10,
        hasNextPage: true,
        onNext: () => {
          nextCalls += 1;
        },
      },
    });

    expect(container.querySelector('.cinder-pagination__page')).toBeNull();
    await fireEvent.click(stepButtons(container).next);
    expect(nextCalls).toBe(1);
  });

  test('Previous is enabled by hasPreviousPage alone, even on page 1', () => {
    const { container } = render(Pagination, {
      props: { currentPage: 1, hasPreviousPage: true, onPrevious: () => {} },
    });

    expect(stepButtons(container).previous.disabled).toBe(false);
  });

  test('Previous is disabled without hasPreviousPage, even past page 1', () => {
    const { container } = render(Pagination, {
      props: { currentPage: 5, onPrevious: () => {}, onNext: () => {} },
    });

    expect(stepButtons(container).previous.disabled).toBe(true);
  });

  test('Next is enabled by hasNextPage alone, even with totalPages reached', () => {
    const { container } = render(Pagination, {
      props: { currentPage: 10, totalPages: 10, hasNextPage: true, onNext: () => {} },
    });

    expect(stepButtons(container).next.disabled).toBe(false);
  });

  test('Next is disabled without hasNextPage, even before totalPages', () => {
    const { container } = render(Pagination, {
      props: { currentPage: 1, totalPages: 10, onNext: () => {} },
    });

    expect(stepButtons(container).next.disabled).toBe(true);
  });

  test('a disabled step does not call its callback', async () => {
    let calls = 0;
    const { container } = render(Pagination, {
      props: {
        currentPage: 1,
        onPrevious: () => {
          calls += 1;
        },
      },
    });

    await fireEvent.click(stepButtons(container).previous);

    expect(calls).toBe(0);
  });

  test('renders no page-number buttons', () => {
    const { container } = render(Pagination, {
      props: { currentPage: 2, totalPages: 10, hasNextPage: true, onNext: () => {} },
    });

    expect(container.querySelector('.cinder-pagination__pages')).toBeNull();
    expect(container.querySelector('[aria-current="page"]')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });

  test('shows "Page N of M" when totalPages is given', () => {
    const { container } = render(Pagination, {
      props: { currentPage: 3, totalPages: 12, hasNextPage: true, onNext: () => {} },
    });

    expect(container.querySelector('.cinder-pagination__position')?.textContent?.trim()).toBe(
      'Page 3 of 12',
    );
  });

  test('shows no page label when totalPages is omitted', () => {
    const { container } = render(Pagination, {
      props: { currentPage: 3, hasNextPage: true, onNext: () => {} },
    });

    expect(container.querySelector('.cinder-pagination__position')).toBeNull();
    expect(container.textContent).not.toContain('Page');
  });
});

describe('Pagination countLabel', () => {
  test('replaces the "N results" text', () => {
    const { container } = render(Pagination, {
      props: {
        currentPage: 1,
        totalPages: 3,
        totalCount: 1234,
        countLabel: (count: number) => `${count} runs`,
      },
    });

    const count = container.querySelector('.cinder-pagination__count');
    expect(count?.textContent?.trim()).toBe('1234 runs');
    expect(container.textContent).not.toContain('results');
  });

  test('keeps the default "N results" text when omitted', () => {
    const { container } = render(Pagination, {
      props: { currentPage: 1, totalPages: 3, totalCount: 1234 },
    });

    expect(container.querySelector('.cinder-pagination__count')?.textContent?.trim()).toBe(
      '1,234 results',
    );
  });

  test('applies in callback mode', () => {
    const { container } = render(Pagination, {
      props: {
        currentPage: 1,
        totalCount: 7,
        hasNextPage: true,
        onNext: () => {},
        countLabel: (count: number) => `${count} memories`,
      },
    });

    expect(container.querySelector('.cinder-pagination__count')?.textContent?.trim()).toBe(
      '7 memories',
    );
  });

  test('is not called without totalCount', () => {
    let calls = 0;
    render(Pagination, {
      props: {
        currentPage: 1,
        totalPages: 3,
        countLabel: (count: number) => {
          calls += 1;
          return String(count);
        },
      },
    });

    expect(calls).toBe(0);
  });
});
