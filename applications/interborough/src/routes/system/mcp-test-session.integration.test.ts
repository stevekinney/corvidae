/**
 * `testMcpSession` against a REAL `serve()` (plan §11.3: no mock server): the
 * panel's `initialize` asks for protocol `2025-03-26`, and Weft's endpoint,
 * served through the official MCP SDK, must still complete that handshake on
 * its stateless 2025-era lane and answer in the revision the panel asked for.
 */
import { Engine, HttpClient, serve } from '@lostgradient/weft';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { workflows } from '../../../fixtures/workflows.ts';
import { testMcpSession } from './mcp-test-session.ts';

/** Not a secret — a fixed key for an ephemeral, localhost-only test server. */
const TEST_API_KEY = 'mcp-test-session-integration-key';

async function createTestEngine() {
  return Engine.create({ workflows });
}

let engine: Awaited<ReturnType<typeof createTestEngine>>;
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  engine = await createTestEngine();
  server = serve({
    engine,
    port: 0,
    auth: { apiKeys: [TEST_API_KEY], defaultApiKeyScopes: ['workflows:read'] },
  });
});

afterAll(async () => {
  await server.stop();
  await engine.shutdown();
});

function readSseResult(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  const data = body
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return data === undefined ? undefined : JSON.parse(data);
}

describe('testMcpSession against a real serve()', () => {
  test('completes a 2025-03-26 initialize handshake', async () => {
    const client = new HttpClient({
      baseUrl: `${server.url.replace(/\/+$/, '')}/api`,
      token: TEST_API_KEY,
    });

    const result = await testMcpSession(client);

    expect(result.response.status).toBe(200);
    expect(readSseResult(result.response.body)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-03-26', serverInfo: { name: 'weft' } },
    });
  });
});
