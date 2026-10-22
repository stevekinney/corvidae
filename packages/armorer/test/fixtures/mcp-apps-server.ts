import type { McpUiResourceMeta, McpUiToolMeta } from '@modelcontextprotocol/ext-apps';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** The `ui://` resource the fixture's tool declares. */
export const FIXTURE_UI_URI = 'ui://weather/view.html';

/** The HTML the fixture serves for {@link FIXTURE_UI_URI}. */
export const FIXTURE_UI_HTML = '<!doctype html><html><body><h1>Weather</h1></body></html>';

/** The tool's `_meta.ui`, as the fixture declares it (CSP and permissions live on the resource). */
export const FIXTURE_TOOL_UI: McpUiToolMeta = {
  resourceUri: FIXTURE_UI_URI,
  visibility: ['model', 'app'],
};

/** The resource's `_meta.ui` (CSP and permissions), as the fixture declares it. */
export const FIXTURE_RESOURCE_UI: McpUiResourceMeta = {
  csp: {
    connectDomains: ['https://api.weather.test'],
    resourceDomains: ['https://cdn.weather.test'],
  },
  permissions: { geolocation: {} },
};

/**
 * An ext-apps 2.0.x MCP server: one tool whose `_meta.ui` points at a `ui://`
 * resource, and that resource. Built with ext-apps' own server helpers.
 */
export function createMcpAppsFixtureServer(): McpServer {
  const server = new McpServer({ name: 'mcp-apps-fixture', version: '0.1.0' });
  registerAppTool(
    server,
    'get-weather',
    {
      title: 'Get Weather',
      description: 'Shows the weather',
      inputSchema: z.object({ city: z.string() }),
      _meta: { ui: FIXTURE_TOOL_UI },
    },
    async ({ city }) => ({ content: [{ type: 'text', text: `Sunny in ${city}` }] }),
  );
  registerAppResource(
    server,
    'Weather View',
    FIXTURE_UI_URI,
    { _meta: { ui: FIXTURE_RESOURCE_UI } },
    async () => ({
      contents: [
        {
          uri: FIXTURE_UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: FIXTURE_UI_HTML,
          _meta: { ui: FIXTURE_RESOURCE_UI },
        },
      ],
    }),
  );
  return server;
}
