import type { CitationSource } from '@lostgradient/cinder';

/**
 * Stable keys that keep a source's row attached to that source when an earlier one is withdrawn:
 * the source's own fields and which copy of a duplicate it is. They only read strings, so they
 * never fetch a source.
 */
export function sourceKeys(sources: readonly CitationSource[]): string[] {
  const occurrences = new Map<string, number>();
  return sources.map(({ label, url, detail }) => {
    const signature = JSON.stringify([label, url, detail]);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    return `${occurrence}:${signature}`;
  });
}
