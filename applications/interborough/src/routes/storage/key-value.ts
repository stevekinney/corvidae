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
