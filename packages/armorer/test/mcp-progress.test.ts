import type { Progress } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import { createMCP, MCP_PROTOCOL_VERSION, type MCPServer } from '../src/integrations/mcp';
import { fromMcpClientTools } from '../src/integrations/mcp/oauth';
import { createProgressForwarder } from '../src/integrations/mcp/request-context';
import { connectInProcessClient, type NegotiationMode } from './fixtures/mcp-in-process-client';

const eras: Array<{ era: string; mode: NegotiationMode }> = [
  { era: 'modern', mode: { pin: MCP_PROTOCOL_VERSION } },
  { era: 'legacy', mode: 'legacy' },
];

function createProgressToolbox() {
  return createToolbox([
    createTool({
      name: 'scan',
      description: 'reports progress while scanning',
      input: z.object({}),
      async execute(_params, context) {
        context.progress({ percent: 25, message: 'first quarter' });
        context.progress({ percent: 25, message: 'repeated percent is not progress' });
        context.progress({ percent: 75, message: 'three quarters' });
        return { scanned: true };
      },
    }),
  ]);
}

let endpoints: MCPServer[] = [];
afterEach(async () => {
  await Promise.all(endpoints.map((endpoint) => endpoint.close()));
  endpoints = [];
});

async function createEndpoint() {
  const mcp = await createMCP(createProgressToolbox());
  endpoints.push(mcp);
  return mcp;
}

describe.each(eras)('MCP progress ($era era)', ({ mode }) => {
  it('emits Armorer progress events as MCP progress notifications when the client asks', async () => {
    const mcp = await createEndpoint();
    const { client } = await connectInProcessClient(mcp, mode);
    try {
      const updates: Progress[] = [];
      const result = await client.callTool(
        { name: 'scan', arguments: {} },
        { onprogress: (update) => updates.push(update) },
      );
      expect(result.structuredContent).toEqual({ scanned: true });
      expect(updates).toEqual([
        { progress: 25, total: 100, message: 'first quarter' },
        { progress: 75, total: 100, message: 'three quarters' },
      ]);
    } finally {
      await client.close();
    }
  });

  it('sends no progress notification when the client did not ask for progress', async () => {
    const mcp = await createEndpoint();
    const { client, exchanges } = await connectInProcessClient(mcp, mode);
    try {
      await client.callTool({ name: 'scan', arguments: {} });
      const call = exchanges.find((exchange) => exchange.method === 'tools/call');
      expect(await call?.responseText).not.toContain('notifications/progress');
    } finally {
      await client.close();
    }
  });

  it('surfaces remote progress as Armorer progress events through fromMcpClientTools', async () => {
    const mcp = await createEndpoint();
    const { client } = await connectInProcessClient(mcp, mode);
    try {
      const [scan] = await fromMcpClientTools(client);
      const percents: Array<number | undefined> = [];
      scan?.addEventListener('progress', (event) => {
        percents.push(event.percent);
      });
      expect(await scan?.execute({})).toEqual({ scanned: true });
      expect(percents).toEqual([25, 75]);
    } finally {
      await client.close();
    }
  });

  it('requests no progress through fromMcpClientTools when progress is disabled', async () => {
    const mcp = await createEndpoint();
    const { client, exchanges } = await connectInProcessClient(mcp, mode);
    try {
      const [scan] = await fromMcpClientTools(client, { progress: false });
      const percents: Array<number | undefined> = [];
      scan?.addEventListener('progress', (event) => {
        percents.push(event.percent);
      });
      expect(await scan?.execute({})).toEqual({ scanned: true });
      expect(percents).toEqual([]);
      const call = exchanges.find((exchange) => exchange.method === 'tools/call');
      expect(await call?.responseText).not.toContain('notifications/progress');
    } finally {
      await client.close();
    }
  });
});

describe('createProgressForwarder', () => {
  it('keeps progress strictly increasing and counts message-only updates until a percent arrives', () => {
    const sent: unknown[] = [];
    const forwarder = createProgressForwarder();
    forwarder.forward({ message: 'dropped: no request round is listening' });
    forwarder.setSink({
      token: 'token',
      notify: async (notification) => {
        sent.push(notification.params);
      },
    });
    forwarder.forward({ message: 'starting' });
    forwarder.forward({ message: 'warming up' });
    forwarder.forward({ percent: 1 });
    forwarder.forward({ percent: 40, message: 'scanning' });
    forwarder.forward({ message: 'cannot be placed after a percent' });
    forwarder.forward({ percent: 40 });
    forwarder.forward({ percent: 100 });
    expect(sent).toEqual([
      { progressToken: 'token', progress: 1, message: 'starting' },
      { progressToken: 'token', progress: 2, message: 'warming up' },
      { progressToken: 'token', progress: 40, total: 100, message: 'scanning' },
      { progressToken: 'token', progress: 100, total: 100 },
    ]);
  });

  it('starts a new increasing sequence when a round brings a new progress token', () => {
    const sent: unknown[] = [];
    const forwarder = createProgressForwarder();
    const sinkFor = (token: string) => ({
      token,
      notify: async (notification: { params?: unknown }) => {
        sent.push(notification.params);
      },
    });
    forwarder.setSink(sinkFor('first'));
    forwarder.forward({ percent: 50 });
    forwarder.setSink(undefined);
    forwarder.setSink(sinkFor('first'));
    forwarder.forward({ percent: 50, message: 'same token keeps its order' });
    forwarder.forward({ message: 'same token: no counter after a percent' });
    forwarder.setSink(undefined);
    forwarder.setSink(sinkFor('second'));
    forwarder.forward({ message: 'resumed' });
    forwarder.forward({ percent: 50 });
    expect(sent).toEqual([
      { progressToken: 'first', progress: 50, total: 100 },
      { progressToken: 'second', progress: 1, message: 'resumed' },
      { progressToken: 'second', progress: 50, total: 100 },
    ]);
  });
});
