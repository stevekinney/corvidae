import { principalFromApiKey } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { buildBureau } from './bureau-handler-fixtures.test-support.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

const API_KEY = 'health-msgpack-key';

/** MessagePack for `{ "status": "ok" }`: a one-entry map, the key `status`, the value `ok`. */
const HEALTH_BYTES = Uint8Array.of(
  0x81,
  0xa6,
  0x73,
  0x74,
  0x61,
  0x74,
  0x75,
  0x73,
  0xa2,
  0x6f,
  0x6b,
);

describe('GET /v1/health on a default createBureauHandler', () => {
  it('answers a client that accepts application/msgpack with the MessagePack bytes of the status', async () => {
    const bureau = await buildBureau({ id: 'health-bureau' });
    try {
      const handler = createBureauHandler(bureau, {
        authentication: {
          auditSink: () => undefined,
          resolveApiKeyPrincipal: async (key: string) =>
            key === API_KEY
              ? principalFromApiKey({ subject: 'tester', scopes: [...BUREAU_SCOPES] })
              : null,
        },
      });
      const response = await handler(
        new Request('http://localhost/v1/health', {
          headers: { Accept: 'application/msgpack', 'X-API-Key': API_KEY },
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/msgpack');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(HEALTH_BYTES);
    } finally {
      await bureau.dispose();
    }
  });
});
