/**
 * How the key pane reads a stored value: as text when it is valid UTF-8, and whether that text is
 * JSON, which an edit of a JSON value has to stay. A value is opaque bytes (`value-preview.ts`).
 */
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
