import type { ContentSourceResolver } from '@lostgradient/operative';

import { encodeBase64 } from './base64';
import {
  AssetAccessDeniedError,
  AssetIntegrityError,
  AssetNotFoundError,
  AssetUnavailableError,
} from './errors';
import type { AssetService } from './types';

type ResolvedSafety = 'clean' | 'flagged' | 'unknown';

/** What a host's MCP client read from a resource: UTF-8 text or base64 bytes, and their media type. */
export interface McpResourceContents {
  readonly data: string;
  readonly encoding: 'base64' | 'utf8';
  readonly mimeType?: string | undefined;
}

/**
 * Reads one resource from the MCP server a tool result linked it from (COR-1634). Bureau holds no
 * MCP connections of its own, so the host that connected the server supplies the read; the
 * resolver calls it for each `mcp-resource` part of a row, at the step that sends the row to a
 * provider, as the run's principal. The host owns whether that principal may read that server's
 * resource. `undefined` means the server no longer has it. A throw is not swallowed: it fails the
 * step, as any unexpected error from a resolver does.
 */
export type McpResourceReader = (
  resource: { readonly serverId: string; readonly uri: string },
  context: { readonly principalId: string; readonly signal?: AbortSignal | undefined },
) => Promise<McpResourceContents | undefined>;

/**
 * The resolver Bureau hands a run (COR-716): it projects a `managed-asset` part
 * to the form a provider accepts, reading through {@link AssetService.resolve}
 * as the run's own principal, so a run reaches only the assets that principal
 * may read.
 *
 * - Bureau-held bytes become an `inline` base64 source.
 * - A provider-fetch declaration becomes a `remote-url` source, which the
 *   provider fetches itself.
 * - `safety` comes from the asset's verdicts, read from the privileged
 *   projection on the run's behalf (the verdicts leave only as this
 *   three-state answer): every gate clean is `clean`, any flagged is `flagged`,
 *   and an asset no gate inspected is `unknown`.
 *
 * - An `mcp-resource` part is read through `options.mcpResources` (see
 *   {@link McpResourceReader}) and projected to its bytes, with an `unknown`
 *   safety state: no gate inspected them.
 *
 * Every refusal is the typed `unavailable` result, never a throw, so the step
 * fails with a `MediaAdmissionError` naming the part before any provider call.
 * A source kind Bureau holds no bytes for (an upload, a local file, an A2A
 * reference, and an MCP resource when no reader is configured) is likewise
 * `unavailable`.
 */
export function createAssetContentSourceResolver(
  assets: AssetService,
  principalId: string,
  options: { readonly mcpResources?: McpResourceReader | undefined } = {},
): ContentSourceResolver {
  return async (part, position) => {
    const { source } = part;
    const { signal } = position;
    // Reads nothing for a run that has already ended.
    signal?.throwIfAborted();
    if (source.kind === 'mcp-resource') {
      return resolveMcpResource(options.mcpResources, source, principalId, signal);
    }
    if (source.kind !== 'managed-asset') {
      return { outcome: 'unavailable', reason: 'source-kind-not-supported' };
    }
    const reference = {
      assetId: source.assetId,
      ...(source.revision !== undefined ? { revision: source.revision } : {}),
    };
    try {
      const resolved = await untilAborted(assets.resolve(reference, { id: principalId }), signal);
      const safety = await untilAborted(readSafety(assets, source.assetId, principalId), signal);
      const { descriptor } = resolved;
      const facts = {
        ...(descriptor.mediaType !== undefined ? { mimeType: descriptor.mediaType } : {}),
        safety,
      } as const;
      if (resolved.content.kind === 'provider-fetch') {
        return {
          outcome: 'resolved',
          source: { kind: 'remote-url', url: resolved.content.url },
          ...facts,
        };
      }
      return {
        outcome: 'resolved',
        source: { kind: 'inline', data: encodeBase64(resolved.content.bytes), encoding: 'base64' },
        byteLength: descriptor.byteLength ?? resolved.content.bytes.byteLength,
        ...facts,
      };
    } catch (error) {
      const reason = unavailableReason(error);
      if (reason === undefined) throw error;
      return { outcome: 'unavailable', reason };
    }
  };
}

/**
 * The resolver for a Bureau that reads MCP resources but holds no asset service: it resolves an
 * `mcp-resource` part through `mcpResources` and answers `unavailable` for every other kind.
 */
export function createMcpResourceContentSourceResolver(
  mcpResources: McpResourceReader,
  principalId: string,
): ContentSourceResolver {
  return async (part, position) => {
    position.signal?.throwIfAborted();
    if (part.source.kind !== 'mcp-resource') {
      return { outcome: 'unavailable', reason: 'source-kind-not-supported' };
    }
    return resolveMcpResource(mcpResources, part.source, principalId, position.signal);
  };
}

async function resolveMcpResource(
  mcpResources: McpResourceReader | undefined,
  source: { readonly serverId: string; readonly uri: string },
  principalId: string,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ContentSourceResolver>>> {
  if (mcpResources === undefined) {
    return { outcome: 'unavailable', reason: 'source-kind-not-supported' };
  }
  const contents = await untilAborted(
    mcpResources({ serverId: source.serverId, uri: source.uri }, { principalId, signal }),
    signal,
  );
  if (contents === undefined) return { outcome: 'unavailable', reason: 'mcp-resource-not-found' };
  return {
    outcome: 'resolved',
    source: { kind: 'inline', data: contents.data, encoding: contents.encoding },
    ...(contents.mimeType === undefined ? {} : { mimeType: contents.mimeType }),
    byteLength:
      contents.encoding === 'utf8'
        ? new TextEncoder().encode(contents.data).byteLength
        : Math.floor((contents.data.length * 3) / 4) -
          (contents.data.endsWith('==') ? 2 : contents.data.endsWith('=') ? 1 : 0),
    safety: 'unknown',
  };
}

async function readSafety(
  assets: AssetService,
  assetId: string,
  principalId: string,
): Promise<ResolvedSafety> {
  try {
    const descriptor = await assets.inspect(
      assetId,
      { id: principalId, privileged: true },
      { projection: 'privileged' },
    );
    if (descriptor.projection !== 'privileged' || descriptor.safety.length === 0) return 'unknown';
    return descriptor.safety.some((verdict) => verdict.verdict === 'flagged') ? 'flagged' : 'clean';
  } catch (error) {
    // The verdicts could not be read (not owner-readable, asset gone between
    // the two reads): the asset is unverified, which the guardrail's policy decides.
    if (unavailableReason(error) !== undefined) return 'unknown';
    throw error;
  }
}

function unavailableReason(error: unknown): string | undefined {
  if (error instanceof AssetNotFoundError) return 'asset-not-found';
  if (error instanceof AssetAccessDeniedError) return 'asset-access-denied';
  if (error instanceof AssetUnavailableError) return 'asset-unavailable';
  if (error instanceof AssetIntegrityError) return 'asset-integrity-failed';
  return undefined;
}

/**
 * `promise`'s result, or the signal's reason the moment it aborts. The asset service takes
 * no signal, so a stalled storage read is abandoned rather than awaited: the run is released
 * at once and the read's own outcome is ignored.
 */
async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([promise, aborted]);
    // Checked immediately after the read: a read that finished as the run was cancelled
    // is not used.
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
