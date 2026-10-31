/**
 * The stale, unreachable and reconnecting states (COR-1839), as one table. Each row is an input the
 * person or the network can produce and the result the application must show. The rows run through
 * the real parts: the view frame over a stubbed `fetch`, the connection monitor over that same
 * stub, and a chat session over its own. The browser spec (`tests/e2e/states-offline.spec.ts`)
 * covers what only a browser has: the shell's banner and the controls turned off.
 */
import { rejectionOf } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
import type { QueryClient } from '@tanstack/svelte-query';
import { render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';

import { callBureau } from '../lib/bureau-client.ts';
import { settle } from '../lib/fake-timers.test-support.ts';
import { ServerUnreachableError } from '../lib/faults.ts';
import { installFetchImplementation } from '../lib/live-source/fetch.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../lib/scopes.svelte.ts';
import { ChatSessionState, MAX_RECONNECT_ATTEMPTS } from '../routes/chat/chat-session.svelte.ts';
import type { ConnectionMonitor } from './connection.svelte.ts';
import { CONNECTION_COPY, RETRY_LABEL, STALE_DATA_LABEL, VIEW_COPY } from './copy.ts';
import { holdChangingActions } from './shell/changing-actions.ts';
import Harness from './view-frame.test-harness.svelte';
import { probeFor } from './view-probes.ts';
import type { ViewName } from './views.ts';

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  jest.useRealTimers();
});

type HostMode = 'answers' | 'stopped' | 'fails';

/**
 * A host whose schedules list answers, is stopped (no answer at all), or answers with a 500.
 * `empty` makes the list answer with nothing in it. `writes` counts the writes that reached it.
 */
function host(initial: HostMode) {
  const state = { mode: initial, schedulesRequests: 0, writes: 0, empty: false };
  restoreFetch = installFetchImplementation(async (input, init) => {
    const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(text, 'http://localhost');
    if (state.mode === 'stopped') throw new TypeError('Failed to fetch');
    if (url.pathname.endsWith('/health')) return Response.json({ status: 'ok' });
    if (init?.method !== undefined && init.method !== 'GET') state.writes += 1;
    state.schedulesRequests += 1;
    if (state.mode === 'fails') {
      return Response.json({ error: 'The server broke.' }, { status: 500 });
    }
    return state.empty
      ? Response.json({ items: [], total: 0 })
      : Response.json({ items: [{ id: 'schedule-1' }], total: 1 });
  });
  return state;
}

function mountSchedules(view: ViewName = 'schedules') {
  let queryClient: QueryClient | undefined;
  let monitor: ConnectionMonitor | undefined;
  const result = render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
      view,
      onQueryClient: (created: QueryClient) => {
        queryClient = created;
      },
      probeHost: () => fetch('http://localhost/api/v1/health'),
      onConnection: (created: ConnectionMonitor) => {
        monitor = created;
      },
    },
  } as never);
  const frame = () => result.container.querySelector<HTMLElement>('.weft-view')!;
  return { ...result, frame, queryClient: () => queryClient!, monitor: () => monitor! };
}

