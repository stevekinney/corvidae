import { resolveCitationLink, type CitationSource } from '@lostgradient/cinder';

/**
 * What an inline source chip reads. A source with a safe web address that has a host reads that
 * host (`example.com`), so a reader sees where a claim came from at a glance; any other source
 * (an internal document, a relative path, or an address Citation refuses to link) reads its label.
 * It only reads the string, so it never fetches the source.
 */
export function sourceChipLabel(source: CitationSource): string {
  const link = resolveCitationLink(source.url);
  return link.kind === 'link' && link.host !== undefined ? link.host : source.label;
}

/** Stable keys keep an open chip attached to its own source even when an earlier source is removed. */
export function sourceChipKeys(sources: readonly CitationSource[]): string[] {
  const occurrences = new Map<string, number>();
  return sources.map(({ label, url, detail }) => {
    const signature = JSON.stringify([label, url, detail]);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    return `${occurrence}:${signature}`;
  });
}
