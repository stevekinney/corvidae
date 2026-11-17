import { describe, expect, it } from 'bun:test';
import { principalFromApiKey, type OperationFault } from '@lostgradient/weft';

import { buildBureau } from './bureau-handler-fixtures.test-support.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

const API_KEY = 'weft-code-key';

const authentication = {
  auditSink: () => undefined,
  resolveApiKeyPrincipal: async (key: string) =>
    key === API_KEY
      ? principalFromApiKey({ subject: 'tester', scopes: ['events:read', ...BUREAU_SCOPES] })
      : null,
};

async function subscriptionFaultBody(weftCode: string): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> {
  const bureau = await buildBureau({ id: 'weft-code-bureau' });
  try {
    // The fault a feed throws while it decodes the caller's cursor reaches the route unchanged.
    const fault = {
      code: 'NotFound',
      message: 'gone',
      data: { resource: 'cursor', weftCode },
    } as unknown as OperationFault;
    Object.assign(bureau.internals.eventFeed.feed, {
      decodeCursor: () => {
        throw fault;
      },
    });
    const handler = createBureauHandler(bureau, { authentication });
    const response = await handler(
      new Request(
        'http://localhost/v1/subscriptions/bureau.events?bureauId=weft-code-bureau&fromCursor=1',
        {
          headers: { 'X-API-Key': API_KEY, Accept: 'text/event-stream' },
        },
      ),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await bureau.dispose();
  }
}

describe('the subscription route of a default createBureauHandler', () => {
  it('drops a weftCode that is not one of Weft error codes', async () => {
    const { status, body } = await subscriptionFaultBody('NotAWeftErrorCode');
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'gone', data: { resource: 'cursor' } });
  });

  it('keeps a weftCode that is one of Weft error codes', async () => {
    const { status, body } = await subscriptionFaultBody('WorkflowNotFoundError');
    expect(status).toBe(404);
    expect(body).toEqual({
      error: 'gone',
      weftCode: 'WorkflowNotFoundError',
      data: { resource: 'cursor' },
    });
  });
});
