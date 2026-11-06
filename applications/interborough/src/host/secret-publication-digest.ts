import { SecretProviderError } from '@lostgradient/bungalow';
import { createHash } from 'node:crypto';

function invalid(): never {
  throw new SecretProviderError('rejected', 'The logical publication request is invalid.');
}

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : invalid();
  if (typeof value !== 'object' || ancestors.has(value)) return invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) return invalid();
        entries.push(canonical(value[index], ancestors));
      }
      return `[${entries.join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      return invalid();
    if (Object.getOwnPropertySymbols(value).length !== 0) return invalid();
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Bind a trusted logical request before encryption or asynchronous publication. */
export function secretPublicationDigest(input: {
  operation: string;
  target: string;
  expectedRevision: string | null;
  payload: unknown;
}): string {
  if (input.payload === undefined) return invalid();
  if (
    typeof input.operation !== 'string' ||
    input.operation.length === 0 ||
    typeof input.target !== 'string' ||
    input.target.length === 0 ||
    (input.expectedRevision !== null && typeof input.expectedRevision !== 'string')
  )
    return invalid();
  return createHash('sha256')
    .update(canonical({ version: 1, ...input }, new Set()))
    .digest('hex');
}
