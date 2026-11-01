/** How the Memory page words a memory's facts. */

import { MEMORY_COPY } from '../../app/copy.ts';
import type { Memory, MemoryFault, MemoryLineage } from '../../lib/memory-client.ts';

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

/** One row of a memory's facts: its label, and either plain text or a link to follow. */
export type LineageField = {
  readonly id: string;
  readonly term: string;
  readonly value: string;
  readonly link?: LineageLink;
};

/** The facts below a memory's text, in the three columns the page shows. */
export type LineageGroups = {
  /** Where it came from: its source, the chat that produced it, and the run that wrote it. */
  readonly origin: LineageField[];
  /** Trust and time: how far to trust it, what kind it is in the engine's terms, when, and a known legal hold. */
  readonly standing: LineageField[];
  /** What it corrects, and what corrected it. */
  readonly history: LineageField[];
};

/**
 * The facts of a memory, grouped for the page. From the memory itself: its source, trust, class,
 * creation time, and the chat that produced it. From the governance ledger: the run that wrote it,
 * the memory it corrects, and the memory that corrected it. An origin the server recorded nothing
 * for says so. The legal hold is `legalHold`, shown only once it is known (`undefined` leaves it
 * out): a hold has no read of its own, so it is learned from a hold, a release, or a refused forget.
 */
export function lineageGroups(
  memory: Memory,
  lineage: MemoryLineage,
  legalHold: 'held' | 'free' | undefined,
): LineageGroups {
  const { fields, notRecorded, noHistory } = MEMORY_COPY.detail;
  const link = (
    id: string,
    term: string,
    shown: string,
    target: LineageLink | undefined,
    absent: string,
  ): LineageField =>
    target === undefined ? { id, term, value: absent } : { id, term, value: shown, link: target };
  return {
    origin: [
      { id: 'source', term: fields.source, value: labelFor(MEMORY_COPY.source, memory.source) },
      link(
        'session',
        fields.session,
        MEMORY_COPY.detail.openChat,
        memory.sessionId === null ? undefined : { kind: 'chat', sessionId: memory.sessionId },
        notRecorded,
      ),
      { id: 'run', term: fields.run, value: lineage.runId ?? notRecorded },
    ],
    standing: [
      { id: 'trust', term: fields.trust, value: labelFor(MEMORY_COPY.trust, memory.trust) },
      { id: 'kind', term: fields.kind, value: kindOf(memory).label },
      { id: 'created', term: fields.created, value: formatMemoryTime(memory.createdAt) },
      ...(legalHold === undefined
        ? []
        : [
            {
              id: 'legal-hold',
              term: fields.legalHold,
              value: MEMORY_COPY.detail.legalHold[legalHold],
            },
          ]),
    ],
    history: [
      link(
        'corrects',
        fields.corrects,
        MEMORY_COPY.detail.openMemory,
        lineage.corrects === null ? undefined : { kind: 'memory', id: lineage.corrects },
        noHistory,
      ),
      link(
        'corrected-by',
        fields.correctedBy,
        MEMORY_COPY.detail.openMemory,
        lineage.correctedBy === null ? undefined : { kind: 'memory', id: lineage.correctedBy },
        noHistory,
      ),
    ],
  };
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

/** The kinds the list can be narrowed to, in plain names. `all` shows every memory. */
export type KindFilter = 'all' | 'facts' | 'chats' | 'howTo' | 'you';

/** The plain-named group a memory belongs to, or `undefined` for a class this page has no group for. */
export function groupOf(
  memory: Pick<Memory, 'memoryClass' | 'source'>,
): Exclude<KindFilter, 'all'> | undefined {
  if (memory.source === 'operator') return 'you';
  switch (memory.memoryClass) {
    case 'episodic':
    case 'working':
      return 'chats';
    case 'procedural':
      return 'howTo';
    case 'semantic':
    case 'identity':
    case 'resource':
      return 'facts';
    default:
      return undefined;
  }
}

/** Whether `memory` is shown under `filter`: every memory under `all`, and a group's own under its name. */
export function matchesKind(
  memory: Pick<Memory, 'memoryClass' | 'source'>,
  filter: KindFilter,
): boolean {
  return filter === 'all' || groupOf(memory) === filter;
}

/**
 * The plain name a row shows for a memory: Facts, From chats, How-to or From you. A class the page
 * has no group for shows as the server wrote it.
 */
export function plainKindOf(memory: Pick<Memory, 'memoryClass' | 'source'>): string {
  const group = groupOf(memory);
  return group === undefined ? memory.memoryClass : MEMORY_COPY.plainKind[group];
}

/** The words for a fault a change was answered with: a title, and what to do about it. */
export function refusalWords(fault: MemoryFault): { title: string; description: string } {
  const words = MEMORY_COPY.correct.refusal;
  switch (fault.kind) {
    case 'superseded':
    case 'successor-not-admitted':
    case 'forbidden':
    case 'not-found':
      return words[fault.kind];
    case 'not-admitted':
    case 'quarantined':
      return MEMORY_COPY.add.refusal[fault.kind];
    case 'invalid-grantee':
      return MEMORY_COPY.govern.refusal['invalid-grantee'];
    case 'other':
      return { title: words.other.title, description: fault.message };
  }
}

/** {@link refusalWords} for adding a memory, where what can be missing is the agent. */
export function addRefusalWords(fault: MemoryFault): { title: string; description: string } {
  if (fault.kind === 'not-found') return MEMORY_COPY.add.refusal['not-found'];
  const words = refusalWords(fault);
  return fault.kind === 'other' ? { ...words, title: MEMORY_COPY.add.notSaved } : words;
}
