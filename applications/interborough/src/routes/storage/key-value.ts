/**
 * How the key pane reads a stored value: as text when it is valid UTF-8, and whether that text is
 * JSON, which an edit of a JSON value has to stay. A value is opaque bytes (`value-preview.ts`).
 */
import { formatDateTime } from '@lostgradient/cinder';

import { previewStorageValue } from './value-preview.ts';

/** The text of a value that is valid UTF-8, or `undefined` for binary bytes. An empty value is the empty text. */
export function textOf(value: Uint8Array): string | undefined {
  const preview = previewStorageValue(value);
  if (preview.kind === 'binary') return undefined;
  return preview.kind === 'empty' ? '' : (preview.text ?? '');
}

/** How much of a value shown as text the pane draws. The rest is still there, and Copy value copies it. */
export const TEXT_VIEW_BYTES = 64 * 1024;

/** A value the pane shows as plain text, not as Fields and JSON. */
export interface TextView {
  /** What is drawn: the whole value, or its first {@link TEXT_VIEW_BYTES} bytes cut on a character. */
  readonly shown: string;
  /** Whether {@link shown} is only the start of the value. */
  readonly truncated: boolean;
  /** Why it is not Fields and JSON: it is not JSON at all, or it is JSON too large to lay out. */
  readonly reason: 'not-json' | 'too-large';
}

/**
 * How a text value is shown as text, or `undefined` when it is JSON small enough for Fields and JSON
 * (and for binary or empty bytes, which are not text). A value past {@link TEXT_VIEW_BYTES} is cut
 * there, at the last whole character.
 */
export function textViewOf(value: Uint8Array): TextView | undefined {
  const preview = previewStorageValue(value);
  if (preview.kind !== 'text' || preview.text === undefined) return undefined;
  const json = isJson(preview.text);
  if (json && preview.byteLength <= TEXT_VIEW_BYTES) return undefined;
  const truncated = preview.byteLength > TEXT_VIEW_BYTES;
  return {
    // `stream` holds back a character the cut would split, so the first bytes never end in garbage.
    // A decoder keeps what it held back, so each cut gets its own.
    shown: truncated
      ? new TextDecoder('utf-8').decode(value.subarray(0, TEXT_VIEW_BYTES), { stream: true })
      : preview.text,
    truncated,
    reason: json ? 'too-large' : 'not-json',
  };
}

/** Whether two values hold the same bytes. */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/** Whether `text` is valid JSON of any kind. */
export function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * How the Fields view writes a stored field a person reads: an ISO timestamp as the day and time in
 * their zone ("Sun Nov 1, 4:12 PM", "Today, 10:44 AM"), and anything else as the inspector writes it
 * (`undefined`). The JSON view and Copy value always hold the stored text.
 */
export function formatStoredField(field: { readonly value: unknown }): string | undefined {
  if (typeof field.value !== 'string' || !ISO_TIMESTAMP.test(field.value)) return undefined;
  const time = Date.parse(field.value);
  return Number.isNaN(time) ? undefined : formatDateTime(time, { dayWords: 'today' });
}