describe('the view frame and the connection monitor', () => {
  test('host stops while a loaded page is open: the data stays, dimmed, and the host is unreachable', async () => {
    const state = host('answers');
    const page = mountSchedules();
    await page.findByTestId('content');
    expect(page.frame().dataset['stale']).toBeUndefined();

    state.mode = 'stopped';
    await page.queryClient().refetchQueries({ queryKey: ['view'] });

    await waitFor(() => expect(page.frame().dataset['stale']).toBe('true'));
    expect(page.getByTestId('content')).not.toBeNull();
    expect(page.frame().dataset['state']).toBe('ready');
    expect(Date.parse(page.frame().dataset['staleSince'] ?? '')).toBeGreaterThan(0);
    expect(page.monitor().unreachable).toBe(true);
  });

  test('a refetch gets a 5xx while the server answers: the error says what failed, the host stays reachable', async () => {
    const state = host('answers');
    const page = mountSchedules();
    await page.findByTestId('content');

    state.mode = 'fails';
    await page.queryClient().refetchQueries({ queryKey: ['view'] });

    await waitFor(() => expect(page.frame().dataset['stale']).toBe('true'));
    expect(
      page.getByRole('heading', { level: 2, name: VIEW_COPY.schedules.error.title }),
    ).not.toBeNull();
    expect(page.getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
    expect(page.getByTestId('content')).not.toBeNull();
    expect(page.monitor().unreachable).toBe(false);
  });

  test('the network fails on first load with nothing to show: a full-page unreachable state', async () => {
    host('stopped');
    const page = mountSchedules();
    expect(
      await page.findByRole('heading', { level: 1, name: CONNECTION_COPY.page.title }),
    ).not.toBeNull();
    expect(page.frame().dataset['state']).toBe('unreachable');
    expect(page.queryByTestId('content')).toBeNull();
    expect(page.monitor().unreachable).toBe(true);
  });

  test('the host returns: the stale mark clears and the data is fetched again', async () => {
    const state = host('answers');
    const page = mountSchedules();
    await page.findByTestId('content');
    state.mode = 'stopped';
    await page.queryClient().refetchQueries({ queryKey: ['view'] });
    await waitFor(() => expect(page.frame().dataset['stale']).toBe('true'));

    const before = state.schedulesRequests;
    state.mode = 'answers';
    await waitFor(() => expect(page.monitor().unreachable).toBe(false));
    await waitFor(() => expect(page.frame().dataset['stale']).toBeUndefined());
    await waitFor(() => expect(state.schedulesRequests).toBeGreaterThan(before));
    expect(page.frame().dataset['state']).toBe('ready');
  });

  test('a write is refused at the request while the host is unreachable, and allowed again once it answers', async () => {
    const state = host('answers');
    const page = mountSchedules();
    await page.findByTestId('content');
    state.mode = 'stopped';
    await page.queryClient().refetchQueries({ queryKey: ['view'] });
    await waitFor(() => expect(page.monitor().unreachable).toBe(true));

    // Through the Weft client, which is not the mutation cache, and through the Bureau's.
    const client = new HttpClient({ baseUrl: 'http://localhost/api' });
    state.mode = 'answers';
    expect(await rejectionOf(client.cancel('run-1'))).toBeInstanceOf(ServerUnreachableError);
    expect(await rejectionOf(callBureau('bureau.tasks.cancel', { taskId: 't' }))).toBeInstanceOf(
      ServerUnreachableError,
    );
    expect(state.writes).toBe(0);

    await waitFor(() => expect(page.monitor().unreachable).toBe(false));
    await client.cancel('run-1');
    expect(state.writes).toBe(1);
  });

  test('a view that swallows its failure succeeds against a stopped host: the host stays unreachable', async () => {
    const state = host('answers');
    const page = mountSchedules();
    await page.findByTestId('content');
    state.mode = 'stopped';
    await page.queryClient().refetchQueries({ queryKey: ['view'] });
    await waitFor(() => expect(page.monitor().unreachable).toBe(true));
    const stoppedAt = page.monitor().lastHealthyAt;

    // The reviews probe catches the network failure and answers "not empty", as COR-1612 decided,
    // so opening Reviews with the host stopped is a query that succeeds.
    const probe = probeFor('reviews', {}, undefined, new URLSearchParams())!;
    const client = new HttpClient({ baseUrl: 'http://localhost/api' });
    const answer = await page.queryClient().fetchQuery({
      queryKey: ['view', 'reviews'],
      queryFn: () => probe(client, page.queryClient()),
    });
    expect(answer).toEqual({ empty: false });

    expect(page.monitor().unreachable).toBe(true);
    expect(page.monitor().lastHealthyAt).toBe(stoppedAt);
    expect(page.frame().dataset['stale']).toBe('true');
  });

  test('a 5xx refetch on an empty view says what failed, with Retry and the age of what is shown', async () => {
    const state = host('answers');
    state.empty = true;
    const page = mountSchedules();
    await waitFor(() => expect(page.frame().dataset['state']).toBe('empty'));

    state.mode = 'fails';
    await page.queryClient().refetchQueries({ queryKey: ['view'] });

    await waitFor(() => expect(page.frame().dataset['stale']).toBe('true'));
    expect(page.frame().dataset['state']).toBe('empty');
    expect(
      page.getByRole('heading', { level: 2, name: VIEW_COPY.schedules.error.title }),
    ).not.toBeNull();
    expect(page.getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
    expect(page.frame().textContent).toContain(STALE_DATA_LABEL);
    expect(page.monitor().unreachable).toBe(false);
  });

  test('a 5xx refetch shows the age as text on a view that has data too', async () => {
    const state = host('answers');
    const page = mountSchedules();
    await page.findByTestId('content');
    state.mode = 'fails';
    await page.queryClient().refetchQueries({ queryKey: ['view'] });
    await waitFor(() => expect(page.frame().dataset['stale']).toBe('true'));
    expect(page.frame().textContent).toContain(STALE_DATA_LABEL);
  });
});

describe('the controls a changing action holds', () => {
  test('a Save the page keeps disabled until it is edited stays held after the edit, and the page state is untouched', () => {
    const root = document.createElement('main');
    root.innerHTML =
      '<form><input id="name"><button type="submit" id="save" disabled>Save</button></form>';
    document.body.append(root);
    const save = root.querySelector<HTMLButtonElement>('#save')!;
    const release = holdChangingActions(root, CONNECTION_COPY.changesOff);
    expect(save.disabled).toBe(true);
    // The first keystroke of the outage enables Save, as the page does.
    save.disabled = false;
    expect(save.getAttribute('aria-disabled')).toBe('true');
    let submitted = 0;
    root.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted += 1;
    });
    save.click();
    expect(submitted).toBe(0);
    release();
    // The seam gave back exactly what it took: the page's own state is what it was.
    expect(save.disabled).toBe(false);
    expect(save.hasAttribute('aria-disabled')).toBe(false);
    root.remove();
  });
});

