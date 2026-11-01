/**
 * The host's plugin panels, as the run page mounts them (`GET /host/mcp-apps`,
 * `GET /host/plugins/<plugin>/apps/<app>`, `POST /host/plugins/<plugin>/apps/<app>/tool-calls`;
 * `src/host/mcp-app-routes.ts`, COR-1894). Chat's `McpApp` owns no client and no credential, so
 * this module is the loader and the tool-call handler it is given: the page comes from the host,
 * and a panel's call goes to the host, which runs it only when the app declared the tool.
 */
import type { McpAppResource, McpAppToolCallHandler } from '@lostgradient/chat';
import { z } from 'zod';

import type { Fetcher } from './bureau-client.ts';

/** The route that lists the panels the host serves. */
export const HOST_MCP_APPS_ROUTE = '/host/mcp-apps';

const appsSchema = z.object({
  apps: z.array(
    z.object({
      plugin: z.string().min(1),
      app: z.string().min(1),
      title: z.string(),
      uri: z.string().min(1),
      opensFromTool: z.string().min(1),
    }),
  ),
});

/** One panel the host serves: the plugin that contributes it, its name, and the tool it opens from. */
export type HostMcpApp = z.infer<typeof appsSchema>['apps'][number];

// The page's security block is read loosely: `McpApp` sanitizes what it declares, and a field this
// client does not know is the component's to judge.
const pageSchema = z.object({
  html: z.string(),
  ui: z.looseObject({}).optional(),
});

/** What a panel's tool call answers: the MCP `CallToolResult` the Bureau produced. */
type ToolResult = Awaited<ReturnType<McpAppToolCallHandler>>;

// The shape is checked as far as this client reads it (a content list of typed blocks, an error
// flag); the blocks themselves are the Bureau's MCP adapter's, passed through to the app untouched.
const toolResultSchema = z.custom<ToolResult>(
  (value) =>
    z
      .looseObject({
        content: z.array(z.looseObject({ type: z.string() })),
        isError: z.boolean().optional(),
      })
      .safeParse(value).success,
);

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

function send(path: string, init: RequestInit, options: Options): Promise<Response> {
  const request = options.fetch ?? fetch;
  return request(path, options.signal === undefined ? init : { ...init, signal: options.signal });
}

const panelPath = (plugin: string, app: string): string =>
  `/host/plugins/${encodeURIComponent(plugin)}/apps/${encodeURIComponent(app)}`;

/** Asks the host which plugin panels it serves. */
export async function getMcpApps(options: Options = {}): Promise<readonly HostMcpApp[]> {
  const response = await send(HOST_MCP_APPS_ROUTE, {}, options);
  if (!response.ok) throw new Error(`The host answered ${response.status}.`);
  return appsSchema.parse(await response.json()).apps;
}

/** `McpApp`'s resource loader for one panel: its page and its declared security metadata. */
export async function loadPluginApp(
  plugin: string,
  app: string,
  options: Options = {},
): Promise<McpAppResource> {
  const response = await send(panelPath(plugin, app), {}, options);
  if (!response.ok) throw new Error(`The host answered ${response.status}.`);
  const page = pageSchema.parse(await response.json());
  return page.ui === undefined ? { html: page.html } : { html: page.html, ui: page.ui };
}

/**
 * `McpApp`'s tool-call handler for one panel. The host refuses a tool the app did not declare, and
 * that refusal throws here, which `McpApp` reports to the frame without repeating the message.
 */
export function pluginToolCaller(
  plugin: string,
  app: string,
  options: Pick<Options, 'fetch'> = {},
): McpAppToolCallHandler {
  return async (params, call) => {
    const response = await send(
      `${panelPath(plugin, app)}/tool-calls`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: params.name, arguments: params.arguments ?? {} }),
      },
      { ...options, signal: call.signal },
    );
    if (!response.ok) throw new Error(`The host answered ${response.status}.`);
    return toolResultSchema.parse(await response.json());
  };
}
