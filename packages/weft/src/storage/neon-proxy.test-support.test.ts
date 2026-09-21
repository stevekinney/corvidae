/**
 * COR-1283: `createNeonTestProxy`'s non-upgrade-request path. The live-driver
 * proxy round trip itself is only exercised by `neon-live.test.ts`, which is
 * `describe.skipIf`'d whenever no real Postgres endpoint is available — this
 * standalone test needs no live database (the destination socket is
 * destroyed before any real forwarding could happen), so it always runs.
 */
import { describe, expect, it } from 'bun:test';

import { createNeonTestProxy } from './neon-proxy.test-support.ts';

describe('createNeonTestProxy', () => {
  it('answers a plain (non-upgrade) HTTP request with 400 and destroys the backing socket', async () => {
    await using proxy = createNeonTestProxy({ host: '127.0.0.1', port: 1 });

    const response = await fetch(`http://${proxy.address}/`);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('WebSocket connection required');
  });
});
