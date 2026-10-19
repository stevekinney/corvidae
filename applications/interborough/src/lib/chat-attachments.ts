/**
 * What a person may attach in a chat, and how a refusal or a fault is put to them (COR-1548).
 *
 * The selected agent's model decides it: `bureau.agents.list` carries the model's `media`
 * (`modalities`, `mimeFamilies` and per-part byte limits), and {@link attachmentSettings} turns it
 * into what Chat's composer takes: the types its file picker accepts and a size limit. Chat takes
 * one number, and the limits differ by type, so Chat is given the largest and
 * {@link createAttachmentUpload} applies each file's own before a single byte is sent.
 */
import {
  ChatRunFailureError,
  type ChatAttachment,
  type ChatAttachmentFailure,
  type ChatAttachmentUpload,
  type MessageInput,
  type MultiModalContent,
} from '@lostgradient/chat';
import type { z } from 'zod';

import { CHAT_COPY } from '../app/copy.ts';
import { ASSET_FILE_PROVIDER, AttachmentUploadError, uploadAsset } from './bureau-assets.ts';
import type { agentMediaSchema, Fetcher } from './bureau-client.ts';

export type AgentMedia = z.infer<typeof agentMediaSchema>;

/**
 * The largest asset the Bureau admits when a model states no limit for a type: its default
 * `DEFAULT_ASSET_POLICY.maxAssetBytes` (100 MiB). The page cannot import the Bureau, so
 * `src/host/chat-attachment-limits.test.ts` holds the two equal.
 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** The types the file picker accepts for each family a model takes. A family not here has no type to offer. */
const ACCEPT_BY_FAMILY: Readonly<Record<string, string>> = {
  image: 'image/*',
  audio: 'audio/*',
  video: 'video/*',
  document: 'application/pdf',
  text: 'text/*',
};

/** The modality a file's media type belongs to, or `undefined` for a type no family covers. */
function modalityOf(type: string): string | undefined {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type === 'application/pdf') return 'document';
  if (type.startsWith('text/')) return 'text';
  return undefined;
}

export type AttachmentSettings = {
  /** The types the composer's file picker and validation accept. */
  readonly acceptedTypes: string[];
  /** The largest limit of any type accepted: what Chat itself checks. */
  readonly maxFileSize: number;
  /** The limit for this file's own type. */
  limitFor(file: File): number;
};

/**
 * What the agent's model lets a person attach, or `null` when it lets them attach nothing: an
 * agent that names no model, or one whose model takes none of the types the page can offer.
 */
export function attachmentSettings(
  media: AgentMedia | null | undefined,
): AttachmentSettings | null {
  if (media === null || media === undefined) return null;
  const families = media.mimeFamilies.filter(
    (family) => ACCEPT_BY_FAMILY[family] !== undefined && media.modalities[family]?.input === true,
  );
  if (families.length === 0) return null;
  const limits = new Map(media.mediaLimits.map((limit) => [limit.modality, limit.maxBytes]));
  const limitOf = (modality: string | undefined): number =>
    (modality === undefined ? undefined : limits.get(modality)) ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  return {
    acceptedTypes: families.flatMap((family) => ACCEPT_BY_FAMILY[family] ?? []),
    maxFileSize: Math.max(...families.map((family) => limitOf(family))),
    limitFor: (file) => limitOf(modalityOf(file.type)),
  };
}

/** The words for a refusal or a failed upload, in `CHAT_COPY.attachments`. */
export function chatAttachmentErrorMessage(failure: ChatAttachmentFailure): string {
  switch (failure.kind) {
    case 'too-large':
      return CHAT_COPY.attachments.tooLarge(failure.maxFileSize);
    case 'type-not-accepted':
      return CHAT_COPY.attachments.typeNotAccepted;
    case 'upload-failed': {
      const { error } = failure;
      if (!(error instanceof AttachmentUploadError)) return CHAT_COPY.attachments.uploadFailed;
      switch (error.kind) {
        case 'too-large':
          return CHAT_COPY.attachments.tooLarge(error.limit ?? DEFAULT_MAX_ATTACHMENT_BYTES);
        case 'rejected':
          return CHAT_COPY.attachments.rejected;
        case 'expired':
          return CHAT_COPY.attachments.expired;
        case 'upload-failed':
          return CHAT_COPY.attachments.uploadFailed;
      }
    }
  }
}

/**
 * The hook Chat's composer calls for each attached file. A file over its own type's limit is
 * refused before the Bureau hears of it; anything else becomes an asset, and Chat keeps its
 * identifier and media type on the attachment.
 */
export function createAttachmentUpload(
  settings: AttachmentSettings,
  options: { readonly fetch?: Fetcher } = {},
): ChatAttachmentUpload {
  return async (file, { signal }) => {
    const limit = settings.limitFor(file);
    if (file.size > limit) throw new AttachmentUploadError('too-large', { limit });
    const uploaded = await uploadAsset(file, {
      signal,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const mimeType = uploaded.mediaType ?? (file.type === '' ? undefined : file.type);
    return { id: uploaded.assetId, ...(mimeType === undefined ? {} : { mimeType }) };
  };
}

/** The run codes that mean the model could not take an attachment. */
const MEDIA_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'UNSUPPORTED_MEDIA_TYPE',
  'MEDIA_NOT_ADMITTED',
]);

/**
 * The words for a run refused over media, or `undefined` for any other failure, which keeps its
 * own message. The door answers `INVALID_INPUT` for an asset it cannot use (one that is missing,
 * deleted, or another owner's), and that code names an attachment only when the turn carried one.
 * The raw message can name an asset, so it is never shown for these.
 */
export function runFailureMessage(
  error: unknown,
  turn: { readonly hadAttachments: boolean },
): string | undefined {
  if (!(error instanceof ChatRunFailureError)) return undefined;
  const code = error.runError.backendCode ?? error.runError.code;
  if (MEDIA_REFUSAL_CODES.has(code) || (code === 'INVALID_INPUT' && turn.hadAttachments)) {
    return CHAT_COPY.attachments.modelRefusedMedia;
  }
  return undefined;
}

/** The media part type a file of `mimeType` is carried as. A text file is a document. */
function mediaTypeOf(mimeType: string): 'image' | 'audio' | 'video' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

/**
 * The message with the files that finished uploading on it, as media parts that name their assets
 * through the `bureau` provider, after its text. The row the chat appends then holds the person's
 * attachments from the moment they send, and a thread read back from the Bureau holds the same
 * parts. A message with no uploaded file is returned as it is.
 */
export function messageWithAttachments(
  message: MessageInput,
  attachments: readonly ChatAttachment[],
): MessageInput {
  const parts = attachments.flatMap((attachment): MultiModalContent[] => {
    const { reference } = attachment;
    if (attachment.status !== 'ready' || reference === undefined) return [];
    const mimeType = reference.mimeType ?? attachment.file.type;
    return [
      {
        type: mediaTypeOf(mimeType),
        ...(mimeType === '' ? {} : { mimeType }),
        source: {
          kind: 'provider-file',
          provider: ASSET_FILE_PROVIDER,
          providerFileId: reference.id,
        },
      },
    ];
  });
  if (parts.length === 0) return message;
  const lead: MultiModalContent[] =
    typeof message.content === 'string'
      ? message.content === ''
        ? []
        : [{ type: 'text', text: message.content }]
      : [...message.content];
  return { ...message, content: [...lead, ...parts] };
}
