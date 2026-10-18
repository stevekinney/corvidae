import { validateMemoryKeyPrefix } from './create-weft-memory-record-storage-helpers';

/**
 * Throws if any prefix in the list is empty, or is a prefix of another (in
 * either direction). Two families that fail this could write into each other's
 * scans.
 */
export function assertDisjointKeyPrefixes(prefixes: readonly string[]): void {
  if (prefixes.some((prefix) => prefix.length === 0)) {
    throw new Error('A key prefix must be a non-empty string.');
  }
  for (const [index, prefix] of prefixes.entries()) {
    for (const other of prefixes.slice(index + 1)) {
      if (prefix.startsWith(other) || other.startsWith(prefix)) {
        throw new Error(`Key prefixes "${prefix}" and "${other}" are not disjoint.`);
      }
    }
  }
}

/** Rejects a prefix that collides with Weft's reserved keyspace, then checks the family is disjoint. */
export function validateEvidenceProjectionKeyPrefixes(prefixes: readonly string[]): void {
  for (const prefix of prefixes) validateMemoryKeyPrefix(prefix);
  assertDisjointKeyPrefixes(prefixes);
}
