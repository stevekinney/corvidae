import type { SessionInputPayload, UserAdmissibleContent } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function parsePart(part: unknown, index: number): UserAdmissibleContent {
  if (!isRecord(part)) throw new TypeError(`Session input payload part ${index} is not an object.`);
  switch (part['type']) {
    case 'text': {
      if (typeof part['text'] !== 'string' || part['citations'] !== undefined) {
        throw new TypeError(`Session input payload part ${index} is not a valid text part.`);
      }
      return { type: 'text', text: part['text'] };
    }
    case 'image': {
      if (
        typeof part['url'] !== 'string' ||
        !isOptionalString(part['mimeType']) ||
        !isOptionalString(part['text'])
      ) {
        throw new TypeError(`Session input payload part ${index} is not a valid image part.`);
      }
      return {
        type: 'image',
        url: part['url'],
        ...(part['mimeType'] !== undefined ? { mimeType: part['mimeType'] as string } : {}),
        ...(part['text'] !== undefined ? { text: part['text'] as string } : {}),
      };
    }
    case 'document': {
      const source = part['source'];
      if (
        typeof part['name'] !== 'string' ||
        typeof part['mimeType'] !== 'string' ||
        !isRecord(source)
      ) {
        throw new TypeError(`Session input payload part ${index} is not a valid document part.`);
      }
      if (source['kind'] === 'base64' && typeof source['data'] === 'string') {
        return {
          type: 'document',
          name: part['name'],
          mimeType: part['mimeType'],
          source: { kind: 'base64', data: source['data'] },
        };
      }
      if (source['kind'] === 'reference' && typeof source['uri'] === 'string') {
        return {
          type: 'document',
          name: part['name'],
          mimeType: part['mimeType'],
          source: { kind: 'reference', uri: source['uri'] },
        };
      }
      throw new TypeError(`Session input payload part ${index} has an invalid document source.`);
    }
    default:
      throw new TypeError(
        `Session input payload part ${index} has an unsupported type; only text, image, and document are admissible.`,
      );
  }
}

/**
 * Narrows a persisted value to a {@link SessionInputPayload}, or throws.
 *
 * A session input is stored as plain data, and whatever reads it back (an
 * untyped caller, a record written by another version) cannot be trusted to
 * match the type. The check is exhaustive over the admissible variants, so a
 * malformed value is refused where it is read rather than failing a run later,
 * inside a step.
 */
export function parseSessionInputPayload(value: unknown): SessionInputPayload {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    throw new TypeError('A session input payload must be a string or an array of content parts.');
  }
  return value.map((part: unknown, index) => parsePart(part, index));
}
