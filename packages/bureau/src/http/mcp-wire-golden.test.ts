import { expect, it } from 'bun:test';

import { MCP_LEGACY_PROTOCOL_VERSION, VERSION } from '@lostgradient/weft/testing';
import { openBureau } from './management/management-fixtures.test-support.ts';

it('pins Bureau’s MCP initialization, tool listing, and call responses', async () => {
  const opened = await openBureau({ handlerOptions: { mcp: {} } });
  try {
    async function request(id: string, method: string, params: object = {}): Promise<string> {
      const response = await opened.handler(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': MCP_LEGACY_PROTOCOL_VERSION,
            'x-api-key': 'alice-key',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        }),
      );
      expect(response.status).toBe(200);
      return response.text();
    }

    const initialization = await request('initialize', 'initialize', {
      protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'wire-golden', version: '1.0.0' },
    });
    const version = JSON.stringify(VERSION);
    expect(initialization).toContain(`"version":${version}`);
    // Keep the handshake pinned across version bumps while checking the actual version above.
    expect(
      initialization.replace(`"version":${version}`, '"version":"<weft-version>"'),
    ).toMatchSnapshot('initialize');
    expect(await request('list', 'tools/list')).toMatchSnapshot('tools/list');
    expect(
      await request('call', 'tools/call', { name: 'bureau.tasks.list', arguments: {} }),
    ).toMatchSnapshot('successful call');
    expect(
      await request('refused', 'tools/call', {
        name: 'bureau.tasks.get',
        arguments: { taskId: 'missing-task' },
      }),
    ).toMatchSnapshot('refused call');
  } finally {
    await opened.dispose();
  }
});
