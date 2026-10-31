/**
 * The connection monitor on its own: what makes the server unreachable, how it learns the server is
 * back, and what it does about it. The view frame's reading of it is in `states-matrix.test.ts`.
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { QueryClient } from '@tanstack/svelte-query';
import { afterEach, describe, expect, test } from 'bun:test';

import { ConnectionMonitor, connectionProbeDelayMs } from './connection.svelte.ts';

const monitors: ConnectionMonitor[] = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.dispose();
});

function open(probe: () => Promise<unknown>, onRecovered?: () => void) {
  const monitor = new ConnectionMonitor({
    probe,
    ...(onRecovered === undefined ? {} : { onRecovered }),
    probeDelayMs: () => 1,
  });
  monitors.push(monitor);
  return monitor;
}

describe('connectionProbeDelayMs', () => {
  test('doubles from one second and stops at eight', () => {
    expect([1, 2, 3, 4, 5, 9].map(connectionProbeDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
    ]);
  });
});

describe('ConnectionMonitor', () => {
  test('probes until the server answers, then says so once and refetches', async () => {
    let answers = false;
    let probes = 0;
    let recovered = 0;
    const monitor = open(
      async () => {
        probes += 1;
        if (!answers) throw new TypeError('Failed to fetch');
        return new Response('ok');
      },
      () => {
        recovered += 1;
      },
    );
    monitor.reportUnreachable();
    expect(monitor.unreachable).toBe(true);
    await waitUntil(() => probes >= 3, { message: 'three probes while down' });
    expect(monitor.unreachable).toBe(true);
    expect(recovered).toBe(0);

    answers = true;
    await waitUntil(() => !monitor.unreachable, { message: 'the server answering' });
    expect(recovered).toBe(1);
    const settled = probes;
    await quietFor(50);
    expect(probes).toBe(settled);
  });

  test('check asks once, now, and finds the server down or up', async () => {
    let answers = false;
    const monitor = open(async () => {
      if (!answers) throw new TypeError('Failed to fetch');
      return new Response('ok');
    });
    await monitor.check();
    expect(monitor.unreachable).toBe(true);
    answers = true;
    await monitor.check();
    expect(monitor.unreachable).toBe(false);
  });

  test('a reachable answer records when the server last answered', async () => {
    let now = 1_000;
    const monitor = new ConnectionMonitor({ probe: async () => 1, now: () => now });
    monitors.push(monitor);
    expect(monitor.lastHealthyAt).toBe(1_000);
    now = 5_000;
    monitor.reportReachable();
    expect(monitor.lastHealthyAt).toBe(5_000);
  });

  test('reads the query cache: an unanswered query makes it unreachable, and no query result clears it', async () => {
    let recovered = 0;
    let now = 1_000;
    // The probe never answers: the host is stopped.
    const monitor = new ConnectionMonitor({
      probe: async () => {
        throw new TypeError('Failed to fetch');
      },
      onRecovered: () => {
        recovered += 1;
      },
      probeDelayMs: () => 60_000,
      now: () => now,
    });
    monitors.push(monitor);
    const queryClient = new QueryClient();
    const stop = monitor.observe(queryClient);
    await queryClient
      .fetchQuery({
        queryKey: ['down'],
        queryFn: () => Promise.reject(new TypeError('Failed to fetch')),
        retry: false,
      })
      .catch(() => undefined);
    expect(monitor.unreachable).toBe(true);
    const stoppedAt = monitor.lastHealthyAt;

    now = 9_000;
    // A plain success, a probe that swallows its failure (the reviews view, COR-1612), one that
    // settles it (the schedules overlay), and a value written to the cache, all against a dead host.
    await queryClient.fetchQuery({ queryKey: ['up'], queryFn: async () => 1 });
    await queryClient.fetchQuery({
      queryKey: ['view', 'reviews'],
      queryFn: async () => {
        try {
          throw new TypeError('Failed to fetch');
        } catch {
          return { empty: false };
        }
      },
    });
    await queryClient.fetchQuery({
      queryKey: ['overlay'],
      queryFn: async () => {
        const settled = await Promise.allSettled([Promise.reject(new TypeError('x'))]);
        return settled.length;
      },
    });
    queryClient.setQueryData(['manual'], 1);

    expect(monitor.unreachable).toBe(true);
    expect(recovered).toBe(0);
    // The age of the data on screen does not move either: nothing newer arrived.
    expect(monitor.lastHealthyAt).toBe(stoppedAt);
    stop();
  });

  test('while reachable, a query success moves the age of the data forward', async () => {
    let now = 1_000;
    const monitor = new ConnectionMonitor({ probe: async () => 1, now: () => now });
    monitors.push(monitor);
    const queryClient = new QueryClient();
    const stop = monitor.observe(queryClient);
    now = 4_000;
    await queryClient.fetchQuery({ queryKey: ['up'], queryFn: async () => 1 });
    expect(monitor.lastHealthyAt).toBe(4_000);
    stop();
  });

  test('a query that failed with a server fault does not make it unreachable', async () => {
    const monitor = open(async () => new Response('ok'));
    const queryClient = new QueryClient();
    const stop = monitor.observe(queryClient);
    await queryClient
      .fetchQuery({
        queryKey: ['broken'],
        queryFn: () => Promise.reject(new Error('The server broke.')),
        retry: false,
      })
      .catch(() => undefined);
    expect(monitor.unreachable).toBe(false);
    stop();
  });
});
