/**
 * The asset content route of `createBureauHandler` (COR-1547): `GET /assets/{assetId}/content`
 * streams an asset's bytes to the caller that owns it, or may read it.
 *
 * It is a mount, not a catalog operation, because the answer is bytes rather than JSON. It
 * authenticates like every other path (the handler does it before the mount runs), requires the
 * `bureau.assets:read` scope, and resolves the asset as the owner string the caller's credential
 * names. The URL is an address, not a credential: knowing an asset id grants nothing.
 *
 * Every refusal to serve a byte answers the same 404, with a body that does not tell the cases
 * apart: an unknown asset, one another owner holds, one that is not `available` (pending,
 * rejected, quarantined, expired, deleted), one whose stored bytes fail their digest, and one
 * whose content a provider holds (`provider-fetch`), which Bureau never fetches.
 *
 * What is served is untrusted content, so the response never lets a browser run it: it carries
 * `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, and is sent as an
 * `attachment` for every type except an image other than SVG, audio, and video.
 *
 * @module assets-mount
 */

import type { OperationHandlerMount } from '@lostgradient/weft';

import {
  AssetIntegrityError,
  AssetNotFoundError,
  AssetUnavailableError,
} from '../assets/errors.ts';
import type { AssetService } from '../assets/types.ts';
import { ownerOfPrincipal } from './owner-predicate.ts';

/** Every asset route lives under this prefix. */
export const ASSETS_PATH_PREFIX = '/assets';

const FALLBACK_MEDIA_TYPE = 'application/octet-stream';

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function notFound(assetId: string): Response {
  return json(
    {
      code: 'NotFound',
      message: `No asset with id "${assetId}"`,
      data: { resource: 'asset', identifier: assetId },
    },
    404,
  );
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Whether a browser may show content of `mediaType` itself: an image other than SVG (which can
 * carry script), audio, and video. Anything else is offered for download only.
 */
export function mayRenderInline(mediaType: string): boolean {
  const type = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  if (type === 'image/svg+xml') return false;
  return type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/');
}

/** How many bytes one chunk of the response body carries. */
const CHUNK_BYTES = 64 * 1024;

/** The bytes as a stream of chunks, so a large asset is sent as the client reads it. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + CHUNK_BYTES));
      offset += CHUNK_BYTES;
    },
  });
}

export function createAssetsMount(assets: AssetService): OperationHandlerMount {
  return {
    pathPrefix: ASSETS_PATH_PREFIX,
    fetch: async (request, { principal }) => {
      const path = new URL(request.url).pathname.replace(/\/+$/, '');
      const segments = path.slice(ASSETS_PATH_PREFIX.length).split('/').slice(1);
      if (segments.length !== 2 || segments[1] !== 'content') {
        return json({ code: 'NotFound', message: 'No such route' }, 404);
      }
      if (request.method.toUpperCase() !== 'GET') {
        return json({ code: 'MethodNotAllowed', message: 'Use GET' }, 405, { Allow: 'GET' });
      }
      const assetId = decodeSegment(segments[0]!);
      if (assetId === undefined || assetId === '') {
        return json({ code: 'NotFound', message: 'No such route' }, 404);
      }
      // A scope is a gate on who may ask, never a grant across owners: it names no asset.
      if (principal.method === 'unauthenticated' || !principal.hasScope('bureau.assets:read')) {
        return json({ code: 'Forbidden', message: 'Requires bureau.assets:read' }, 403);
      }
      const owner = ownerOfPrincipal(principal);
      if (owner === undefined) return notFound(assetId);
      try {
        const { descriptor, content } = await assets.resolve({ assetId }, { id: owner });
        if (content.kind !== 'bytes') return notFound(assetId);
        const mediaType = descriptor.mediaType ?? FALLBACK_MEDIA_TYPE;
        return new Response(streamOf(content.bytes), {
          status: 200,
          headers: {
            'Content-Type': mediaType,
            'Content-Length': String(content.bytes.byteLength),
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': 'sandbox',
            ...(mayRenderInline(mediaType) ? {} : { 'Content-Disposition': 'attachment' }),
          },
        });
      } catch (error) {
        if (
          error instanceof AssetNotFoundError ||
          error instanceof AssetUnavailableError ||
          error instanceof AssetIntegrityError
        ) {
          return notFound(assetId);
        }
        throw error;
      }
    },
  };
}
