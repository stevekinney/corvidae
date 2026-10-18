/**
 * The text a message exposes to input detectors (COR-716).
 *
 * A user message is not only its plain string. A multimodal message carries text
 * parts, and each media part carries prose of its own (name, alt text, caption,
 * transcript, extracted text, metadata strings) and a location (a remote URL).
 * A binary part with no plain string must not slip past a detector because its
 * message has nothing to scan, so every one of those fields is listed here, in
 * order, and a detector sees each as its own input.
 */
import type {
  ContentSource,
  JSONValue,
  MediaContent,
  Message,
  MultiModalContent,
} from 'conversationalist';
import { isMediaContent } from 'conversationalist';

/** One piece of text a detector inspects, and how a sanitized value would replace it. */
export interface InspectableField {
  /** Where the text lives, for diagnostics: `text`, `image.alt`, `document.metadata.owner`, ... */
  readonly label: string;
  readonly text: string;
  /** False when the field cannot hold arbitrary replacement text (a URL). */
  readonly replaceable: boolean;
}

export interface InspectableContent {
  readonly fields: readonly InspectableField[];
  /**
   * Rebuilds the message content with `replacements` (field index to new text)
   * applied. Parts and fields without a replacement are carried through
   * unchanged, in the original order.
   */
  rebuild(replacements: ReadonlyMap<number, string>): string | MultiModalContent[];
}

const MEDIA_TEXT_KEYS = ['name', 'alt', 'caption', 'transcript', 'extractedText'] as const;

export function inspectContent(content: Message['content']): InspectableContent {
  if (typeof content === 'string') {
    return {
      fields: content === '' ? [] : [{ label: 'text', text: content, replaceable: true }],
      rebuild: (replacements) => replacements.get(0) ?? content,
    };
  }

  const fields: InspectableField[] = [];
  /** For each field, the part it belongs to and how to rewrite that part. */
  const writers: Array<(part: MultiModalContent, text: string) => MultiModalContent> = [];
  const partOfField: number[] = [];

  content.forEach((part, partIndex) => {
    const add = (
      field: InspectableField,
      write: (current: MultiModalContent, text: string) => MultiModalContent,
    ): void => {
      fields.push(field);
      writers.push(write);
      partOfField.push(partIndex);
    };

    if (part.type === 'text') {
      if (part.text === '') return;
      add({ label: 'text', text: part.text, replaceable: true }, (current, text) =>
        current.type === 'text' ? { ...current, text } : current,
      );
      return;
    }
    if (!isMediaContent(part)) return;

    for (const key of MEDIA_TEXT_KEYS) {
      const value = part[key];
      if (value === undefined || value === '') continue;
      add({ label: `${part.type}.${key}`, text: value, replaceable: true }, (current, text) =>
        isMediaContent(current) ? { ...current, [key]: text } : current,
      );
    }
    // Locators name where bytes live; a detector reads them, but a sanitized
    // value cannot replace one, so they are not replaceable.
    const locator = sourceLocator(part.source);
    if (locator !== undefined) {
      add(
        { label: `${part.type}.${locator.label}`, text: locator.text, replaceable: false },
        (current) => current,
      );
    }
    if (part.metadata !== undefined) {
      collectMetadataStrings(part.metadata, [], (path, text) => {
        add(
          { label: `${part.type}.metadata.${path.join('.')}`, text, replaceable: true },
          (current, next) =>
            isMediaContent(current) ? replaceMetadataString(current, path, next) : current,
        );
      });
    }
  });

  return {
    fields,
    rebuild(replacements) {
      const rebuilt: MultiModalContent[] = [...content];
      for (const [fieldIndex, text] of replacements) {
        const partIndex = partOfField[fieldIndex];
        const write = writers[fieldIndex];
        const current = partIndex === undefined ? undefined : rebuilt[partIndex];
        if (partIndex === undefined || write === undefined || current === undefined) continue;
        rebuilt[partIndex] = write(current, text);
      }
      return rebuilt;
    },
  };
}

function sourceLocator(source: ContentSource): { label: string; text: string } | undefined {
  switch (source.kind) {
    case 'remote-url':
      return { label: 'url', text: source.url };
    case 'mcp-resource':
      return { label: 'uri', text: source.uri };
    case 'local-file':
      return { label: 'path', text: source.path };
    case 'a2a-reference':
      return { label: 'agentCardUrl', text: source.agentCardUrl };
    case 'provider-file':
      return { label: 'providerFileId', text: source.providerFileId };
    default:
      // Bytes (`inline`, `data-url`) and opaque ids (`upload`, `managed-asset`)
      // carry nothing a text detector can usefully read.
      return undefined;
  }
}

function collectMetadataStrings(
  value: JSONValue,
  path: readonly (string | number)[],
  visit: (path: readonly (string | number)[], text: string) => void,
): void {
  if (typeof value === 'string') {
    if (value !== '') visit(path, value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectMetadataStrings(entry, [...path, index], visit));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    collectMetadataStrings(entry, [...path, key], visit);
  }
}

function replaceMetadataString(
  part: MediaContent,
  path: readonly (string | number)[],
  text: string,
): MediaContent {
  if (part.metadata === undefined) return part;
  const metadata = structuredClone(part.metadata) as Record<string, JSONValue>;
  let cursor: JSONValue = metadata;
  for (const key of path.slice(0, -1)) {
    if (cursor === null || typeof cursor !== 'object') return part;
    cursor = (cursor as Record<string, JSONValue>)[String(key)] as JSONValue;
  }
  const last = path.at(-1);
  if (last === undefined || cursor === null || typeof cursor !== 'object') return part;
  (cursor as Record<string, JSONValue>)[String(last)] = text;
  return { ...part, metadata };
}
