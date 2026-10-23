/** How the Memory page words a memory's facts. */

import { MEMORY_COPY } from '../../app/copy.ts';
import type { Memory, MemoryLineage } from '../../lib/memory-client.ts';

/** The words for `value` from `words`, or the value itself when the Bureau names one the page does not know. */
export function labelFor(words: Readonly<Record<string, string>>, value: string): string {
  return words[value] ?? value;
}

/** A memory's creation time in the reader's own locale, or the Bureau's text when it is not a date. */
export function formatMemoryTime(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleString();
}

/** What a lineage field's value can lead to. */
export type LineageLink =
  | { readonly kind: 'chat'; readonly sessionId: string }
  | { readonly kind: 'memory'; readonly id: string };

/** One row of a memory's lineage: its label, and either plain text or a link to follow. */
export type LineageField = {
  readonly id: string;
  readonly term: string;
  readonly value: string;
  readonly link?: LineageLink;
};

/**
 * The rows of a memory's lineage, in the order the page shows them. From the memory itself: its
 * source, trust, class, creation time, and the chat that produced it. From the governance ledger:
 * the run that wrote it, the memory it corrects, and the memory that corrected it. A row the Bureau
 * recorded nothing for says so. The legal hold is `legalHold`, the words for what is known of it.
 */
export function lineageFields(
  memory: Memory,
  lineage: MemoryLineage,
  legalHold: string,
): LineageField[] {
  const { fields, notRecorded } = MEMORY_COPY.detail;
  const link = (
    id: string,
    term: string,
    shown: string,
    target: LineageLink | undefined,
  ): LineageField =>
    target === undefined
      ? { id, term, value: notRecorded }
      : { id, term, value: shown, link: target };
  return [
    { id: 'source', term: fields.source, value: labelFor(MEMORY_COPY.source, memory.source) },
    { id: 'trust', term: fields.trust, value: labelFor(MEMORY_COPY.trust, memory.trust) },
    {
      id: 'class',
      term: fields.memoryClass,
      value: labelFor(MEMORY_COPY.memoryClass, memory.memoryClass),
    },
    { id: 'created', term: fields.created, value: formatMemoryTime(memory.createdAt) },
    link(
      'session',
      fields.session,
      MEMORY_COPY.detail.openChat,
      memory.sessionId === null ? undefined : { kind: 'chat', sessionId: memory.sessionId },
    ),
    { id: 'run', term: fields.run, value: lineage.runId ?? notRecorded },
    link(
      'corrects',
      fields.corrects,
      MEMORY_COPY.detail.openMemory,
      lineage.corrects === null ? undefined : { kind: 'memory', id: lineage.corrects },
    ),
    link(
      'corrected-by',
      fields.correctedBy,
      MEMORY_COPY.detail.openMemory,
      lineage.correctedBy === null ? undefined : { kind: 'memory', id: lineage.correctedBy },
    ),
    { id: 'legal-hold', term: fields.legalHold, value: legalHold },
  ];
}

/** What a row's chip says about a memory, and the sentence that explains it. */
export type MemoryKind = { readonly label: string; readonly description: string };

/**
 * The kind a row shows. A memory a person wrote is an operator memory whatever its class, because
 * that is the fact the person can act on; every other memory shows the class it was stored under.
 */
export function kindOf(memory: Pick<Memory, 'memoryClass' | 'source'>): MemoryKind {
  const words: Readonly<Record<string, MemoryKind | undefined>> = {
    operator: MEMORY_COPY.kind.operator,
    working: MEMORY_COPY.kind.working,
    episodic: MEMORY_COPY.kind.episodic,
    semantic: MEMORY_COPY.kind.semantic,
    procedural: MEMORY_COPY.kind.procedural,
    identity: MEMORY_COPY.kind.identity,
    resource: MEMORY_COPY.kind.resource,
  };
  const key = memory.source === 'operator' ? 'operator' : memory.memoryClass;
  const known = Object.hasOwn(words, key) ? words[key] : undefined;
  return known ?? { label: key, description: MEMORY_COPY.kind.unknown(key) };
}

/** A run of a memory's text, and whether it is one of the words searched for. */
export type HighlightSegment = { readonly text: string; readonly match: boolean };

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * `text` cut into runs, those that are one of the words of `query` marked as matches. Matching
 * ignores case; a query with no words marks nothing. The Bureau's search ranks by meaning, so a hit
 * may contain none of the words and comes back as one plain run.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const words = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))].sort(
    (first, second) => second.length - first.length,
  );
  if (words.length === 0 || text === '') return [{ text, match: false }];
  const pattern = new RegExp(
    `(${words.map((word) => word.replace(REGEX_SPECIALS, '\\$&')).join('|')})`,
    'gi',
  );
  return text
    .split(pattern)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, match: words.includes(part.toLowerCase()) }));
}

/**
 * Whether `text` holds one of the words of `query`: the same test that marks the text
 * (`highlightSegments`), so the count of matches, the marks, and an empty result always agree.
 * The Bureau's relevance cannot say this: it has no floor, a memory that shares no word with the
 * query can score above 0, and one that shares a word can score below it.
 */
export function matchesQuery(text: string, query: string): boolean {
  return highlightSegments(text, query).some((segment) => segment.match);
}

/** A short excerpt of a memory, to name the actions of its row. */
export function excerpt(content: string): string {
  const text = content.trim().replace(/\s+/g, ' ');
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}
