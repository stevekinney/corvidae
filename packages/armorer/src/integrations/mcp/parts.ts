import type { ContentBlock } from '@modelcontextprotocol/server';

import type { JSONValue, MediaContent, ToolResultPart } from '../../protocol';

/**
 * Maps MCP content blocks to Armorer's portable tool-result parts and back,
 * one block to one part, in order.
 *
 * | MCP block                    | Part                                                        |
 * | ---------------------------- | ----------------------------------------------------------- |
 * | `text`                       | `text`                                                      |
 * | `image`, `audio`             | `image`, `audio` with an inline base64 source               |
 * | `resource` (embedded)        | media by MIME type, inline `utf8` (text) or `base64` (blob) |
 * | `resource_link`              | media by MIME type with an `mcp-resource` source            |
 *
 * Inline bytes stay inline here; admitting them into managed assets is the
 * job of whoever writes the result into durable state.
 */

/** The `metadata` key a part converted from an embedded resource keeps its URI under. */
export const MCP_RESOURCE_URI_METADATA_KEY = 'mcpResourceUri';

/**
 * The `metadata` key a part converted from a `resource_link` keeps the rest of the link's fields
 * under: `title`, `description`, `size`, `annotations`, `icons`, and `_meta`.
 */
export const MCP_RESOURCE_LINK_METADATA_KEY = 'mcpResourceLink';

const RESOURCE_LINK_FIELDS = [
  'title',
  'description',
  'size',
  'annotations',
  'icons',
  '_meta',
] as const;

type MediaType = MediaContent['type'];

function mediaTypeFor(mimeType: string | undefined): MediaType {
  const base = (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('audio/')) return 'audio';
  if (base.startsWith('video/')) return 'video';
  if (base === 'application/pdf' || base.startsWith('text/')) return 'document';
  return 'file';
}

function withMimeType<Part extends object>(
  part: Part,
  mimeType: string | undefined,
): Part & { mimeType?: string } {
  return mimeType === undefined ? part : { ...part, mimeType };
}

/**
 * Converts MCP content blocks into ordered tool-result parts. A
 * `resource_link` becomes a reference to `serverId`'s resource, so it needs a
 * `serverId`; without one the conversion throws rather than inventing a URL.
 */
export function mcpBlocksToParts(
  blocks: readonly ContentBlock[],
  serverId: string | undefined,
): ToolResultPart[] {
  return blocks.map((block): ToolResultPart => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'image':
      case 'audio':
        return {
          type: block.type,
          mimeType: block.mimeType,
          source: { kind: 'inline', data: block.data, encoding: 'base64' },
        };
      case 'resource': {
        const { resource } = block;
        const source =
          'text' in resource
            ? ({ kind: 'inline', data: resource.text, encoding: 'utf8' } as const)
            : ({ kind: 'inline', data: resource.blob, encoding: 'base64' } as const);
        return withMimeType(
          {
            type: mediaTypeFor(resource.mimeType),
            source,
            metadata: { [MCP_RESOURCE_URI_METADATA_KEY]: resource.uri },
          },
          resource.mimeType,
        );
      }
      case 'resource_link': {
        if (serverId === undefined) {
          throw new Error(
            `MCP result links to resource "${block.uri}", but no serverId was configured to reference it by.`,
          );
        }
        const link: Record<string, JSONValue> = {};
        for (const field of RESOURCE_LINK_FIELDS) {
          if (block[field] !== undefined) link[field] = block[field] as JSONValue;
        }
        return withMimeType(
          {
            type: mediaTypeFor(block.mimeType),
            name: block.name,
            source: { kind: 'mcp-resource', serverId, uri: block.uri },
            ...(Object.keys(link).length === 0
              ? {}
              : { metadata: { [MCP_RESOURCE_LINK_METADATA_KEY]: link } }),
          },
          block.mimeType,
        );
      }
    }
  });
}

function embeddedUri(part: MediaContent, index: number): string {
  const uri = part.metadata?.[MCP_RESOURCE_URI_METADATA_KEY];
  return typeof uri === 'string' ? uri : `urn:armorer:tool-result-part:${index}`;
}

/** The resource-link fields {@link mcpBlocksToParts} kept under `metadata`, and only those. */
function resourceLinkFields(part: MediaContent): Record<string, unknown> {
  const kept: unknown = part.metadata?.[MCP_RESOURCE_LINK_METADATA_KEY];
  if (typeof kept !== 'object' || kept === null || Array.isArray(kept)) return {};
  const record = kept as Record<string, unknown>;
  return Object.fromEntries(
    RESOURCE_LINK_FIELDS.flatMap((field) => (field in record ? [[field, record[field]]] : [])),
  );
}

function partToBlock(part: ToolResultPart, index: number): ContentBlock {
  if (part.type === 'text') return { type: 'text', text: part.text };
  const { source } = part;
  if (source.kind === 'mcp-resource' || source.kind === 'remote-url') {
    const uri = source.kind === 'mcp-resource' ? source.uri : source.url;
    return withMimeType(
      { type: 'resource_link', uri, name: part.name ?? uri, ...resourceLinkFields(part) },
      part.mimeType,
    );
  }
  if (source.kind !== 'inline') {
    throw new Error(
      `Tool-result part ${index} has a "${source.kind}" source, which MCP cannot carry; resolve it to inline bytes first.`,
    );
  }
  // A part that came from an embedded resource goes back out as one, even an image or audio part.
  const fromEmbeddedResource = typeof part.metadata?.[MCP_RESOURCE_URI_METADATA_KEY] === 'string';
  if (
    !fromEmbeddedResource &&
    (part.type === 'image' || part.type === 'audio') &&
    source.encoding === 'base64'
  ) {
    if (part.mimeType === undefined) {
      throw new Error(`Tool-result part ${index} (${part.type}) needs a mimeType for MCP.`);
    }
    return { type: part.type, data: source.data, mimeType: part.mimeType };
  }
  const uri = embeddedUri(part, index);
  return {
    type: 'resource',
    resource:
      source.encoding === 'utf8'
        ? withMimeType({ uri, text: source.data }, part.mimeType)
        : withMimeType({ uri, blob: source.data }, part.mimeType),
  };
}

/**
 * Converts ordered tool-result parts into MCP content blocks. Parts whose
 * source MCP cannot carry (a managed asset, an upload, a local file, ...)
 * throw: the caller resolves them to bytes first rather than sending a
 * placeholder.
 */
export function partsToMcpBlocks(parts: readonly ToolResultPart[]): ContentBlock[] {
  return parts.map((part, index) => partToBlock(part, index));
}
