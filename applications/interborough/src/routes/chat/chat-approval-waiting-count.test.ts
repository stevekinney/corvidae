import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, test } from 'bun:test';

import Chats from './chats.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
});

const mount = () => render(QueryPage, { props: { page: Chats } } as never);

test('a title filter isolates the waiting count from a late older chat', async () => {
  const priorLookup = Promise.withResolvers<void>();
  const releasePrior = Promise.withResolvers<void>();
  let fresh = false;
  const review = (sessionId: string) => ({
    id: `review-${sessionId}`,
    runId: `run-${sessionId}`,
    kind: 'human-wait',
    sessionId,
    signalName: 'environment',
    prompt: `Question for ${sessionId}?`,
    requestedAt: 1,
    ageMilliseconds: 1,
    status: 'pending',
  });
  const served = bureau({
    'bureau.contexts.list': () => ({
      contexts: [{ ...CONTEXT, id: 'target', title: 'Target chat' }],
      nextOffset: null,
    }),
    'bureau.reviews.list': () => ({
      reviews: [review('prior'), ...(fresh ? [review('target')] : [])],
    }),
    'bureau.contexts.get': async (parameters) => {
      const id = String(parameters['contextId']);
      if (id === 'prior') {
        priorLookup.resolve();
        await releasePrior.promise;
      }
      return { ...CONTEXT, id, title: `Older ${id}`, origin: 'chat' };
    },
  });
  restore = served.restore;
  const waitingCount = (view: ReturnType<typeof mount>) =>
    Number(
      view
        .getByRole('radio', { name: /Waiting on you/ })
        .querySelector('.cinder-segmented-control-option-count')
        ?.textContent?.replace(',', '')
        .trim(),
    );
  const row = (view: ReturnType<typeof mount>, id: string) =>
    view.container.querySelector(`[data-chat="${id}"]`);
  try {
    landAt('/chats');
    const expired = mount();
    await priorLookup.promise;
    await waitFor(() => expect(row(expired, 'target')?.textContent).toContain('Done'));
    expect(waitingCount(expired)).toBe(0);
    await fireEvent.input(expired.getByRole('searchbox', { name: 'Search chats' }), {
      target: { value: 'Target chat' },
    });
    expect(waitingCount(expired)).toBe(0);
    releasePrior.resolve();
    await fireEvent.input(expired.getByRole('searchbox', { name: 'Search chats' }), {
      target: { value: '' },
    });
    await waitFor(() => expect(row(expired, 'prior')?.textContent).toContain('Waiting on you'));
    expired.unmount();

    fresh = true;
    const retried = mount();
    await waitFor(() => expect(row(retried, 'target')?.textContent).toContain('Waiting on you'));
    await waitFor(() => expect(row(retried, 'prior')?.textContent).toContain('Waiting on you'));
    expect(waitingCount(retried)).toBe(2);
    await fireEvent.input(retried.getByRole('searchbox', { name: 'Search chats' }), {
      target: { value: 'Target chat' },
    });
    await waitFor(() => expect(waitingCount(retried)).toBe(1));
    expect(row(retried, 'prior')).toBeNull();
    expect(row(retried, 'target')?.textContent).toContain('Waiting on you');
  } finally {
    releasePrior.resolve();
  }
});
