/**
 * COR-2517 — the Bureau transport answers a JSON-RPC fault as an `HttpClientError` that keeps the
 * `retryable` and `remediation` the server's fault carried, so `classifyFault` can show them.
 */
import { describe, expect, test } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing';
import { HttpClientError } from '@lostgradient/weft/testing';

import { postBureauCall } from './bureau-transport.ts';
import { classifyFault } from './faults.ts';

/** A JSON-RPC answer carrying a fault, as the Bureau handler writes it. */
function faultAnswer(data: Record<string, unknown>): typeof fetch {
  return (async () =>
    Response.json({
      jsonrpc: '2.0',
      id: 'bureau.hooks.get',
      error: { code: -32028, message: 'Bureau is shutting down.', data },
    })) as unknown as typeof fetch;
}

describe('postBureauCall', () => {
  test('raises a fault with the retryable and remediation its data carried, and classifyFault shows them', async () => {
    const error = await rejectionOf(
      postBureauCall(
        'http://host/jsonrpc',
        'bureau.hooks.get',
        { hookId: 'h' },
        {
          fetch: faultAnswer({
            httpStatus: 503,
            weftCode: 'Unavailable',
            retryable: true,
            remediation: 'Try again in a minute.',
          }),
        },
      ),
    );

    expect(error).toBeInstanceOf(HttpClientError);
    expect(error).toMatchObject({
      status: 503,
      retryable: true,
      remediation: 'Try again in a minute.',
    });
    expect(classifyFault(error)).toMatchObject({
      retryable: true,
      remediation: 'Try again in a minute.',
    });
  });

  test('never lets the name of the server’s own part, "Bureau", reach a screen, in the message or the remediation', async () => {
    const error = await rejectionOf(
      postBureauCall(
        'http://host/jsonrpc',
        'bureau.hooks.get',
        { hookId: 'h' },
        {
          fetch: faultAnswer({
            httpStatus: 503,
            remediation: 'Wait until Bureau has restarted.',
          }),
        },
      ),
    );
    expect(error).toMatchObject({
      message: 'The server is shutting down.',
      remediation: 'Wait until the server has restarted.',
    });
    expect(JSON.stringify([(error as Error).message, classifyFault(error)])).not.toContain(
      'Bureau',
    );
  });

  test('keeps a retryable of false, and leaves both out for a fault that carried neither', async () => {
    const refused = await rejectionOf(
      postBureauCall(
        'http://host/jsonrpc',
        'bureau.hooks.get',
        {},
        {
          fetch: faultAnswer({ httpStatus: 404, weftCode: 'NotFound', retryable: false }),
        },
      ),
    );
    expect(refused).toMatchObject({ status: 404, retryable: false });
    expect((refused as HttpClientError).remediation).toBeUndefined();

    const older = await rejectionOf(
      postBureauCall(
        'http://host/jsonrpc',
        'bureau.hooks.get',
        {},
        {
          fetch: faultAnswer({ httpStatus: 404, weftCode: 'NotFound' }),
        },
      ),
    );
    expect((older as HttpClientError).retryable).toBeUndefined();
    expect((older as HttpClientError).remediation).toBeUndefined();
  });

  test('drops advice of the wrong type instead of passing it on', async () => {
    const error = await rejectionOf(
      postBureauCall(
        'http://host/jsonrpc',
        'bureau.hooks.get',
        {},
        {
          fetch: faultAnswer({
            httpStatus: 500,
            weftCode: 'EngineFailure',
            retryable: 'yes',
            remediation: 7,
          }),
        },
      ),
    );
    expect((error as HttpClientError).retryable).toBeUndefined();
    expect((error as HttpClientError).remediation).toBeUndefined();
  });
});
