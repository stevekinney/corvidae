/**
 * A message's file and data parts as native content (COR-788, part 2): what an A2A caller may
 * attach to a task it starts or to a task that is still working.
 *
 * - A `url` part is accepted only when it is this Bureau's own asset route,
 *   `<publicUrl>/assets/<id>/content`, exactly: the caller's `bureau.assets:read` scope and the
 *   owner predicate decide whether the asset is theirs to use. Any other URL is refused, because a
 *   Bureau never fetches an address a caller names. Another owner's asset, one that was never
 *   admitted, and one that is expired, deleted, rejected, quarantined or still pending all read
 *   alike, as one `-32602` that names only the identifier the caller sent.
 * - A `raw` part is admitted as the caller's own asset (`bureau.assets:write`), bounded by the
 *   asset policy's inline ceiling and allowed media types, and enters the conversation as that
 *   asset's `managed-asset` source. The caller's history keeps the asset-route form, never bytes.
 * - A `data` part enters as an inline JSON document, for an agent that reads documents.
 * - A part whose media type the Agent Card does not advertise is `-32005`, before anything is
 *   admitted and before any provider call.
 *
 * Planning ({@link planInbound}) only reads. Admission ({@link admitInline}) is the one step with
 * an effect, and its result is what a retry reads back instead of admitting again.
 *
 * @module a2a-inbound-parts
 */

import { Message } from '@a2a-js/sdk';
import { ContentTypeNotSupportedError, RequestMalformedError } from '@a2a-js/sdk/errors';
import {
  type MediaContent,
  type MultiModalContent,
  type TextContent,
  fromA2APart,
} from 'conversationalist';

import { AssetAdmissionError, AssetNotFoundError } from '../assets/errors.ts';
import type { AssetService } from '../assets/types.ts';
import { assetContentUrl } from './a2a-reply-parts.ts';

/** An asset a message's inline bytes were admitted as, in the order the parts appear. */
export type AdmittedAsset = {
  readonly assetId: string;
  /** The media type admission detected, which the stored row and the history both name. */
  readonly mediaType: string;
};

/** What planning a message's parts needs. */
export type InboundContext = {
  readonly publicUrl: string;
  /** The asset service, or `undefined` when the Bureau has none (no file part is read). */
  readonly assets: Pick<AssetService, 'admit' | 'inspect' | 'delete' | 'policy'> | undefined;
  /** The caller's owner string: whose assets the message may name and whose it admits. */
  readonly owner: string;
  /** Whether the caller holds `bureau.assets:read`. */
  readonly mayReadAssets: boolean;
  /** Whether the caller holds `bureau.assets:write`. */
  readonly mayWriteAssets: boolean;
  /** The media types the Agent Card advertises as input. */
  readonly inputModes: readonly string[];
};

/** One part of a planned message: finished content, or bytes still to be admitted. */
type PlannedPart =
  | { readonly kind: 'content'; readonly content: MultiModalContent }
  | {
      readonly kind: 'inline';
      readonly template: MediaContent;
      readonly bytes: Uint8Array;
      readonly declaredMediaType: string;
    };

/** A message's parts as the boundary read them: nothing admitted yet. */
export type InboundPlan = {
  readonly parts: readonly PlannedPart[];
  /** Whether any part is not text: the message then enters as content, not as a string. */
  readonly hasMedia: boolean;
  /** How many parts hold bytes to admit. */
  readonly inlineCount: number;
};

function invalid(message: string): RequestMalformedError {
  return new RequestMalformedError(message);
}

function notFound(assetId: string): RequestMalformedError {
  return invalid(`Asset '${assetId}' was not found.`);
}

/** Whether a media type `requested` is one of the `offered` ones, a `type/*` family included. */
export function modeAccepted(offered: readonly string[], requested: string): boolean {
  const wanted = requested.split(';', 1)[0]!.trim().toLowerCase();
  return offered.some((mode) => {
    if (mode === wanted) return true;
    const family = (value: string) => (value.endsWith('/*') ? value.slice(0, -1) : undefined);
    const prefix = family(mode) ?? family(wanted);
    return prefix !== undefined && mode.startsWith(prefix) && wanted.startsWith(prefix);
  });
}

function unsupported(mediaType: string, inputModes: readonly string[]): Error {
  return new ContentTypeNotSupportedError(
    `Media type '${mediaType}' is not supported; this agent accepts ${inputModes.join(', ')}.`,
  );
}

