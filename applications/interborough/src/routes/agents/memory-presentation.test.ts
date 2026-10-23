import { describe, expect, test } from 'bun:test';

import { MEMORY_COPY } from '../../app/copy.ts';
import type { Memory, MemoryLineage } from '../../lib/memory-client.ts';
import {
  excerpt,
  formatMemoryTime,
  highlightSegments,
  kindOf,
  labelFor,
  lineageFields,
} from './memory-presentation.ts';

const MEMORY: Memory = {
  id: 'memory-1',
  content: 'The user prefers aisle seats.',
  memoryClass: 'episodic',
  source: 'conversation',
  trust: 'untrusted',
  createdAt: '2026-10-19T08:00:00.000Z',
  sessionId: 'session-1',
};

describe('labelFor', () => {
  test('words a value the page knows, and shows any other as the Bureau wrote it', () => {
    expect(labelFor(MEMORY_COPY.trust, 'verified')).toBe(MEMORY_COPY.trust.verified);
    expect(labelFor(MEMORY_COPY.trust, 'quarantined-by-a-newer-bureau')).toBe(
      'quarantined-by-a-newer-bureau',
    );
  });
});

describe('formatMemoryTime', () => {
  test('is the reader’s locale for a date, and the Bureau’s own text for anything else', () => {
    expect(formatMemoryTime(MEMORY.createdAt)).toBe(new Date(MEMORY.createdAt).toLocaleString());
    expect(formatMemoryTime('last Tuesday')).toBe('last Tuesday');
  });
});

describe('lineageFields', () => {
  const hold = MEMORY_COPY.detail.legalHold.unknown;
  const none: MemoryLineage = { runId: null, corrects: null, correctedBy: null };
  const byId = (fields: ReturnType<typeof lineageFields>) =>
    Object.fromEntries(fields.map((field) => [field.id, field]));

  test('lists the nine fields in the order the page shows them', () => {
    const fields = lineageFields(MEMORY, { runId: 'run-7', corrects: 'a', correctedBy: 'b' }, hold);
    expect(fields.map((field) => field.id)).toEqual([
      'source',
      'trust',
      'class',
      'created',
      'session',
      'run',
      'corrects',
      'corrected-by',
      'legal-hold',
    ]);
    expect(fields.map((field) => field.term)).toEqual([
      MEMORY_COPY.detail.fields.source,
      MEMORY_COPY.detail.fields.trust,
      MEMORY_COPY.detail.fields.memoryClass,
      MEMORY_COPY.detail.fields.created,
      MEMORY_COPY.detail.fields.session,
      MEMORY_COPY.detail.fields.run,
      MEMORY_COPY.detail.fields.corrects,
      MEMORY_COPY.detail.fields.correctedBy,
      MEMORY_COPY.detail.fields.legalHold,
    ]);
  });

  test('takes the source, trust, class, time and chat from the memory, and links the chat', () => {
    const fields = byId(lineageFields(MEMORY, none, hold));
    expect(fields['source']?.value).toBe(MEMORY_COPY.source.conversation);
    expect(fields['trust']?.value).toBe(MEMORY_COPY.trust.untrusted);
    expect(fields['class']?.value).toBe(MEMORY_COPY.memoryClass.episodic);
    expect(fields['created']?.value).toBe(formatMemoryTime(MEMORY.createdAt));
    expect(fields['session']).toMatchObject({
      value: MEMORY_COPY.detail.openChat,
      link: { kind: 'chat', sessionId: 'session-1' },
    });
  });

  test('takes the run and the two corrections from the ledger, and links each correction', () => {
    const fields = byId(
      lineageFields(
        MEMORY,
        { runId: 'run-7', corrects: 'memory-0', correctedBy: 'memory-2' },
        hold,
      ),
    );
    expect(fields['run']).toEqual({
      id: 'run',
      term: MEMORY_COPY.detail.fields.run,
      value: 'run-7',
    });
    expect(fields['corrects']?.link).toEqual({ kind: 'memory', id: 'memory-0' });
    expect(fields['corrected-by']?.link).toEqual({ kind: 'memory', id: 'memory-2' });
  });

  test('says a field was not recorded, with no link, when the Bureau has nothing for it', () => {
    const fields = byId(lineageFields({ ...MEMORY, sessionId: null }, none, hold));
    for (const id of ['session', 'run', 'corrects', 'corrected-by']) {
      expect(fields[id]?.value).toBe(MEMORY_COPY.detail.notRecorded);
      expect(fields[id]?.link).toBeUndefined();
    }
  });

  test('carries the words for what is known of a legal hold', () => {
    const held = MEMORY_COPY.detail.legalHold.held;
    expect(byId(lineageFields(MEMORY, none, held))['legal-hold']?.value).toBe(held);
  });
});

describe('kindOf', () => {
  test('words each class the Bureau stores, with a sentence that explains it', () => {
    for (const memoryClass of [
      'working',
      'episodic',
      'semantic',
      'procedural',
      'identity',
      'resource',
    ] as const) {
      const kind = kindOf({ memoryClass, source: 'conversation' });
      expect(kind).toEqual(MEMORY_COPY.kind[memoryClass]);
      expect(kind.description.startsWith(`${kind.label}: `)).toBe(true);
    }
  });

  test('calls a memory a person wrote an operator memory, whatever its class', () => {
    expect(kindOf({ memoryClass: 'episodic', source: 'operator' })).toEqual(
      MEMORY_COPY.kind.operator,
    );
  });

  test('shows a class the Bureau added as it wrote it, and says there is no description', () => {
    expect(kindOf({ memoryClass: 'dreamt', source: 'conversation' })).toEqual({
      label: 'dreamt',
      description: MEMORY_COPY.kind.unknown('dreamt'),
    });
    // A name that is on every object is not a kind.
    expect(kindOf({ memoryClass: 'constructor', source: 'conversation' }).label).toBe(
      'constructor',
    );
  });
});

describe('highlightSegments', () => {
  test('marks each word searched for, ignoring case, and keeps the text whole', () => {
    const segments = highlightSegments('Window seats and a window view', 'WINDOW seats');

    expect(segments.map((segment) => segment.text).join('')).toBe('Window seats and a window view');
    expect(segments.filter((segment) => segment.match).map((segment) => segment.text)).toEqual([
      'Window',
      'seats',
      'window',
    ]);
  });

  test('marks nothing for a query with no words, and a hit that holds none of them', () => {
    expect(highlightSegments('aisle', '   ')).toEqual([{ text: 'aisle', match: false }]);
    expect(highlightSegments('aisle', 'window')).toEqual([{ text: 'aisle', match: false }]);
    expect(highlightSegments('', 'window')).toEqual([{ text: '', match: false }]);
  });

  test('reads characters a pattern would treat as syntax as plain text', () => {
    const segments = highlightSegments('costs $5 (maybe) a.b', '$5 (maybe a.b ( [');

    expect(segments.filter((segment) => segment.match).map((segment) => segment.text)).toEqual([
      '$5',
      '(maybe',
      'a.b',
    ]);
  });
});

describe('excerpt', () => {
  test('collapses whitespace and cuts a long memory short', () => {
    expect(excerpt('  one\n two  ')).toBe('one two');
    expect(excerpt('x'.repeat(60))).toBe(`${'x'.repeat(48)}…`);
  });
});
