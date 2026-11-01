/**
 * Every MCP App the Bureau MCP adapter serves (COR-910): each app a running plugin contributes
 * (COR-1888), built into a self-contained page and served as its `ui://` resource, and the tool
 * metadata that links a tool to the page, merged into the one pair the adapter accepts.
 */
import type { BureauPlugins } from '@lostgradient/bureau';
import type { OperationMcpResource } from '@lostgradient/weft';

import { buildMcpAppPage } from './mcp-app-build.ts';

/** The MCP App media type. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * The `_meta.ui` every app declares: every origin list empty and every permission absent, which is
 * denied. A page reaches no origin, embeds no frame, sets no base URI, and asks for neither camera,
 * microphone, geolocation, nor clipboard. It asks for no dedicated origin either; the host gives it
 * its default sandbox origin.
 */
export const MCP_APP_UI_META = {
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
  permissions: {},
  prefersBorder: false,
};

/** The apps `bureau.plugins.mcpApps()` lists. */
export type ContributedMcpApps = ReturnType<BureauPlugins['mcpApps']>;

/** What failed, with each message a failed bundle logged: Bun's own message is only "Bundle failed". */
function failureMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const logged = error instanceof AggregateError ? error.errors : [];
  const details = logged.map((entry: unknown) =>
    entry instanceof Error || (typeof entry === 'object' && entry !== null && 'message' in entry)
      ? String(entry.message)
      : String(entry),
  );
  return [error.message, ...details].join(': ');
}

/** One app the host built and serves: what the routes answer from, fixed at startup. */
export type ServedMcpApp = {
  /** The contributing plugin's name. */
  readonly plugin: string;
  /** The app's name within the plugin. */
  readonly name: string;
  /** The app's title. */
  readonly title: string;
  /** The app's `ui://` resource URI. */
  readonly uri: string;
  /** The Bureau tool a client runs to open the page. */
  readonly opensFromTool: string;
  /** The Bureau MCP tool names the panel may call, and no others. */
  readonly allowedTools: readonly string[];
  /** The built, self-contained page. */
  readonly html: string;
};

/** An app whose page could not be built: the plugin, the app's name, and why. */
export type McpAppFailure = {
  /** The contributing plugin's name. */
  readonly plugin: string;
  /** The app's name within the plugin. */
  readonly app: string;
  /** The build failure's message. */
  readonly message: string;
};

/**
 * Build every contributed app once and merge their resources and tool metadata. An app is linked
 * from its `opensFromTool`, which Bureau composition keeps to one app (a second plugin's app is
 * skipped with `name-clash`). An app whose page does not build is left out and reported in
 * `failures`, never thrown: a plugin's contribution must not stop the host from starting.
 */
export async function mcpAppMounts(contributed: ContributedMcpApps) {
  const built = await Promise.all(
    contributed.map(async ({ plugin, app }) => {
      try {
        const page = await buildMcpAppPage({
          entry: app.entry.href,
          title: app.title,
          styles: app.styles ?? '',
        });
        return { plugin, app, page };
      } catch (error) {
        const message = failureMessage(error);
        return { plugin, app, failure: { plugin, app: app.name, message } satisfies McpAppFailure };
      }
    }),
  );
  const toolMeta: Record<string, Readonly<Record<string, unknown>>> = {};
  const resources: (OperationMcpResource & { readonly text: string })[] = [];
  const failures: McpAppFailure[] = [];
  const apps: ServedMcpApp[] = [];
  for (const entry of built) {
    if ('failure' in entry) {
      failures.push(entry.failure);
      continue;
    }
    const { plugin, app, page } = entry;
    resources.push({
      uri: app.uri,
      name: app.name,
      title: app.title,
      ...(app.description === undefined ? {} : { description: app.description }),
      mimeType: MCP_APP_MIME_TYPE,
      text: page.html,
      _meta: { ui: MCP_APP_UI_META, contentDigest: page.contentDigest },
    });
    apps.push({
      plugin,
      name: app.name,
      title: app.title,
      uri: app.uri,
      opensFromTool: app.opensFromTool,
      allowedTools: [...app.allowedTools],
      html: page.html,
    });
    toolMeta[app.opensFromTool] = {
      ui: { resourceUri: app.uri, visibility: ['model', 'app'] },
    };
  }
  return { resources, toolMeta, failures, apps };
}
