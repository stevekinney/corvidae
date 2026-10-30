/**
 * The route outlet mounts the matched route inside its view's frame, and says so when no route
 * owns the path.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import { quietFor } from '@lostgradient/testing/wait-until';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import Placeholder from '../../routes/placeholder/index.svelte';
import { NOT_FOUND_ROUTE_COPY, ROUTE_LOAD_FAILURE_COPY, VIEW_COPY } from '../copy.ts';
import { routes } from '../routes.ts';
import { VIEWS } from '../views.ts';
import { CHUNK_RELOAD_KEY } from './chunk-reload.ts';
import Harness from './route-outlet.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

/** Gives happy-dom's `about:blank` window a real origin, so `pushState` takes effect, at `path`. */
function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

function mount() {
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  });
}

/** An audit trail with nothing in it, which is how the Bureau answers the view's probe. */
function emptyTrail(): () => Promise<Response> {
  return async () =>
    Response.json({
      jsonrpc: '2.0',
      id: 'bureau.audit.query',
      result: { records: [], nextCursor: null },
    });
}

describe('the route outlet', () => {
  test('renders a view in its frame, empty once the Bureau answers', async () => {
    restore = installFetchImplementation(emptyTrail());
    landAt('/audit');
    const { container, findByRole } = mount();
    expect(
      await findByRole('heading', { level: 1, name: VIEW_COPY.audit.empty?.title ?? '' }),
    ).not.toBeNull();
    const frame = container.querySelector('.weft-view');
    expect(frame?.getAttribute('data-view')).toBe('audit');
    expect(frame?.getAttribute('data-state')).toBe('empty');
  });

  test('carries the density and the width its view declares, so a page chooses neither', async () => {
    restore = installFetchImplementation(emptyTrail());
    landAt('/audit');
    const { findByRole, container } = mount();
    await findByRole('heading', { level: 1, name: VIEW_COPY.audit.empty?.title ?? '' });
    const outlet = container.querySelector('main.weft-shell-outlet');
    expect(outlet?.getAttribute('data-density')).toBe(VIEWS.audit.density);
    expect(outlet?.getAttribute('data-width')).toBe(VIEWS.audit.width);
    expect(VIEWS.audit.density).toBe('compact');
  });

  test('reads like a reading page where no view owns the path', async () => {
    restore = installFetchImplementation(async () => Response.json({}));
    landAt('/nowhere');
    const { findByText, container } = mount();
    await findByText(NOT_FOUND_ROUTE_COPY.title);
    const outlet = container.querySelector('main.weft-shell-outlet');
    expect(outlet?.getAttribute('data-density')).toBe('comfortable');
    expect(outlet?.getAttribute('data-width')).toBe('reading');
  });

  test('says when no route owns the path', async () => {
    restore = installFetchImplementation(async () => Response.json({}));
    landAt('/nowhere');
    const { findByRole, container } = mount();
    expect(
      await findByRole('heading', { level: 1, name: NOT_FOUND_ROUTE_COPY.title }),
    ).not.toBeNull();
    const frame = container.querySelector('.weft-view');
    expect(frame?.getAttribute('data-view')).toBe('not-found');
    expect(frame?.getAttribute('data-state')).toBe('not-found');
    expect(container.textContent).toContain('/nowhere');
    expect(container.textContent).toContain(NOT_FOUND_ROUTE_COPY.description);
  });

  test('offers a way back to the chat list from an address no route owns', async () => {
    restore = installFetchImplementation(async () => Response.json({}));
    landAt('/nowhere');
    const { findByRole } = mount();
    const link = await findByRole('link', { name: NOT_FOUND_ROUTE_COPY.action.label });
    expect(link.getAttribute('href')).toBe('/chat');
    link.click();
    await waitFor(() => expect(router.pathname).toBe('/chat'));
  });

  test('is the page’s one main landmark, whatever the route renders', async () => {
    restore = installFetchImplementation(emptyTrail());
    landAt('/audit');
    const { findByRole, getAllByRole, container } = mount();
    await findByRole('heading', { level: 1, name: VIEW_COPY.audit.empty?.title ?? '' });
    expect(getAllByRole('main')).toHaveLength(1);
    expect(container.querySelector('main.weft-shell-outlet')).not.toBeNull();
  });

  test('says so when a route’s code cannot be loaded, and drops the page it came from', async () => {
    restore = installFetchImplementation(emptyTrail());
    landAt('/audit');
    const { findByRole, container } = mount();
    await findByRole('heading', { level: 1, name: VIEW_COPY.audit.empty?.title ?? '' });

    const agents = routes.find((route) => route.pattern === '/agents');
    if (agents === undefined) throw new Error('Expected an /agents route.');
    const load = spyOn(agents, 'load').mockRejectedValue(new Error('Failed to fetch chunk'));
    try {
      router.navigate('/agents');
      expect(
        await findByRole('heading', { level: 1, name: ROUTE_LOAD_FAILURE_COPY.title }),
      ).not.toBeNull();
      expect(container.querySelector('[data-state="error"]')).not.toBeNull();
      // The audit frame is not left on screen under the agents address.
      expect(container.querySelector('[data-view="audit"]')).toBeNull();
      const reload = spyOn(window.location, 'reload').mockImplementation(() => {});
      try {
        const button = await findByRole('button', { name: ROUTE_LOAD_FAILURE_COPY.action });
        button.click();
        expect(reload).toHaveBeenCalledTimes(1);
      } finally {
        reload.mockRestore();
      }
    } finally {
      load.mockRestore();
    }
  });
});

