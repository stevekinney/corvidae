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