describe('a chat session', () => {
  const sessions: ChatSessionState[] = [];
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    jest.restoreAllMocks();
  });

  const encoded = (event: unknown) =>
    new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

  /** A thread that fails `failures` times, then answers with a run that has begun. */
  function open(failures: number) {
    const state = { calls: 0, failures };
    const session = new ChatSessionState({
      sessionId: 'thread',
      agentName: () => 'assistant',
      fetch: async () => {
        state.calls += 1;
        if (state.calls <= state.failures) throw new TypeError('Failed to fetch');
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoded({ type: 'RUN_STARTED', threadId: 'thread', runId: 'run' }),
              );
              controller.enqueue(encoded({ type: 'STATE_SNAPSHOT', snapshot: {} }));
            },
          }),
        );
      },
    });
    sessions.push(session);
    return { session, state };
  }

  /** Lets every retry timer that is waiting fire, then the work it started settle. */
  async function runRetries(times: number): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      jest.runOnlyPendingTimers();
      await settle();
    }
  }

  test('a drop whose retry within eight succeeds resumes, with no Reconnect and one copy of the transcript', async () => {
    jest.useFakeTimers();
    const { session, state } = open(3);
    await session.attach();
    expect(session.disconnected).toBe(false);
    await runRetries(3);
    await waitUntil(() => state.calls >= 4, { message: 'the fourth request' });
    expect(session.disconnected).toBe(false);
    expect(new Set(session.conversation.ids).size).toBe(session.conversation.ids.length);
  });

  test('eight failed retries leave the session disconnected', async () => {
    jest.useFakeTimers();
    const { session, state } = open(Number.POSITIVE_INFINITY);
    await session.attach();
    for (let retry = 1; retry < MAX_RECONNECT_ATTEMPTS; retry += 1) {
      expect(session.disconnected).toBe(false);
      await runRetries(1);
    }
    expect(state.calls).toBe(MAX_RECONNECT_ATTEMPTS);
    expect(session.disconnected).toBe(true);
  });

  test('a Reconnect that succeeds clears the state', async () => {
    jest.useFakeTimers();
    const { session, state } = open(MAX_RECONNECT_ATTEMPTS);
    await session.attach();
    await runRetries(MAX_RECONNECT_ATTEMPTS - 1);
    expect(session.disconnected).toBe(true);
    await session.reconnect();
    expect(state.calls).toBe(MAX_RECONNECT_ATTEMPTS + 1);
    expect(session.disconnected).toBe(false);
  });

  test('a Reconnect that fails stays disconnected, tries once, and can be pressed again', async () => {
    jest.useFakeTimers();
    const { session, state } = open(Number.POSITIVE_INFINITY);
    await session.attach();
    await runRetries(MAX_RECONNECT_ATTEMPTS - 1);
    expect(session.disconnected).toBe(true);
    await session.reconnect();
    expect(session.disconnected).toBe(true);
    const calls = state.calls;
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(state.calls).toBe(calls);
    await session.reconnect();
    expect(state.calls).toBe(calls + 1);
    expect(session.disconnected).toBe(true);
  });

  test('the conversation changing during retries stops the old chat’s retries', async () => {
    jest.useFakeTimers();
    const { session, state } = open(Number.POSITIVE_INFINITY);
    await session.attach();
    await runRetries(2);
    const calls = state.calls;
    session.dispose();
    jest.advanceTimersByTime(120_000);
    await settle();
    expect(state.calls).toBe(calls);
    const next = open(0);
    await next.session.attach();
    expect(next.session.disconnected).toBe(false);
  });
});