describe('a route that no view owns', () => {
  test('renders its page without a view frame', async () => {
    restore = installFetchImplementation(async () => Response.json({}));
    const agents = routes.find((route) => route.pattern === '/agents');
    if (agents === undefined) throw new Error('Expected an /agents route.');
    const { view } = agents;
    const load = spyOn(agents, 'load').mockResolvedValue({ default: Placeholder });
    Reflect.deleteProperty(agents, 'view');
    try {
      landAt('/agents');
      const { container } = mount();
      await waitFor(() =>
        expect(
          container.querySelector('.weft-shell-outlet__skeleton')?.outerHTML ?? null,
        ).toBeNull(),
      );
      expect(container.querySelector('main.weft-shell-outlet')).not.toBeNull();
      expect(container.querySelector('.weft-view')).toBeNull();
    } finally {
      Reflect.set(agents, 'view', view);
      load.mockRestore();
    }
  });
});

describe('a route whose chunk is gone after a rebuild', () => {
  const MISSING = () =>
    new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/a-1.js');

  async function openAgentsWithLoad(load: () => Promise<never>) {
    restore = installFetchImplementation(emptyTrail());
    landAt('/audit');
    const page = mount();
    await page.findByRole('heading', { level: 1, name: VIEW_COPY.audit.empty?.title ?? '' });
    const agents = routes.find((route) => route.pattern === '/agents');
    if (agents === undefined) throw new Error('Expected an /agents route.');
    return { page, loading: spyOn(agents, 'load').mockImplementation(load) };
  }

  test('reloads the page once, and keeps the loading state while it goes', async () => {
    window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    const reload = spyOn(window.location, 'reload').mockImplementation(() => {});
    const { page, loading } = await openAgentsWithLoad(() => Promise.reject(MISSING()));
    try {
      router.navigate('/agents');
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(
        page.queryByRole('heading', { level: 1, name: ROUTE_LOAD_FAILURE_COPY.title }),
      ).toBeNull();
      expect(page.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    } finally {
      loading.mockRestore();
      reload.mockRestore();
      window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    }
  });

  test('shows the failure when the reload did not help, rather than reloading again', async () => {
    const reload = spyOn(window.location, 'reload').mockImplementation(() => {});
    const { page, loading } = await openAgentsWithLoad(() => Promise.reject(MISSING()));
    try {
      // The guard a first reload left behind: the chunk is still missing after it.
      window.sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
      router.navigate('/agents');
      expect(
        await page.findByRole('heading', { level: 1, name: ROUTE_LOAD_FAILURE_COPY.title }),
      ).not.toBeNull();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      loading.mockRestore();
      reload.mockRestore();
      window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    }
  });

  test('lifts the guard once a route loads, so a later rebuild reloads again', async () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
    restore = installFetchImplementation(emptyTrail());
    landAt('/audit');
    const { findByRole } = mount();
    await findByRole('heading', { level: 1, name: VIEW_COPY.audit.empty?.title ?? '' });
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull();
  });
});

