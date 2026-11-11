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
