import { QueryClient } from '@tanstack/svelte-query';
import { describe, expect, test } from 'bun:test';
import { BureauEventSource } from '../lib/live-source/bureau-event-source.svelte.ts';
import { resolveHostPrincipal } from '../lib/scopes.svelte.ts';
import { armWriteGuard } from '../lib/write-guard.ts';

import { WorkspaceLifetime, workspaceStorage } from './workspace-lifetime.ts';

describe('workspace lifetime', () => {
  test('disposes the previous identity and ignores its late resolution', async () => {
    const completed: string[] = [];
    const closed: string[] = [];
    let releaseA!: (identity: string) => void;
    const a = new Promise<string>((resolve) => {
      releaseA = resolve;
    });
    const lifetime = new WorkspaceLifetime<string>({
      resolve: () => a,
      open: (identity) => {
        completed.push(identity);
        return () => closed.push(identity);
      },
      fail: () => completed.push('failure'),
    });
    const pending = lifetime.refresh();
    await lifetime.refresh(async () => 'workspace-b:actor-b');
    releaseA('workspace-a:actor-a');
    await pending;
    expect(completed).toEqual(['workspace-b:actor-b']);
    lifetime.dispose();
    expect(closed).toEqual(['workspace-b:actor-b']);
  });

  test('closes an active lifetime before resolving a replacement or a failure', async () => {
    const events: string[] = [];
    const lifetime = new WorkspaceLifetime<string>({
      resolve: async () => 'workspace-a:actor-a',
      open: (identity) => {
        events.push(`open:${identity}`);
        return () => events.push(`close:${identity}`);
      },
      fail: () => events.push('failure'),
    });
    await lifetime.refresh();
    await lifetime.refresh(async () => {
      throw new Error('membership lost');
    });
    expect(events).toEqual(['open:workspace-a:actor-a', 'close:workspace-a:actor-a', 'failure']);
  });
});

test('private storage separates workspaces and actors and ignores old unscoped entries', () => {
  const values = new Map<string, string>([['interborough:notifications:read', 'legacy']]);
  const raw = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const first = workspaceStorage({ workspaceId: 'workspace-a', actorId: 'actor-a' }, raw);
  const otherActor = workspaceStorage({ workspaceId: 'workspace-a', actorId: 'actor-b' }, raw);
  const otherWorkspace = workspaceStorage({ workspaceId: 'workspace-b', actorId: 'actor-a' }, raw);
  expect(first.getItem('interborough:notifications:read')).toBeNull();
  first.setItem('interborough:notifications:read', 'private');
  expect(first.getItem('interborough:notifications:read')).toBe('private');
  expect(otherActor.getItem('interborough:notifications:read')).toBeNull();
  expect(otherWorkspace.getItem('interborough:notifications:read')).toBeNull();
});

test('late private results cannot populate the replacement cache after lifetime disposal', async () => {
  const pending = Promise.withResolvers<string>();
  const opened: string[] = [];
  const closed: string[] = [];
  let active: QueryClient | undefined;
  const lifetime = new WorkspaceLifetime<string>({
    resolve: async () => 'workspace-a:actor-a',
    open: (identity) => {
      const cache = new QueryClient();
      active = cache;
      opened.push(identity);
      return () => {
        void cache.cancelQueries();
        cache.clear();
        closed.push(identity);
      };
    },
    fail: () => {},
  });
  await lifetime.refresh();
  const oldCache = active!;
  const oldResult = oldCache
    .fetchQuery({ queryKey: ['private', 'same-id'], queryFn: () => pending.promise })
    .catch(() => undefined);
  await lifetime.refresh(async () => 'workspace-b:actor-a');
  const workspaceB = active!;
  workspaceB.setQueryData(['private', 'same-id'], 'workspace-b value');
  pending.resolve('workspace-a secret');
  await oldResult;
  expect(workspaceB.getQueryData(['private', 'same-id'])).toBe('workspace-b value');
  await lifetime.refresh(async () => 'workspace-a:actor-b');
  const actorB = active!;
  expect(actorB.getQueryData(['private', 'same-id'])).toBeUndefined();
  expect(closed).toEqual(['workspace-a:actor-a', 'workspace-b:actor-a']);
  expect(opened).toEqual(['workspace-a:actor-a', 'workspace-b:actor-a', 'workspace-a:actor-b']);
  lifetime.dispose();
});

test('replacing a lifetime aborts its active Bureau event stream', async () => {
  const originalFetch = globalThis.fetch;
  const connected = Promise.withResolvers<void>();
  let aborted = false;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        return Response.json({ jsonrpc: '2.0', id: 'x', result: { id: 'bureau-1' } });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              controller.close();
            },
            { once: true },
          );
          connected.resolve();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
    { preconnect: originalFetch.preconnect },
  );
  const lifetime = new WorkspaceLifetime<string>({
    resolve: async () => 'workspace-a:actor-a',
    open: () => {
      const source = new BureauEventSource();
      source.subscribe(() => {});
      return () => source.close();
    },
    fail: () => {},
  });
  try {
    await lifetime.refresh();
    await connected.promise;
    await lifetime.refresh(async () => 'workspace-b:actor-a');
    expect(aborted).toBe(true);
  } finally {
    lifetime.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('a forbidden stale request followed by a marked principal mismatch opens the new lifetime', async () => {
  const current = { identity: '', expired: false };
  const openedB = Promise.withResolvers<void>();
  const headers = { 'x-api-key': 'fixture' };
  const target = {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith('/resource')) return new Response(null, { status: 403 });
        const expected = new Headers(init?.headers).get('x-interborough-expected-identity');
        if (expected !== null)
          return new Response(null, {
            status: 409,
            headers: { 'x-interborough-identity-mismatch': '1' },
          });
        return Response.json({
          method: 'api-key',
          subject: 'credential',
          scopes: [],
          workspace: { workspaceId: 'a', actorId: 'b' },
        });
      },
      { preconnect: fetch.preconnect },
    ),
  };
  const hostFetch = (input: RequestInfo | URL, init?: RequestInit) =>
    target.fetch(
      new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost'),
      init,
    );
  const lifetime = new WorkspaceLifetime<string>({
    resolve: async () => {
      const principal = await resolveHostPrincipal(headers, hostFetch);
      return principal!.workspace!.actorId;
    },
    open: (identity) => {
      current.identity = identity;
      if (identity === 'b') openedB.resolve();
      const release = armWriteGuard(
        () => false,
        ['http://localhost'],
        target,
        () => {
          if (current.identity === identity) current.expired = true;
        },
        {
          identity: { workspaceId: 'a', actorId: identity },
          onMismatch: () => {
            if (current.identity === identity) void lifetime.refresh();
          },
          onForbidden: () => {
            void resolveHostPrincipal(headers, hostFetch).catch(() => {
              if (current.identity === identity) current.expired = true;
            });
          },
        },
      );
      return () => {
        current.identity = '';
        release();
      };
    },
    fail: () => {
      current.expired = true;
    },
  });
  try {
    await lifetime.refresh(async () => 'a');
    await target.fetch('http://localhost/resource');
    await openedB.promise;
    await Promise.resolve();
    expect(current.identity).toBe('b');
    expect(current.expired).toBe(false);
  } finally {
    lifetime.dispose();
  }
});
