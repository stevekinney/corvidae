/**
 * Every view renders outside the application shell, under only what a host page can supply (a
 client and a query client). Before COR-1449 each one threw on mount: `getPrincipalStore()` and `getFleetEventSource()`
 * found no provider, because only the dashboard's shell provided them.
 */
import { HttpClient } from '@lostgradient/weft';
import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Component } from 'svelte';

import { installFetchImplementation } from '../lib/live-source/fetch.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../lib/scopes.svelte.ts';
import DashboardView from './dashboard-view.svelte';
import HostPage from './host-page.test-harness.svelte';
import ProvidedHostPage from './provided-host-page.test-harness.svelte';
import ReviewsView from './reviews-view.svelte';
import SchedulesView from './schedules-view.svelte';
import StorageView from './storage-view.svelte';
import SystemView from './system-view.svelte';
import WorkersView from './workers-view.svelte';
import WorkflowsView from './workflows-view.svelte';

interface Request {
  readonly url: string;
  /** The JSON-RPC method, for a request to `/jsonrpc`. */
  readonly operation: string | undefined;
}

function jsonRpcCall(body: RequestInit['body']): { id: unknown; method: string } | undefined {
  if (typeof body !== 'string') return undefined;
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const method: unknown = Reflect.get(parsed, 'method');
  return typeof method === 'string' ? { id: Reflect.get(parsed, 'id'), method } : undefined;
}

/** The principal probe's answer: the granted scopes, or a failure with this HTTP status. */
type PrincipalAnswer = readonly string[] | { readonly httpStatus: number };

function principalResponse(id: unknown, answer: PrincipalAnswer): Response {
  if ('httpStatus' in answer) {
    return Response.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: 'principal probe failed', data: answer },
    });
  }
  return Response.json({
    jsonrpc: '2.0',
    id,
    result: { method: 'api-key', subject: 'host', scopes: answer },
  });
}

/**
 * Answers the principal probe with `principal` and holds every other request open until it is
 * aborted, so a view settles without a server, and the fleet event source it opens is torn down
 * by its own `close()`.
 */
function stubServer(principal: PrincipalAnswer = AUTHORIZATION_SCOPES): {
  requests: Request[];
  restore: () => void;
} {
  const requests: Request[] = [];
  const restore = installFetchImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = jsonRpcCall(init?.body);
    requests.push({ url, operation: call?.method });
    if (call?.method === 'weft.system.principal') {
      return Promise.resolve(principalResponse(call.id, principal));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The request was aborted.', 'AbortError'));
      });
    });
  });
  return { requests, restore };
}

let server: ReturnType<typeof stubServer> | undefined;

afterEach(() => {
  server?.restore();
  server = undefined;
});

function client(): HttpClient {
  return new HttpClient({ baseUrl: 'http://localhost:7233' });
}

function toastRegions(container: HTMLElement): number {
  return container.querySelectorAll('.cinder-toast-region').length;
}

/** Each view with the title its route renders once it has mounted. */
const views: readonly (readonly [string, Component, string])[] = [
  ['DashboardView', DashboardView, 'Operations overview'],
  ['WorkflowsView', WorkflowsView, 'Runs'],
  ['ReviewsView', ReviewsView, 'Reviews'],
  ['WorkersView', WorkersView, 'Workers'],
  ['SchedulesView', SchedulesView, 'Schedules'],
  ['StorageView', StorageView, 'Storage'],
  ['SystemView', SystemView, 'System'],
];

describe('a view rendered outside the application shell', () => {
  for (const [name, view, title] of views) {
    test(`${name} renders with only a client and a query client`, async () => {
      server = stubServer();
      const { container, findByRole } = render(HostPage, { props: { client: client(), view } });

      expect(await findByRole('heading', { level: 1, name: title })).not.toBeNull();
      expect(server.requests[0]?.operation).toBe('weft.system.principal');
      // The view mounted its own toast region, since no ancestor provided one.
      expect(toastRegions(container)).toBe(1);
    });
  }

  test('a view gates its controls on the principal it resolved for itself', async () => {
    server = stubServer([]);
    const { findByText, queryByRole } = render(HostPage, {
      props: { client: client(), view: StorageView },
    });

    expect(await findByText('Storage access requires storage:admin')).not.toBeNull();
    expect(queryByRole('tablist')).toBeNull();
  });

  test('a rejected credential leaves the view rendered with every scope locked', async () => {
    server = stubServer({ httpStatus: 401 });
    const { findByText, queryByRole } = render(HostPage, {
      props: { client: client(), view: StorageView },
    });

    expect(await findByText('Storage access requires storage:admin')).not.toBeNull();
    expect(queryByRole('tablist')).toBeNull();
  });

  test('a failed principal probe falls open to an anonymous principal, as the application shell does', async () => {
    server = stubServer({ httpStatus: 500 });
    const { findByText, queryByRole } = render(HostPage, {
      props: { client: client(), view: StorageView },
    });

    expect(await findByText('Storage access requires storage:admin')).not.toBeNull();
    expect(queryByRole('tablist')).toBeNull();
  });

  test('a view granted the scope renders the surface the scope unlocks', async () => {
    server = stubServer(['storage:admin']);
    const { findByRole } = render(HostPage, { props: { client: client(), view: StorageView } });

    expect(await findByRole('tab', { name: 'KV browser' })).not.toBeNull();
  });
});

describe('a view rendered below the providers the application shell supplies', () => {
  test('uses the ancestor principal store and toast host instead of its own', async () => {
    server = stubServer();
    const { container, findByRole } = render(ProvidedHostPage, {
      props: { client: client(), view: StorageView, scopes: ['storage:admin'] },
    });

    expect(await findByRole('tab', { name: 'KV browser' })).not.toBeNull();
    expect(server.requests.map(({ operation }) => operation)).not.toContain(
      'weft.system.principal',
    );
    expect(toastRegions(container)).toBe(0);
  });
});
