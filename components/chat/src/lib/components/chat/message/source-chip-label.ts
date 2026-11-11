import { resolveCitationLink, type CitationSource } from '@lostgradient/cinder';

/**
 * What an inline source marker reads. A source with a safe web address reads that host when it
 * identifies one source; same-host sources with different supplied labels read those labels
 * instead. Other sources read their label. It only reads strings, so it never fetches a source.
 */
export function sourceChipLabel(
  source: CitationSource,
  sources: readonly CitationSource[] = [],
): string {
  const link = resolveCitationLink(source.url);
  if (link.kind !== 'link' || link.host === undefined) return source.label;

  // A host is useful shorthand until it ceases to identify a source. Once two
  // sources share it, keep the host out of the ambiguous marker and use the
  // labels supplied by the host instead.
  const sameHostLabels = new Set(
    sources
      .map((candidate) => {
        const candidateLink = resolveCitationLink(candidate.url);
        return candidateLink.kind === 'link' && candidateLink.host === link.host
          ? candidate.label
          : undefined;
      })
      .filter((label): label is string => label !== undefined),
  );
  return sameHostLabels.size > 1 ? source.label : link.host;
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
