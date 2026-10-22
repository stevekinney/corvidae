import type { McpUiResourceMeta } from '@modelcontextprotocol/ext-apps';
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';

import { isTool, type Tool } from '../../is-tool';

/** The URI scheme prefix MCP Apps uses for UI resources. */
export const UI_RESOURCE_SCHEME = 'ui://';

/**
 * The subset of an MCP client that {@link readUiResource} needs: `resources/read`, and
 * optionally `resources/list`, whose entries carry the `_meta.ui` a server declared when it
 * registered the resource.
 */
export type McpUiResourceReader = {
  readResource(params: { uri: string }): Promise<{
    contents: ReadonlyArray<{
      uri: string;
      mimeType?: string | undefined;
      text?: string;
      blob?: string;
      _meta?: Record<string, unknown> | undefined;
    }>;
  }>;
  listResources?(params?: { cursor?: string }): Promise<{
    resources: ReadonlyArray<{ uri: string; _meta?: Record<string, unknown> | undefined }>;
    nextCursor?: string | undefined;
  }>;
};

/** A `ui://` resource as MCP Apps serves it. */
export type McpUiResource = {
  /** The `ui://` URI that was read. */
  uri: string;
  /** The HTML document the host renders. */
  html: string;
  /** Always `text/html;profile=mcp-app` (MCP Apps' `RESOURCE_MIME_TYPE`). */
  mimeType: typeof RESOURCE_MIME_TYPE;
  /** The content item's `_meta.ui` (CSP, permissions, ...), unchanged, when the server sent one. */
  ui?: McpUiResourceMeta;
  /** The content item's whole `_meta`, unchanged. */
  meta?: Record<string, unknown>;
};

/**
 * Reads a `ui://` resource through an MCP client. Any other URI is rejected
 * before a request is issued, as is a response with no content item for that
 * URI or one that is not MCP Apps HTML.
 *
 * `ui` follows MCP Apps' precedence: the content item's `_meta.ui` overrides,
 * field by field, the `_meta.ui` of the resource's `resources/list` entry,
 * which is read only when the client offers `listResources`.
 */
export async function readUiResource(
  client: McpUiResourceReader,
  uri: string,
): Promise<McpUiResource> {
  if (!uri.startsWith(UI_RESOURCE_SCHEME) || uri.length === UI_RESOURCE_SCHEME.length) {
    throw new TypeError(`readUiResource() only reads "${UI_RESOURCE_SCHEME}" URIs, got "${uri}".`);
  }
  const { contents } = await client.readResource({ uri });
  const content = contents.find((item) => item.uri === uri);
  if (!content) throw new Error(`MCP server returned no content item for "${uri}".`);
  if (content.mimeType !== RESOURCE_MIME_TYPE) {
    throw new Error(
      `Expected "${uri}" to be "${RESOURCE_MIME_TYPE}", got "${content.mimeType ?? 'no MIME type'}".`,
    );
  }
  const html =
    content.text ??
    (content.blob === undefined ? undefined : Buffer.from(content.blob, 'base64').toString('utf8'));
  if (html === undefined) throw new Error(`MCP resource "${uri}" has neither text nor blob.`);
  const resource: McpUiResource = { uri, html, mimeType: RESOURCE_MIME_TYPE };
  if (content._meta !== undefined) resource.meta = content._meta;
  const listed = await listedUi(client, uri);
  const declared = uiRecord(content._meta);
  if (listed !== undefined || declared !== undefined) resource.ui = { ...listed, ...declared };
  return resource;
}

function uiRecord(meta: Record<string, unknown> | undefined): McpUiResourceMeta | undefined {
  const ui = meta?.['ui'];
  return typeof ui === 'object' && ui !== null && !Array.isArray(ui) ? ui : undefined;
}

/** The `_meta.ui` of `uri`'s `resources/list` entry, paging until it is found. */
async function listedUi(
  client: McpUiResourceReader,
  uri: string,
): Promise<McpUiResourceMeta | undefined> {
  if (client.listResources === undefined) return undefined;
  let cursor: string | undefined;
  do {
    const page = await client.listResources(cursor === undefined ? undefined : { cursor });
    const entry = page.resources.find((item) => item.uri === uri);
    if (entry !== undefined) return uiRecord(entry._meta);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return undefined;
}

/**
 * The `ui://` URI an MCP Apps tool declares, from an imported {@link Tool}
 * (read from its preserved `_meta`) or a raw `_meta` record:
 * `_meta.ui.resourceUri`, falling back to the deprecated
 * `_meta["ui/resourceUri"]`. Undefined when there is none.
 */
export function mcpUiResourceUri(
  source: Tool | Record<string, unknown> | undefined,
): string | undefined {
  if (!source) return undefined;
  const meta = isTool(source) ? toolMeta(source) : source;
  if (!meta) return undefined;
  const ui = meta['ui'];
  const nested =
    typeof ui === 'object' && ui !== null
      ? (ui as { resourceUri?: unknown }).resourceUri
      : undefined;
  const uri = typeof nested === 'string' ? nested : meta[RESOURCE_URI_META_KEY];
  return typeof uri === 'string' && uri.startsWith(UI_RESOURCE_SCHEME) ? uri : undefined;
}

function toolMeta(tool: Tool): Record<string, unknown> | undefined {
  const mcp = (tool.metadata as Record<string, unknown> | undefined)?.['mcp'];
  const meta =
    typeof mcp === 'object' && mcp !== null ? (mcp as { meta?: unknown }).meta : undefined;
  return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : undefined;
}
