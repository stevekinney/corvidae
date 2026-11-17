/**
 * Citations at their claim (board row M4, COR-2440): a source that names the words it backs
 * (`CitationSource.claim`) is drawn as a marker in the message's text, right after the first place
 * those words read, on every width. The text itself is not changed: the marker is an element of
 * its own beside the words, and the message's Sources control still lists every source, as it did
 * before. A source without a claim, or whose claim is not in the text, is listed there only.
 *
 * The claim is checked where it enters Chat: a string of 1 to {@link MAX_CLAIM_LENGTH} characters
 * once trimmed, or none.
 */
import type { CitationSource } from '@lostgradient/cinder';
import { getContext, setContext, type Snippet } from 'svelte';

/** The longest claim Chat anchors a marker to, in characters. */
export const MAX_CLAIM_LENGTH = 500;

/** The element a marker is drawn in, inserted into the rendered Markdown before it is segmented. */
export const CITATION_ANCHOR_TAG = 'cinder-citation-anchor';

/** The sources that back one claim, in the order the message gives them. */
export type InlineCitationGroup = {
  readonly claim: string;
  readonly sources: readonly CitationSource[];
};

/** The claim of `source`, checked: trimmed, 1 to {@link MAX_CLAIM_LENGTH} characters, or none. */
export function claimOf(source: CitationSource): string | undefined {
  const claim: unknown = Object.hasOwn(source, 'claim') ? source.claim : undefined;
  if (typeof claim !== 'string') return undefined;
  const trimmed = claim.trim();
  if (trimmed === '' || trimmed.length > MAX_CLAIM_LENGTH) return undefined;
  return trimmed;
}

/** The message's sources grouped by the claim they back, in the order each claim first appears. */
export function inlineCitationGroups(
  sources: readonly CitationSource[] | undefined,
): InlineCitationGroup[] {
  const groups = new Map<string, CitationSource[]>();
  for (const source of sources ?? []) {
    const claim = claimOf(source);
    if (claim === undefined) continue;
    const group = groups.get(claim);
    if (group === undefined) groups.set(claim, [source]);
    else group.push(source);
  }
  return [...groups].map(([claim, grouped]) => ({ claim, sources: grouped }));
}

/** Whether `node` sits in code, where a marker would read as part of the code. */
function insideCode(node: Node): boolean {
  return node.parentElement?.closest('pre, code') != null;
}

/** A pattern that finds `claim` across any run of whitespace, as rendered Markdown reflows it. */
function claimPattern(claim: string): RegExp {
  const words = claim.split(/\s+/).map((word) => word.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.join('\\s+'));
}

/**
 * Inserts a marker anchor into `root` (detached rendered Markdown) right after the first place each
 * claim reads, outside code, and returns the indexes of the claims it anchored. The text nodes are
 * split, never rewritten, so the words read as they did.
 */
export function anchorClaims(
  root: DocumentFragment | Element,
  claims: readonly string[],
  ownerDocument: Document,
): number[] {
  const anchored: number[] = [];
  claims.forEach((claim, index) => {
    const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let text = '';
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (insideCode(node)) continue;
      nodes.push(node as Text);
      text += node.nodeValue ?? '';
    }
    const match = claimPattern(claim).exec(text);
    if (match === null) return;
    let end = match.index + match[0].length;
    for (const node of nodes) {
      const length = node.nodeValue?.length ?? 0;
      if (end > length) {
        end -= length;
        continue;
      }
      const after = node.splitText(end);
      const anchor = ownerDocument.createElement(CITATION_ANCHOR_TAG);
      anchor.dataset['cinderCitationIndex'] = String(index);
      after.before(anchor);
      anchored.push(index);
      return;
    }
  });
  return anchored;
}

/** What a message's Markdown needs to draw its citations at their claims. */
export type InlineCitations = {
  /** The claims to anchor, in order; a marker's index is its claim's index here. */
  readonly claims: readonly string[];
  /** Draws the marker for the claim at an index. */
  readonly marker: Snippet<[index: number]>;
};

const INLINE_CITATIONS = Symbol('chat-inline-citations');

/** Provides a message's inline citations to the Markdown parts under it, read through `get`. */
export function setInlineCitations(get: () => InlineCitations | undefined): void {
  setContext(INLINE_CITATIONS, get);
}

/** The inline citations of the message this Markdown belongs to, if it has any. */
export function getInlineCitations(): (() => InlineCitations | undefined) | undefined {
  return getContext<(() => InlineCitations | undefined) | undefined>(INLINE_CITATIONS);
}
