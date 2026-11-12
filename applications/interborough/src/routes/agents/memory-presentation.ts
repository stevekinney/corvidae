/** How the Memory page words a memory's facts. */

import { MEMORY_COPY } from '../../app/copy/memory.ts';
import { calendarDay, clockTime, viewerTimeZone } from '../../lib/format/clock.ts';
import type {
  Memory,
  MemoryFault,
  MemoryHistoryEntry,
  MemoryLineage,
} from '../../lib/memory-client.ts';

/** The words for `value` from `words`, or the value itself when the Bureau names one the page does not know. */
export function labelFor(words: Readonly<Record<string, string>>, value: string): string {
  return words[value] ?? value;
}

/** How recent a memory is to be "Just now": under a minute, and any time ahead of the clock. */
const JUST_NOW_MILLISECONDS = 60_000;

/**
 * When a memory was written, from the clock's day: how line two of a row says it (`row`), and how
 * the detail's line says it after "remembered" (`remembered`). Under a minute is "Just now" (and
 * "just now"), the clock for today ("10:42 AM", and "today at 10:42 AM"), "Yesterday" ("yesterday")
 * for the day before, and the day for anything older ("Oct 21"). A time that is not a date is
 * given back as the Bureau wrote it. `now` and `zone` are the clock's, so a test pins both.
 */
export function memoryTimes(
  createdAt: string,
  now: number,
  zone: string = viewerTimeZone(),
): { readonly row: string; readonly remembered: string } {
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return { row: createdAt, remembered: createdAt };
  const words = MEMORY_COPY.when;
  if (now - at < JUST_NOW_MILLISECONDS) {
    return { row: words.justNow, remembered: words.justNow.toLowerCase() };
  }
  const days = calendarDay(now, zone) - calendarDay(at, zone);
  if (days <= 0) {
    const clock = clockTime(at, zone);
    return { row: clock, remembered: words.today(clock) };
  }
  if (days === 1) return { row: words.yesterday, remembered: words.yesterday.toLowerCase() };
  const day = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  }).format(at);
  return { row: day, remembered: day };
}

/** The word for a memory's kind: Fact or How-to. */
export function kindName(memory: Pick<Memory, 'kind'>): string {
  return MEMORY_COPY.kind[memory.kind];
}

/**
 * Who wrote a memory, as a person reads it: "you" or "You" for the person, the agent's own name
 * for a memory the agent wrote, and "the system" for the system. `form` is `row` for line two of a
 * row ("From you") and `detail` for the Written by row ("You").
 */
export function writerName(
  memory: Pick<Memory, 'writer'>,
  agentName: string,
  form: 'row' | 'detail',
): string {
  return memory.writer === 'agent' ? agentName : MEMORY_COPY.writer[memory.writer][form];
}

/**
 * Line two of a row: its kind, who wrote it and when, joined by commas ("Fact, From Tool runner,
 * 10:42 AM"), never a middle dot.
 */
export function rowLine(
  memory: Pick<Memory, 'kind' | 'writer' | 'createdAt'>,
  agentName: string,
  now: number,
  zone: string = viewerTimeZone(),
): string {
  return [
    kindName(memory),
    MEMORY_COPY.from(writerName(memory, agentName, 'row')),
    memoryTimes(memory.createdAt, now, zone).row,
  ].join(', ');
}

/** The detail's context line: "Fact, remembered yesterday". */
export function contextLine(
  memory: Pick<Memory, 'kind' | 'createdAt'>,
  now: number,
  zone: string = viewerTimeZone(),
): string {
  return MEMORY_COPY.remembered(
    kindName(memory),
    memoryTimes(memory.createdAt, now, zone).remembered,
  );
}

/** What a memory's History row says: the memory a correction replaced, and the one that replaced this. */
export type HistorySummary = {
  /** The earlier memory this one corrects: what it said (when it can be read), and its identifier. */
  readonly corrects?: { readonly id: string; readonly text: string };
  /** The identifier of the memory that corrected this one. */
  readonly correctedBy?: { readonly id: string };
};

/**
 * The History row of a memory. `history` is the versions a correction replaced, the most recent
 * first, so its first entry is what this memory replaced; the ledger's `lineage` names the same
 * memory, and is the only source for one whose text can no longer be read.
 */
export function historySummary(
  lineage: Pick<MemoryLineage, 'corrects' | 'correctedBy'>,
  history: readonly Pick<MemoryHistoryEntry, 'id' | 'content'>[],
): HistorySummary {
  const earlier = history[0];
  const correctsId = lineage.corrects ?? earlier?.id ?? null;
  return {
    ...(correctsId === null
      ? {}
      : {
          corrects: {
            id: correctsId,
            text:
              earlier === undefined
                ? MEMORY_COPY.detail.history.correctsUnread
                : MEMORY_COPY.detail.history.corrects(earlier.content),
          },
        }),
    ...(lineage.correctedBy === null ? {} : { correctedBy: { id: lineage.correctedBy } }),
  };
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

/** The kinds the list can be narrowed to. `all` shows every memory. */
export type KindFilter = 'all' | Memory['kind'];

/** Who wrote what the list is narrowed to: anyone, you, or the agent whose memory this is. */
export type WriterFilter = 'all' | 'you' | 'agent';

/** Whether `memory` is shown under `filter`: every memory under `all`, and a kind's own under its name. */
export function matchesKind(memory: Pick<Memory, 'kind'>, filter: KindFilter): boolean {
  return filter === 'all' || memory.kind === filter;
}

/** Whether `memory` is shown under `filter`: a person's under `you`, and the agent's under `agent`. */
export function matchesWriter(memory: Pick<Memory, 'writer'>, filter: WriterFilter): boolean {
  if (filter === 'all') return true;
  return memory.writer === (filter === 'you' ? 'person' : 'agent');
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
      return MEMORY_COPY.add.refusal[fault.kind];
    case 'invalid-grantee':
      return MEMORY_COPY.govern.refusal['invalid-grantee'];
    case 'other':
      return { title: words.other.title, description: fault.message };
  }
}

/**
 * What a failed save the person typed into says about the failure it has no name for: the status
 * the server answered with, or that it did not answer, and that what was typed is still there.
 */
function stillHere(fault: MemoryFault): string {
  const words = MEMORY_COPY.add.stillHere;
  return fault.kind === 'other' && fault.status !== undefined
    ? words.server(fault.status)
    : words.unreached;
}

/** {@link refusalWords} for adding a memory, where what can be missing is the agent. */
export function addRefusalWords(fault: MemoryFault): { title: string; description: string } {
  if (fault.kind === 'not-found') return MEMORY_COPY.add.refusal['not-found'];
  if (fault.kind === 'other') {
    return { title: MEMORY_COPY.add.notSaved, description: stillHere(fault) };
  }
  return refusalWords(fault);
}

/** {@link refusalWords} for a correction shown in its own form, where what was typed is kept. */
export function correctionRefusalWords(fault: MemoryFault): { title: string; description: string } {
  const words = refusalWords(fault);
  return fault.kind === 'other' ? { title: words.title, description: stillHere(fault) } : words;
}
