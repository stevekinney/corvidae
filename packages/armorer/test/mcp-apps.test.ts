import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'bun:test';

import { expectPromiseToReject } from '../src/async-assertion-test-helpers';
import { createToolbox } from '../src/create-toolbox';
import {
  UI_RESOURCE_SCHEME,
  createMCP,
  fromMcpTools,
  mcpUiResourceUri,
  readUiResource,
  toMcpTools,
} from '../src/integrations/mcp';
import {
  FIXTURE_RESOURCE_UI,
  FIXTURE_TOOL_UI,
  FIXTURE_UI_HTML,
  FIXTURE_UI_URI,
  createMcpAppsFixtureServer,
} from './fixtures/mcp-apps-server';

async function connectFixture(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpAppsFixtureServer().connect(serverTransport);
  const client = new Client({ name: 'mcp-apps-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function importFixtureTools(client: Client) {
  const { tools } = await client.listTools();
  const imported = fromMcpTools(tools, { callTool: (request) => client.callTool(request) });
  const tool = imported.find((entry) => entry.name === 'get-weather');
  if (!tool) throw new Error('fixture tool was not imported');
  return { tools, tool };
}

describe('MCP Apps through the MCP client', () => {
  it('keeps _meta.ui unchanged on an imported tool and re-exports it through toMcpTools and createMCP', async () => {
    const client = await connectFixture();
    try {
      const { tools, tool } = await importFixtureTools(client);
      const listed = tools.find((entry) => entry.name === 'get-weather');
      // The fixture's own declaration survives the wire.
      expect(listed?._meta?.['ui']).toEqual(FIXTURE_TOOL_UI);

      const mcpMeta = (tool.metadata as { mcp: { meta: Record<string, unknown> } }).mcp.meta;
      expect(mcpMeta['ui']).toEqual(FIXTURE_TOOL_UI);
      expect(mcpMeta).toEqual(listed?._meta ?? {});

      const [exported] = toMcpTools(tool);
      expect(exported?._meta?.['ui']).toEqual(FIXTURE_TOOL_UI);

      const reexport = await createMCP(createToolbox().extend(tool));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await reexport.createServer().connect(serverTransport);
      const downstream = new Client({ name: 'downstream', version: '0.0.0' });
      await downstream.connect(clientTransport);
      try {
        const relistedTools = await downstream.listTools();
        const relisted = relistedTools.tools.find((entry) => entry.name === 'get-weather');
        expect(relisted?._meta?.['ui']).toEqual(FIXTURE_TOOL_UI);
      } finally {
        await downstream.close();
        await reexport.shutdown();
      }
    } finally {
      await client.close();
    }
  });

  it('reads a ui:// resource as HTML with the MCP Apps MIME type and its CSP and permissions', async () => {
    const client = await connectFixture();
    try {
      const resource = await readUiResource(client, FIXTURE_UI_URI);
      expect(resource.html).toBe(FIXTURE_UI_HTML);
      expect(resource.mimeType).toBe('text/html;profile=mcp-app');
      expect(resource.ui).toEqual(FIXTURE_RESOURCE_UI);
    } finally {
      await client.close();
    }
  });

  it('rejects non-ui:// URIs without issuing a request', async () => {
    let requests = 0;
    const reader = {
      async readResource() {
        requests += 1;
        return { contents: [] };
      },
    };
    for (const uri of [
      'https://example.com/view.html',
      'file:///etc/passwd',
      'UI://weather/view.html',
      'weather/view.html',
      '',
      UI_RESOURCE_SCHEME,
    ]) {
      await expectPromiseToReject(readUiResource(reader, uri), (error) =>
        expect(String(error)).toMatch(/only reads "ui:\/\/" URIs/),
      );
    }
    expect(requests).toBe(0);
  });

  it('rejects a ui:// response that is not MCP Apps HTML', async () => {
    const reader = {
      async readResource() {
        return { contents: [{ uri: 'ui://x/y', mimeType: 'text/plain', text: 'nope' }] };
      },
    };
    await expectPromiseToReject(readUiResource(reader, 'ui://x/y'), (error) =>
      expect(String(error)).toMatch(/text\/html;profile=mcp-app/),
    );
  });

  it('leads from an imported tool, through its call result, to the ui:// resource it declares', async () => {
    const client = await connectFixture();
    try {
      const { tool } = await importFixtureTools(client);
      expect(mcpUiResourceUri(tool)).toBe(FIXTURE_UI_URI);

      // Calling the tool leaves that declaration intact: the tool still names the same URI after
      // the call, and that URI reads back the resource the result is meant to be rendered in.
      const result = await tool({ city: 'Denver' });
      expect(result).toBe('Sunny in Denver');
      const uri = mcpUiResourceUri(tool);
      expect(uri).toBe(FIXTURE_UI_URI);
      const resource = await readUiResource(client, uri ?? '');
      expect(resource.uri).toBe(FIXTURE_UI_URI);
      expect(resource.html).toBe(FIXTURE_UI_HTML);

      // A caller that wants the link on the result itself gets it from formatResult, which sees
      // the tool's `_meta` alongside the raw call result.
      const { tools } = await client.listTools();
      const [linked] = fromMcpTools(tools, {
        callTool: (request) => client.callTool(request),
        formatResult: (callResult, source) => ({
          callResult,
          uiResourceUri: mcpUiResourceUri(source._meta),
        }),
      });
      const linkedResult = await linked?.({ city: 'Denver' });
      const output = linkedResult as { callResult: unknown; uiResourceUri?: string };
      expect(output.uiResourceUri).toBe(FIXTURE_UI_URI);
      const linkedResource = await readUiResource(client, output.uiResourceUri ?? '');
      expect(linkedResource.html).toBe(FIXTURE_UI_HTML);
    } finally {
      await client.close();
    }
  });

  it('keeps the whole _meta record, not only ui', () => {
    const meta = {
      ui: { resourceUri: 'ui://a/b' },
      'ui/resourceUri': 'ui://a/b',
      other: 1,
    };
    const [tool] = fromMcpTools([{ name: 'plain', _meta: meta }]);
    expect(tool && toMcpTools(tool)[0]?._meta).toEqual(meta);
    expect(mcpUiResourceUri({ 'ui/resourceUri': 'ui://legacy/v' })).toBe('ui://legacy/v');
    expect(mcpUiResourceUri({ ui: { resourceUri: 'https://x' } })).toBeUndefined();
  });
});
