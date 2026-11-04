/**
 * The attention count the sidebar's Health dot reads (`bureau.health.attention`): the count alone,
 * a refusal let through for the caller to leave the dot out, and an answer that is not a count
 * refused rather than shown.
 */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { getAttentionCount } from './bureau-attention.ts';

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
