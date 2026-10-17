import { BungalowInputError } from './errors.ts';

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const ENTRY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Entries Bungalow keeps in the root, which a content directory may not shadow. */
const RESERVED_ENTRIES = new Set(['secrets', 'logs', 'lock', 'deployment-id']);

/** An application name: lower-case letters, digits, and hyphens, starting with a letter. */
export function assertBungalowName(name: string): void {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new BungalowInputError(
      `A Bungalow name must match ${NAME_PATTERN}, received ${JSON.stringify(name)}.`,
    );
  }
}

/** A secret key. Never echoed, because a caller can mistake a value for a key. */
export function assertSecretKey(key: string): void {
  if (typeof key !== 'string' || !ENTRY_PATTERN.test(key)) {
    throw new BungalowInputError(`A secret key must match ${ENTRY_PATTERN}.`);
  }
}

/** A content directory name: the secret-key pattern, minus the entries Bungalow owns. */
export function assertDirectoryName(name: string): void {
  if (typeof name !== 'string' || !ENTRY_PATTERN.test(name)) {
    throw new BungalowInputError(`A directory name must match ${ENTRY_PATTERN}.`);
  }
  if (RESERVED_ENTRIES.has(name)) {
    throw new BungalowInputError(`The directory name "${name}" is reserved by Bungalow.`);
  }
}
