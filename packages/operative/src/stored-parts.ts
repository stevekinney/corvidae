import { multiModalContentSchema } from 'conversationalist';

/** The outcome of {@link validateStoredResponseParts}: valid, or why the stored value is not. */
export type StoredResponsePartsValidation =
  { readonly valid: true } | { readonly valid: false; readonly reason: string };

/**
 * Validates a stored response `parts` array (COR-1581): the one definition every reader of
 * persisted response parts shares.
 *
 * The value must be an array, each element must pass {@link multiModalContentSchema}, and no
 * element may carry an `inline` source: inline bytes are admitted as managed assets before a row is
 * persisted, so a stored part that still has them was never admitted. The durable run result, the
 * child topology record, the durable checkpoint records and Weft's step replay all read through
 * this function and keep their own way of refusing.
 *
 * Stored input parts are not read through it: a session input accepts `inline` on purpose.
 */
export function validateStoredResponseParts(parts: unknown): StoredResponsePartsValidation {
  if (!Array.isArray(parts)) return { valid: false, reason: 'parts must be an array' };
  for (const [index, part] of parts.entries()) {
    const parsed = multiModalContentSchema.safeParse(part);
    if (!parsed.success) {
      return { valid: false, reason: `parts[${index}] is not a valid content part` };
    }
    const source = (parsed.data as { source?: { kind?: string } }).source;
    if (source?.kind === 'inline') {
      return { valid: false, reason: `parts[${index}] carries inline bytes` };
    }
  }
  return { valid: true };
}
