/** Built-in tools for publishing and reading small managed assets. */

import { createTool, type Tool, type ToolContext } from 'armorer';
import { z } from 'zod';

import { decodeBase64 } from './assets/base64';
import { AssetAdmissionError, AssetNotFoundError } from './assets/errors';
import { managedAssetSource } from './assets/asset-service';
import type { AssetDescriptor, AssetService } from './assets/types';

const MAX_PUBLISH_BYTES = 256 * 1024;
const MAX_READ_BYTES = 65_536;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface AssetToolHost {
  readonly assets: () => AssetService | undefined;
  readonly ownerOfRun: (runId: string) => Promise<string | undefined>;
}

async function serviceAndPrincipal(
  host: AssetToolHost,
  context: ToolContext | undefined,
): Promise<{ service: AssetService; principal: { id: string } } | undefined> {
  const service = host.assets();
  // Registered tools in a top-level run receive the request context, while a durable child run
  // carries its own run id directly on the tool context. Both identify the persisted owner.
  const runId =
    context?.requestContext?.runId ??
    context?.runId ??
    (typeof context?.executionContext?.['parentRunId'] === 'string'
      ? context.executionContext['parentRunId']
      : undefined);
  if (typeof runId !== 'string' || runId === '') return undefined;
  const id = await host.ownerOfRun(runId);
  return service === undefined || id === undefined ? undefined : { service, principal: { id } };
}

function contentBytes(input: { text: string | undefined; base64: string | undefined }): Uint8Array {
  if (input.text !== undefined) {
    const bytes = new TextEncoder().encode(input.text);
    if (bytes.byteLength > MAX_PUBLISH_BYTES)
      throw new AssetAdmissionError('per-part-limit-exceeded', 'Text exceeds the 256 KiB limit.');
    return bytes;
  }
  const encoded = input.base64 ?? '';
  if (!BASE64.test(encoded))
    throw new AssetAdmissionError('unsupported-source', 'base64 must be valid base64.');
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(encoded);
  } catch {
    throw new AssetAdmissionError('unsupported-source', 'base64 must be valid base64.');
  }
  if (bytes.byteLength > MAX_PUBLISH_BYTES)
    throw new AssetAdmissionError('per-part-limit-exceeded', 'base64 exceeds the 256 KiB limit.');
  return bytes;
}

function boundedUtf8(bytes: Uint8Array): { content: string; truncated: boolean } {
  let end = Math.min(bytes.byteLength, MAX_READ_BYTES);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
      return { content, truncated: end < bytes.byteLength };
    } catch {
      end -= 1;
    }
  }
  throw new AssetAdmissionError('media-type-mismatch', 'Text content is not valid UTF-8.');
}

const publishInput = z
  .object({
    text: z.string().optional(),
    base64: z.string().optional(),
    mediaType: z.string().min(1),
    fileName: z.string().min(1).optional(),
  })
  .refine((input) => (input.text === undefined) !== (input.base64 === undefined), {
    message: 'Provide exactly one of text or base64.',
  });

/** Creates the managed-asset publish and read tools. */
export function createAssetTools(host: AssetToolHost): readonly Tool[] {
  const publish = createTool({
    name: 'assets-publish',
    version: '1.0.0',
    description: 'Publish a small text or base64 managed asset.',
    metadata: {
      mutates: true,
      title: 'Publish asset',
      shortDescription: 'Publish a managed asset.',
    },
    input: publishInput,
    execute: async (input, context) => {
      const access = await serviceAndPrincipal(host, context);
      if (access === undefined) return { status: 'not-found' as const };
      const admission = await access.service.admit(
        {
          source: {
            kind: 'inline',
            bytes: contentBytes({ text: input.text, base64: input.base64 }),
          },
          declaredMediaType: input.mediaType,
        },
        access.principal,
      );
      const settled = await admission.work.result();
      if (settled.outcome !== 'completed')
        return { status: 'refused' as const, reason: settled.outcome };
      return { status: 'ok' as const, assetId: admission.assetId };
    },
  });

  const read = createTool({
    name: 'assets-read',
    version: '1.0.0',
    description: 'Read managed-asset metadata and bounded text content.',
    metadata: { readOnly: true, title: 'Read asset', shortDescription: 'Read a managed asset.' },
    input: z.object({ assetId: z.string().min(1) }),
    execute: async (input, context) => {
      const access = await serviceAndPrincipal(host, context);
      if (access === undefined) return { status: 'not-found' as const };
      let descriptor: AssetDescriptor;
      try {
        descriptor = await access.service.inspect(input.assetId, access.principal);
      } catch (error) {
        if (error instanceof AssetNotFoundError) return { status: 'not-found' as const };
        throw error;
      }
      const mediaType = descriptor.mediaType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (!mediaType.startsWith('text/') && mediaType !== 'application/json')
        return { status: 'ok' as const, asset: descriptor };
      const resolved = await access.service.resolve({ assetId: input.assetId }, access.principal);
      if (resolved.content.kind !== 'bytes') return { status: 'ok' as const, asset: descriptor };
      return {
        status: 'ok' as const,
        asset: descriptor,
        ...boundedUtf8(resolved.content.bytes),
      };
    },
  });

  return [publish, read];
}

/** Builds a content part naming a managed asset for a child run. */
export function managedAssetPart(descriptor: AssetDescriptor, fileName?: string) {
  const type: 'image' | 'audio' | 'video' | 'document' =
    descriptor.modality === 'image'
      ? 'image'
      : descriptor.modality === 'audio'
        ? 'audio'
        : descriptor.modality === 'video'
          ? 'video'
          : 'document';
  return {
    // `file` is a storage modality, not an input modality supported by the model catalog. Text and
    // otherwise generic application bytes travel as documents so providers can admit them as
    // inline content while the transcript retains the managed-asset source.
    type,
    mimeType: descriptor.mediaType ?? 'application/octet-stream',
    ...(fileName === undefined ? {} : { name: fileName }),
    source: managedAssetSource(descriptor),
  };
}
