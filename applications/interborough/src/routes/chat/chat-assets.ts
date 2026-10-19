/**
 * The managed assets a chat row carries, read from the row (COR-1548).
 *
 * An assistant row lists the assets an agent returned under `bureau:assetParts` in its metadata:
 * `run-wiring.ts` stamps them from the run's `bureau.asset-part` events, and a reloaded thread's
 * snapshot holds the same key. A user row holds the person's own attachments as media parts whose
 * source is a file from the `bureau` provider. Both are read here the one way, so the transcript
 * shows a live row and a reloaded one alike.
 */
import type { ConversationHistory } from '@lostgradient/chat';

import { ASSET_FILE_PROVIDER, ASSET_PARTS_METADATA_KEY } from '../../lib/bureau-assets.ts';

type Message = ConversationHistory['messages'][string];

/** One asset on a row, and what it is. */
export type ChatAsset = {
  readonly assetId: string;
  readonly mediaType: string;
};

/** How a row shows an asset. */
export type ChatAssetKind = 'image' | 'audio' | 'video' | 'file';

const UNKNOWN_MEDIA_TYPE = 'application/octet-stream';

/**
 * How an asset of `mediaType` is shown. An image other than SVG is an image, audio and video are
 * played, and anything else is a download. SVG can carry script, so the Bureau serves it as a
 * download and the page offers it as one.
 */
export function kindOf(mediaType: string): ChatAssetKind {
  const type = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  if (type === 'image/svg+xml') return 'file';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return 'file';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The assets an assistant row's metadata lists, in part order. */
function announcedAssets(message: Message): ChatAsset[] {
  const listed: unknown = message.metadata?.[ASSET_PARTS_METADATA_KEY];
  if (!Array.isArray(listed)) return [];
  return listed
    .flatMap((entry): { index: number; asset: ChatAsset }[] =>
      isRecord(entry) && typeof entry['assetId'] === 'string' && typeof entry['index'] === 'number'
        ? [
            {
              index: entry['index'],
              asset: {
                assetId: entry['assetId'],
                mediaType:
                  typeof entry['mediaType'] === 'string' && entry['mediaType'] !== ''
                    ? entry['mediaType']
                    : UNKNOWN_MEDIA_TYPE,
              },
            },
          ]
        : [],
    )
    .toSorted((left, right) => left.index - right.index)
    .map(({ asset }) => asset);
}

/** The assets a user row's media parts name. */
function attachedAssets(message: Message): ChatAsset[] {
  if (typeof message.content === 'string') return [];
  return message.content.flatMap((part): ChatAsset[] => {
    if (!('source' in part) || part.source.kind !== 'provider-file') return [];
    if (part.source.provider !== ASSET_FILE_PROVIDER) return [];
    return [
      {
        assetId: part.source.providerFileId,
        mediaType:
          part.mimeType === undefined || part.mimeType === '' ? UNKNOWN_MEDIA_TYPE : part.mimeType,
      },
    ];
  });
}

/** The managed assets `message` carries: those an agent returned, or those the person attached. */
export function assetsOf(message: Message): ChatAsset[] {
  if (message.role === 'assistant') return announcedAssets(message);
  if (message.role === 'user') return attachedAssets(message);
  return [];
}

/** Whether `part` is a media part whose source is a file from the Bureau. */
function isAssetPart(part: Exclude<Message['content'], string>[number]): boolean {
  return (
    'source' in part &&
    part.source.kind === 'provider-file' &&
    part.source.provider === ASSET_FILE_PROVIDER
  );
}

/**
 * The conversation as Chat should lay out, with the Bureau's files taken out of the rows' content.
 * Chat shows a media part it cannot load as a line of placeholder text, which names the asset; the
 * page shows these files itself (`chat-assets.svelte`), from the rows of the conversation it
 * keeps. A row that names no file is the very row it was, and a conversation with no such row is
 * the very conversation, so a transcript that did not change costs nothing.
 */
export function withoutAssetParts(conversation: ConversationHistory): ConversationHistory {
  let changed = false;
  const messages: Record<string, Message> = {};
  for (const [id, message] of Object.entries(conversation.messages)) {
    if (typeof message.content === 'string' || !message.content.some(isAssetPart)) {
      messages[id] = message;
      continue;
    }
    changed = true;
    messages[id] = { ...message, content: message.content.filter((part) => !isAssetPart(part)) };
  }
  return changed ? { ...conversation, messages } : conversation;
}

/** Whether a row has anything of its own to show: some text, or a part that is not text. */
export function hasContent(message: Message): boolean {
  if (typeof message.content === 'string') return message.content.trim() !== '';
  return message.content.some((part) => part.type !== 'text' || part.text.trim() !== '');
}