/**
 * The asset an asset-route URL names, or `undefined` for any other address: the route is matched
 * whole (origin, path prefix, one identifier segment, `/content`), with no query or fragment.
 */
export function assetIdOfRoute(publicUrl: string, url: string): string | undefined {
  const prefix = assetContentUrl(publicUrl, '').slice(0, -'/content'.length);
  if (!url.startsWith(prefix) || !url.endsWith('/content')) return undefined;
  const segment = url.slice(prefix.length, -'/content'.length);
  if (segment === '' || /[/?#]/.test(segment)) return undefined;
  let assetId: string;
  try {
    assetId = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  return assetContentUrl(publicUrl, assetId) === url ? assetId : undefined;
}

/** Whether the card advertises documents as input: the agent can read a JSON data part. */
export function readsDocuments(inputModes: readonly string[]): boolean {
  return modeAccepted(inputModes, 'application/pdf');
}

/**
 * Whether a message holds anything besides text that enters the conversation: a file part, or a
 * data part for an agent that reads documents. Any other data part is ignored, as it always was.
 */
export function holdsMedia(message: Message, inputModes: readonly string[]): boolean {
  return message.parts.some((part) => {
    const kind = part.content?.$case;
    return kind === 'url' || kind === 'raw' || (kind === 'data' && readsDocuments(inputModes));
  });
}

/** Whether a message holds a part that is a file (a `url` or `raw` part). */
export function holdsFileParts(message: Message): boolean {
  return message.parts.some((part) => {
    const kind = part.content?.$case;
    return kind === 'url' || kind === 'raw';
  });
}

async function plannedUrlPart(
  wire: Record<string, unknown>,
  url: string,
  context: InboundContext,
): Promise<PlannedPart> {
  const { assets } = context;
  if (assets === undefined) throw unsupported('a file', context.inputModes);
  const assetId = assetIdOfRoute(context.publicUrl, url);
  if (assetId === undefined) {
    throw invalid(
      'A file part must name one of this server’s assets; other addresses are not read.',
    );
  }
  // A credential without the read scope reads every asset alike, before any is looked up.
  if (!context.mayReadAssets) throw notFound(assetId);
  let descriptor;
  try {
    descriptor = await assets.inspect(assetId, { id: context.owner });
  } catch (error) {
    if (error instanceof AssetNotFoundError) throw notFound(assetId);
    throw error;
  }
  if (descriptor.state !== 'available') throw notFound(assetId);
  const mediaType = descriptor.mediaType ?? '';
  if (mediaType === '' || !modeAccepted(context.inputModes, mediaType)) {
    throw unsupported(mediaType === '' ? 'unknown' : mediaType, context.inputModes);
  }
  const content = fromA2APart({ ...wire, mediaType } as Parameters<typeof fromA2APart>[0]);
  return {
    kind: 'content',
    content: { ...content, source: { kind: 'managed-asset', assetId } } as MediaContent,
  };
}

/**
 * Reads a message's parts as native content, without admitting anything: an asset-route part is
 * authorized and checked against the card, inline bytes are checked against the card and the
 * asset policy's ceiling, and a data part needs an agent that reads documents.
 *
 * @throws {ContentTypeNotSupportedError} A part outside the card's input modes (`-32005`).
 * @throws {RequestMalformedError} An unusable asset or a foreign address (`-32602`).
 */
export async function planInbound(message: Message, context: InboundContext): Promise<InboundPlan> {
  const wireParts = (Message.toJSON(message) as { parts: Record<string, unknown>[] }).parts;
  const planned: PlannedPart[] = [];
  let hasMedia = false;
  for (const [index, part] of message.parts.entries()) {
    const wire = wireParts[index]!;
    const body = part.content;
    if (body?.$case === 'text') {
      // A caller's text carries no citations: those are a model's, not a user's.
      planned.push({
        kind: 'content',
        content: { type: 'text', text: body.value } satisfies TextContent,
      });
    } else if (body?.$case === 'data') {
      // A data part is a JSON document: an agent that reads none ignores it, as it always did.
      if (readsDocuments(context.inputModes)) {
        hasMedia = true;
        planned.push({ kind: 'content', content: fromA2APart(wire as never) });
      }
    } else if (body?.$case === 'url') {
      hasMedia = true;
      planned.push(await plannedUrlPart(wire, body.value, context));
    } else if (body?.$case === 'raw') {
      hasMedia = true;
      const mediaType = part.mediaType.split(';', 1)[0]!.trim().toLowerCase();
      if (context.assets === undefined || mediaType === '') {
        throw unsupported(mediaType === '' ? 'unknown' : mediaType, context.inputModes);
      }
      if (!modeAccepted(context.inputModes, mediaType)) {
        throw unsupported(mediaType, context.inputModes);
      }
      if (!context.mayWriteAssets)
        throw invalid('Sending file bytes requires bureau.assets:write.');
      if (body.value.byteLength > context.assets.policy.maxInlineBytes) {
        throw invalid('A file part is larger than this server admits inline.');
      }
      planned.push({
        kind: 'inline',
        template: fromA2APart(wire as never) as MediaContent,
        bytes: new Uint8Array(body.value),
        declaredMediaType: mediaType,
      });
    } else {
      throw unsupported('an empty part', context.inputModes);
    }
  }
  return {
    parts: planned,
    hasMedia,
    inlineCount: planned.filter((part) => part.kind === 'inline').length,
  };
}

/** Deletes assets this attempt admitted and no claim records; a failure leaves them to expire. */
export async function discardAssets(
  assets: Pick<AssetService, 'delete'> | undefined,
  owner: string,
  admitted: readonly AdmittedAsset[],
): Promise<void> {
  if (assets === undefined) return;
  await Promise.all(
    admitted.map(async ({ assetId }) => {
      try {
        await assets.delete(assetId, { id: owner }).result();
      } catch {
        // The asset's retention expires it.
      }
    }),
  );
}

/**
 * Admits the plan's inline bytes as the caller's assets, in part order, and waits until each is
 * `available`. Any refusal deletes what this call admitted and is answered as `-32005` for a media
 * type the policy or the bytes contradict, `-32602` otherwise.
 */
export async function admitInline(
  plan: InboundPlan,
  context: InboundContext,
): Promise<readonly AdmittedAsset[]> {
  const { assets } = context;
  const admitted: AdmittedAsset[] = [];
  if (assets === undefined) return admitted;
  try {
    for (const part of plan.parts) {
      if (part.kind !== 'inline') continue;
      const admission = await assets.admit(
        {
          source: { kind: 'inline', bytes: part.bytes },
          declaredMediaType: part.declaredMediaType,
        },
        { id: context.owner },
      );
      admitted.push({ assetId: admission.assetId, mediaType: part.declaredMediaType });
      const result = await admission.work.result();
      if (result.outcome !== 'completed') {
        const code = result.outcome === 'failed' ? result.rejection.code : 'aborted';
        throw new AssetAdmissionError(code, 'The file was not admitted.');
      }
      const detected = result.value.mediaType ?? part.declaredMediaType;
      if (!modeAccepted(context.inputModes, detected)) {
        throw unsupported(detected, context.inputModes);
      }
      admitted[admitted.length - 1] = { assetId: admission.assetId, mediaType: detected };
    }
  } catch (error) {
    await discardAssets(assets, context.owner, admitted);
    if (error instanceof AssetAdmissionError) {
      if (error.code === 'media-type-mismatch' || error.code === 'media-type-not-allowed') {
        throw new ContentTypeNotSupportedError(`A file part was refused (${error.code}).`);
      }
      throw invalid(`A file part was refused (${error.code}).`);
    }
    throw error;
  }
  return admitted;
}

/** The message's native content, with each inline part replaced by the asset it was admitted as. */
export function contentOf(
  plan: InboundPlan,
  admitted: readonly AdmittedAsset[],
): MultiModalContent[] {
  let next = 0;
  return plan.parts.map((part) => {
    if (part.kind === 'content') return part.content;
    const asset = admitted[next]!;
    next += 1;
    return {
      ...part.template,
      mimeType: asset.mediaType,
      source: { kind: 'managed-asset', assetId: asset.assetId },
    };
  });
}

/**
 * The message as the task's A2A history keeps it: each raw part becomes a file part on the asset
 * route, so no bytes are ever persisted.
 */
export function historyMessageOf(
  message: Message,
  admitted: readonly AdmittedAsset[],
  publicUrl: string,
): Message {
  let next = 0;
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.content?.$case !== 'raw') return part;
      const asset = admitted[next]!;
      next += 1;
      return {
        ...part,
        content: { $case: 'url' as const, value: assetContentUrl(publicUrl, asset.assetId) },
        mediaType: asset.mediaType,
      };
    }),
  };
}