describe('a route that redirects', () => {
  const context = (id: string) => ({
    id,
    owner: 'anonymous:local',
    agentName: 'assistant',
    title: 'Hello',
    lastMessagePreview: null,
    parentContextId: null,
    forkedFromMessageId: null,
    messageCount: 2,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    activity: 'idle',
  });

  /** The pages the redirect lands on are not what these tests are about, so they render a stub. */
  function stubLandingPages(): void {
    for (const pattern of ['/chat', '/chat/:sessionId']) {
      const route = routes.find((candidate) => candidate.pattern === pattern);
      if (route === undefined) throw new Error(`Expected a ${pattern} route.`);
      const spy = spyOn(route, 'load').mockResolvedValue({ default: Placeholder });
      spies.push(spy);
    }
  }

  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  /** The Bureau as the redirect asks it. */
  function bureau(contexts: unknown[]): void {
    restore = installFetchImplementation(async (_input, init) => {
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      const method = typeof body === 'object' && body !== null ? Reflect.get(body, 'method') : '';
      const result =
        method === 'bureau.contexts.list'
          ? { contexts, nextOffset: null }
          : method === 'bureau.contexts.get'
            ? context('session-9')
            : {};
      return method === 'broken'
        ? new Response('no', { status: 500 })
        : Response.json({ jsonrpc: '2.0', id: method, result });
    });
  }

  test('replaces its own history entry with the newest session', async () => {
    stubLandingPages();
    bureau([context('session-9')]);
    landAt('/');
    const length = window.history.length;

    mount();

    await waitFor(() => expect(router.pathname).toBe('/chat/session-9'));
    expect(window.history.length).toBe(length);
  });

  test('goes to the chat list when there is no session', async () => {
    stubLandingPages();
    bureau([]);
    landAt('/');

    mount();

    await waitFor(() => expect(router.pathname).toBe('/chat'));
  });

  test('goes to the chat list, which says what is wrong, when the Bureau cannot say', async () => {
    stubLandingPages();
    restore = installFetchImplementation(async () => new Response('down', { status: 500 }));
    landAt('/');

    mount();

    await waitFor(() => expect(router.pathname).toBe('/chat'));
  });
});

describe('a page that asks to be kept', () => {
  test('stays mounted when its address is replaced, and a change to the query string does not remount it either', async () => {
    restore = installFetchImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/messages')) return Response.json({ threadId: 'x', messages: [] });
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      const method = typeof body === 'object' && body !== null ? Reflect.get(body, 'method') : '';
      const result =
        method === 'bureau.agents.list'
          ? {
              agents: [
                {
                  name: 'assistant',
                  displayName: 'Assistant',
                  description: null,
                  definitionRevision: 1,
                  kind: 'code',
                  a2a: false,
                },
              ],
            }
          : {
              id: 'session-1',
              owner: null,
              agentName: 'assistant',
              title: null,
              lastMessagePreview: null,
              parentContextId: null,
              forkedFromMessageId: null,
              model: null,
              configVersion: 0,
              messageCount: 0,
              createdAt: '2026-10-19T00:00:00.000Z',
              updatedAt: '2026-10-19T00:00:00.000Z',
              activity: 'idle',
            };
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    });
    landAt('/chat/new');
    const { container, findByRole } = mount();
    await findByRole('combobox', { name: 'Agent' });
    const page = container.querySelector('.weft-chat-route');
    expect(page).not.toBeNull();

    router.navigate('/chat/new?agent=assistant', { replace: true });
    router.navigate('/chat/session-1', { replace: true, keep: true });
    await quietFor(50);

    expect(container.querySelector('.weft-chat-route')).toBe(page);
  });
});
