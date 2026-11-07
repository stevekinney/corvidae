/**
 * The attention count the sidebar's Health dot reads (`bureau.health.attention`): the count alone,
 * a refusal let through for the caller to leave the dot out, and an answer that is not a count
 * refused rather than shown. The notification bell reads the rules that are firing from the same
 * answer.
 */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { getAttentionCount, listAttentionAlerts, listAttentionItems } from './bureau-attention.ts';

function answering(
  result: unknown,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (_input, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { id?: unknown };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
}

describe('getAttentionCount', () => {
  test('asks bureau.health.attention and answers its count', async () => {
    const methods: unknown[] = [];
    const count = await getAttentionCount({
      fetch: async (input, init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          id?: unknown;
          method?: unknown;
        };
        methods.push(body.method);
        return answering({ items: [{ kind: 'alert' }], count: 3, checks: [] })(input, init);
      },
    });
    expect(count).toBe(3);
    expect(methods).toEqual(['bureau.health.attention']);
  });

  test('answers zero when nothing needs attention', async () => {
    expect(await getAttentionCount({ fetch: answering({ items: [], count: 0, checks: [] }) })).toBe(
      0,
    );
  });

  test('lets a refusal through, so the dot can be left out', async () => {
    const refused = getAttentionCount({
      fetch: async () =>
        Response.json(
          {
            jsonrpc: '2.0',
            id: 'bureau.health.attention',
            error: { code: -32001, message: 'Forbidden', data: { httpStatus: 403 } },
          },
          { status: 403 },
        ),
    });
    const failure = await refused.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HttpClientError);
    expect((failure as HttpClientError).status).toBe(403);
  });

  test('refuses an answer that is not a count', async () => {
    for (const result of [{}, { count: -1 }, { count: 1.5 }, { count: '3' }, null]) {
      const outcome = await getAttentionCount({ fetch: answering(result) }).then(
        () => 'counted',
        () => 'refused',
      );
      expect(outcome, JSON.stringify(result)).toBe('refused');
    }
  });
});

describe('listAttentionAlerts', () => {
  const storage = {
    kind: 'alert',
    area: 'storage',
    at: 1_000,
    metric: 'storage.size',
    currentValue: 1_717_986_918,
    threshold: 1_073_741_824,
  };

  test('lists the rules that are firing and leaves every other kind of problem out', async () => {
    const alerts = await listAttentionAlerts({
      fetch: answering({
        items: [
          storage,
          { kind: 'missed-runs', area: 'schedules', at: 900, scheduleId: 's-1', count: 4 },
          { kind: 'no-provider', area: 'providers', at: null, provider: null },
        ],
        count: 3,
        checks: [],
      }),
    });

    expect(alerts).toEqual([{ metric: 'storage.size', at: 1_000, currentValue: 1_717_986_918 }]);
  });

  test('lists nothing when nothing needs attention', async () => {
    expect(
      await listAttentionAlerts({ fetch: answering({ items: [], count: 0, checks: [] }) }),
    ).toEqual([]);
  });

  test('lets a refusal through, so the bell lists no such item', async () => {
    const failure = await listAttentionAlerts({
      fetch: async () =>
        Response.json(
          {
            jsonrpc: '2.0',
            id: 'bureau.health.attention',
            error: { code: -32001, message: 'Forbidden', data: { httpStatus: 403 } },
          },
          { status: 403 },
        ),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(HttpClientError);
  });

  test('refuses an answer that has no list of problems', async () => {
    const outcome = await listAttentionAlerts({ fetch: answering({ count: 1 }) }).then(
      () => 'listed',
      () => 'refused',
    );
    expect(outcome).toBe('refused');
  });
});

describe('listAttentionItems', () => {
  const missed = {
    kind: 'missed-runs',
    area: 'schedules',
    at: 900,
    scheduleId: 's-1',
    scheduleName: 'Daily summary',
    count: 4,
    since: 100,
    occurrences: [{ occurrence: 100, count: 4 }],
  };

  test('lists every kind of problem it has a schema for', async () => {
    const items = await listAttentionItems({
      fetch: answering({
        items: [
          { kind: 'no-provider', area: 'providers', at: null, provider: null },
          {
            kind: 'alert',
            area: 'storage',
            at: 1_000,
            metric: 'storage.size',
            currentValue: 5,
            threshold: 4,
          },
          missed,
          {
            kind: 'hook-failed',
            area: 'hooks',
            at: 800,
            hookId: 'h-1',
            hookName: 'Notify',
            gaveUp: true,
            status: 410,
            host: 'hooks.example.test',
            attempts: 8,
            error: null,
          },
          {
            kind: 'plugin-not-loaded',
            area: 'plugins',
            at: null,
            plugin: 'voyage',
            problems: ['x'],
          },
        ],
        count: 5,
        checks: [],
      }),
    });

    expect(items.map((item) => item.kind)).toEqual([
      'no-provider',
      'alert',
      'missed-runs',
      'hook-failed',
      'plugin-not-loaded',
    ]);
    // Each item is the Bureau's record as the shared schema reads it (`readAttention`).
    expect(items[1]).toEqual({
      kind: 'alert',
      area: 'storage',
      at: 1_000,
      metric: 'storage.size',
      currentValue: 5,
      threshold: 4,
    });
    expect(items[2]).toEqual({ ...missed, kind: 'missed-runs', area: 'schedules' } as const);
  });

  test('leaves out a kind it has no words for, which the Health dot still counts', async () => {
    const items = await listAttentionItems({
      fetch: answering({
        items: [{ kind: 'something-new', area: 'x', at: 1 }, missed],
        count: 2,
        checks: [],
      }),
    });
    expect(items.map((item) => item.kind)).toEqual(['missed-runs']);
  });

  test('lists nothing when nothing needs attention, and lets a refusal through', async () => {
    expect(
      await listAttentionItems({ fetch: answering({ items: [], count: 0, checks: [] }) }),
    ).toEqual([]);
    const failure = await listAttentionItems({
      fetch: async () =>
        Response.json(
          {
            jsonrpc: '2.0',
            id: 'bureau.health.attention',
            error: { code: -32001, message: 'Forbidden', data: { httpStatus: 403 } },
          },
          { status: 403 },
        ),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HttpClientError);
  });
});
