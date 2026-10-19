/**
 * The view frame (`view-frame.svelte`): every view has a loading, an empty, an error, and a
 * forbidden state, each carrying `data-state` and the words `copy.ts` holds, and a view that is
 * none of those shows its content. The matrix below drives every view into every state the way
 * the server would, with a stubbed `fetch` answering the view's probe.
 */
import { HttpClient } from '@lostgradient/weft';
import { render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { installFetchImplementation } from '../lib/live-source/fetch.test-support.ts';
import { AUTHORIZATION_SCOPES, type PrincipalStore } from '../lib/scopes.svelte.ts';
import { RETRY_LABEL, VIEW_COPY } from './copy.ts';
import Harness from './view-frame.test-harness.svelte';
import { VIEW_NAMES, VIEWS, type ViewName } from './views.ts';

type Outcome = 'content' | 'empty' | 'error' | 'forbidden';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function requestUrl(input: RequestInfo | URL): URL {
  const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(text, 'http://localhost');
}

function operationOf(body: RequestInit['body']): { id: unknown; method: string } | undefined {
  if (typeof body !== 'string') return undefined;
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const method: unknown = Reflect.get(parsed, 'method');
  return typeof method === 'string' ? { id: Reflect.get(parsed, 'id'), method } : undefined;
}

/** What each view's probe asks for, and the answer that makes the view empty or not. */
function answer(view: ViewName, outcome: Outcome, input: RequestInfo | URL, init?: RequestInit) {
  if (outcome === 'error') return Response.json({ error: 'The server broke.' }, { status: 500 });
  if (outcome === 'forbidden') return Response.json({ error: 'Forbidden' }, { status: 403 });
  const empty = outcome === 'empty';
  const url = requestUrl(input);
  const call = operationOf(init?.body);
  if (call !== undefined) {
    // The agent editor's probe parses the catalog, so it answers one.
    const result =
      call.method === 'bureau.agents.catalog' ? { models: [], tools: [] } : { items: [] };
    return Response.json({ jsonrpc: '2.0', id: call.id, result });
  }
  if (url.pathname === '/bureau/v1/health') return Response.json({ status: 'ok' });
  if (url.pathname.endsWith('/schedules')) {
    return Response.json({ items: empty ? [] : [{ id: 'schedule-1' }], total: empty ? 0 : 1 });
  }
  if (url.pathname.endsWith('/reviews')) {
    return Response.json({ items: empty ? [] : [{ id: 'review-1' }] });
  }
  if (url.pathname.endsWith('/workflows')) {
    return Response.json({ items: empty ? [] : [{ id: 'run-1' }], total: empty ? 0 : 1 });
  }
  throw new Error(`The ${view} probe made an unexpected request: ${url.href}`);
}

function stub(view: ViewName, outcome: Outcome): { requests: URL[] } {
  const requests: URL[] = [];
  restore = installFetchImplementation(async (input, init) => {
    requests.push(requestUrl(input));
    return answer(view, outcome, input, init);
  });
  return { requests };
}

function mount(
  view: ViewName,
  options: { scopes?: readonly string[]; parameters?: Record<string, string> } = {},
) {
  let store: PrincipalStore | undefined;
  const result = render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: options.scopes ?? AUTHORIZATION_SCOPES,
      view,
      parameters: options.parameters ?? {},
      onStore: (created: PrincipalStore) => {
        store = created;
      },
    },
  } as never);
  return { ...result, store: () => store };
}

function frame(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('.weft-view');
  if (element === null) throw new Error('The view frame did not render.');
  return element;
}

describe('every view, in every state', () => {
  for (const view of VIEW_NAMES) {
    const copy = VIEW_COPY[view];

    test(`${view} is empty when its probe finds nothing, with its own words`, async () => {
      const emptyCopy = copy.empty;
      if (!VIEWS[view].canBeEmpty || emptyCopy === undefined) return;
      stub(view, 'empty');
      const { container, findByRole } = mount(view);
      const heading = await findByRole('heading', { level: 1, name: emptyCopy.title });
      expect(heading).not.toBeNull();
      expect(frame(container).dataset['view']).toBe(view);
      expect(frame(container).dataset['state']).toBe('empty');
      expect(container.textContent).toContain(emptyCopy.description);
    });

    test(`${view} is failing when its probe fails`, async () => {
      stub(view, 'error');
      const { container, findByRole, getByRole } = mount(view);
      expect(await findByRole('heading', { level: 1, name: copy.error.title })).not.toBeNull();
      expect(frame(container).dataset['state']).toBe('error');
      expect(container.textContent).toContain(copy.error.description);
      expect(getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
    });

    test(`${view} is forbidden when its probe is refused`, async () => {
      stub(view, 'forbidden');
      const { container, findByRole } = mount(view);
      expect(await findByRole('heading', { level: 1, name: copy.forbidden.title })).not.toBeNull();
      expect(frame(container).dataset['state']).toBe('forbidden');
    });

    test(`${view} is loading while its probe is pending`, async () => {
      restore = installFetchImplementation(() => new Promise<Response>(() => {}));
      const { container, findByRole } = mount(view);
      expect(await findByRole('heading', { level: 1, name: copy.loading.title })).not.toBeNull();
      expect(frame(container).dataset['state']).toBe('loading');
      expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    });
  }

  test('a view whose scopes are missing is forbidden without asking the server anything', () => {
    for (const view of VIEW_NAMES) {
      if (VIEWS[view].scopes.length === 0) continue;
      const { requests } = stub(view, 'content');
      const { container, unmount } = mount(view, { scopes: [] });
      expect(frame(container).dataset['state']).toBe('forbidden');
      expect(container.textContent).toContain(`Requires ${VIEWS[view].scopes.join(', ')}`);
      expect(requests).toEqual([]);
      unmount();
      restore?.();
    }
  });
});

describe('a view that finds something to show', () => {
  const populated = VIEW_NAMES.filter((view) => !VIEWS[view].placeholder);
  for (const view of populated) {
    test(`${view} renders its content`, async () => {
      stub(view, 'content');
      const { container, findByTestId } = mount(view);
      expect(await findByTestId('content')).not.toBeNull();
      expect(frame(container).dataset['state']).toBe('ready');
    });
  }

  test('a placeholder view is empty even when its service answers', async () => {
    stub('chat', 'content');
    const { container, findByRole } = mount('chat');
    const title = VIEW_COPY.chat.empty?.title ?? '';
    expect(await findByRole('heading', { level: 1, name: title })).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('empty');
  });

  test('one run’s page has no probe and shows its content once its scope is held', async () => {
    const { requests } = stub('runs', 'content');
    const { container, findByTestId } = mount('runs', { parameters: { id: 'run-1' } });
    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
    expect(requests).toEqual([]);
  });
});

describe('a refused probe', () => {
  test('tells the principal store the scope is gone', async () => {
    stub('inbox', 'forbidden');
    const { store, findByRole } = mount('inbox');
    await findByRole('heading', { level: 1, name: VIEW_COPY.inbox.forbidden.title });
    await waitFor(() => expect(store()?.hasScope('reviews:read')).toBe(false));
  });

  test('is not retried automatically, and retrying asks again', async () => {
    const { requests } = stub('schedules', 'error');
    const { findByRole, getByRole } = mount('schedules');
    await findByRole('heading', { level: 1, name: VIEW_COPY.schedules.error.title });
    expect(requests.length).toBe(1);
    getByRole('button', { name: RETRY_LABEL }).click();
    await waitFor(() => expect(requests.length).toBe(2));
  });
});
