import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';
import SessionList from './session-list.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: SessionList } } as never);

const page = (offset: number, count: number, more: boolean) => ({
  contexts: Array.from({ length: count }, (_, index) => ({
    ...CONTEXT,
    id: `session-${offset + index}`,
    title: `Chat ${offset + index}`,
  })),
  nextOffset: more ? offset + count : null,
});

describe('the list of sessions', () => {
  test('is the sessions the Bureau lists, newest first as it lists them, each with its agent’s display name', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 3, false),
      'bureau.agents.list': () => ({ agents: [AGENT] }),
    });
    restore = served.restore;
    landAt('/chat');

    const { findByRole } = mount();

    const list = await findByRole('navigation', { name: 'Chats' });
    await waitFor(() => expect(list.textContent).toContain('Assistant'));
    const titles = [...list.querySelectorAll('li')].map((item) => item.textContent ?? '');
    expect(titles[0]).toContain('Chat 0');
    expect(titles[2]).toContain('Chat 2');
    expect(served.calls.find((call) => call.method === 'bureau.contexts.list')?.params).toEqual({
      limit: 20,
      offset: 0,
    });
  });

  test('asks for the next page by its offset when Load more is pressed', async () => {
    const served = bureau({
      'bureau.contexts.list': (params) =>
        params['offset'] === 0 ? page(0, 20, true) : page(20, 2, false),
      'bureau.agents.list': () => ({ agents: [AGENT] }),
    });
    restore = served.restore;
    landAt('/chat');
    const { findByRole } = mount();

    const more = await findByRole('button', { name: 'Load more' });
    more.click();

    await waitFor(() =>
      expect(
        served.calls
          .filter((call) => call.method === 'bureau.contexts.list')
          .map((call) => call.params['offset']),
      ).toContain(20),
    );
  });

  test('does not repeat a session the next page gives again, and stays', async () => {
    const served = bureau({
      // A session began after the first page was read, so offset 20 starts with its last row.
      'bureau.contexts.list': (params) =>
        params['offset'] === 0
          ? page(0, 20, true)
          : { contexts: page(19, 2, false).contexts, nextOffset: null },
      'bureau.agents.list': () => ({ agents: [AGENT] }),
    });
    restore = served.restore;
    landAt('/chat');
    const { container, findByRole } = mount();

    const more = await findByRole('button', { name: 'Load more' });
    more.click();

    await waitFor(() => expect(container.textContent).toContain('Chat 20'));
    expect(container.textContent).not.toContain('Something went wrong');
    expect(container.textContent?.match(/Chat 19(?!\d)/g)).toHaveLength(1);
  });

  test('opens a session when its row is pressed', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 1, false),
      'bureau.agents.list': () => ({ agents: [AGENT] }),
    });
    restore = served.restore;
    landAt('/chat');
    const { findByRole } = mount();

    const row = await findByRole('button', { name: /Chat 0/ });
    row.click();

    expect(router.pathname).toBe('/chat/session-0');
  });

  test('has a New chat action that opens /chat/new, and leaves a modified click to the browser', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 1, false),
      'bureau.agents.list': () => ({ agents: [AGENT] }),
    });
    restore = served.restore;
    landAt('/chat');
    const { findByRole } = mount();
    const action = await findByRole('link', { name: 'New chat' });

    action.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(router.pathname).toBe('/chat');
    action.click();

    expect(action.getAttribute('href')).toBe('/chat/new');
    expect(router.pathname).toBe('/chat/new');
  });
});
