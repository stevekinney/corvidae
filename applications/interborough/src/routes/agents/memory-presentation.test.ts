import { describe, expect, test } from 'bun:test';

import { MEMORY_COPY } from '../../app/copy.ts';
import type { Memory, MemoryLineage } from '../../lib/memory-client.ts';
import {
  excerpt,
  formatMemoryTime,
  groupOf,
  highlightSegments,
  kindOf,
  labelFor,
  lineageGroups,
  matchesKind,
  matchesQuery,
  plainKindOf,
  refusalWords,
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

describe('lineageGroups', () => {
  const none: MemoryLineage = { runId: null, corrects: null, correctedBy: null };
  const all = (groups: ReturnType<typeof lineageGroups>) => [
    ...groups.origin,
    ...groups.standing,
    ...groups.history,
  ];
  const byId = (groups: ReturnType<typeof lineageGroups>) =>
    Object.fromEntries(all(groups).map((field) => [field.id, field]));

  test('puts the facts in three columns, in the order the page shows them', () => {
    const groups = lineageGroups(
      MEMORY,
      { runId: 'run-7', corrects: 'a', correctedBy: 'b' },
      undefined,
    );
    expect(groups.origin.map((field) => field.id)).toEqual(['source', 'session', 'run']);
    expect(groups.standing.map((field) => field.id)).toEqual(['trust', 'kind', 'created']);
    expect(groups.history.map((field) => field.id)).toEqual(['corrects', 'corrected-by']);
    expect(all(groups).map((field) => field.term)).toEqual([
      MEMORY_COPY.detail.fields.source,
      MEMORY_COPY.detail.fields.session,
      MEMORY_COPY.detail.fields.run,
      MEMORY_COPY.detail.fields.trust,
      MEMORY_COPY.detail.fields.kind,
      MEMORY_COPY.detail.fields.created,
      MEMORY_COPY.detail.fields.corrects,
      MEMORY_COPY.detail.fields.correctedBy,
    ]);
  });

  test('takes the source, trust, kind, time and chat from the memory, and links the chat', () => {
    const fields = byId(lineageGroups(MEMORY, none, undefined));
    expect(fields['source']?.value).toBe(MEMORY_COPY.source.conversation);
    expect(fields['trust']?.value).toBe(MEMORY_COPY.trust.untrusted);
    // The engine's own term is for here: the list names a memory in plain words.
    expect(fields['kind']?.value).toBe(MEMORY_COPY.kind.episodic.label);
    expect(fields['created']?.value).toBe(formatMemoryTime(MEMORY.createdAt));
    expect(fields['session']).toMatchObject({
      value: MEMORY_COPY.detail.openChat,
      link: { kind: 'chat', sessionId: 'session-1' },
    });
  });

  test('takes the run and the two corrections from the ledger, and links each correction', () => {
    const fields = byId(
      lineageGroups(
        MEMORY,
        { runId: 'run-7', corrects: 'memory-0', correctedBy: 'memory-2' },
        undefined,
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

  test('says an origin was not recorded and a history is empty, with no link', () => {
    const fields = byId(lineageGroups({ ...MEMORY, sessionId: null }, none, undefined));
    for (const id of ['session', 'run']) {
      expect(fields[id]?.value).toBe(MEMORY_COPY.detail.notRecorded);
      expect(fields[id]?.link).toBeUndefined();
    }
    for (const id of ['corrects', 'corrected-by']) {
      expect(fields[id]?.value).toBe(MEMORY_COPY.detail.noHistory);
      expect(fields[id]?.link).toBeUndefined();
    }
  });

  test('shows a legal hold only once it is known', () => {
    expect(byId(lineageGroups(MEMORY, none, undefined))['legal-hold']).toBeUndefined();
    expect(byId(lineageGroups(MEMORY, none, 'held'))['legal-hold']?.value).toBe(
      MEMORY_COPY.detail.legalHold.held,
    );
    expect(byId(lineageGroups(MEMORY, none, 'free'))['legal-hold']?.value).toBe(
      MEMORY_COPY.detail.legalHold.free,
    );
  });
});

describe('the kind filter', () => {
  const kinds = [
    [{ memoryClass: 'semantic', source: 'conversation' }, 'facts'],
    [{ memoryClass: 'identity', source: 'conversation' }, 'facts'],
    [{ memoryClass: 'resource', source: 'conversation' }, 'facts'],
    [{ memoryClass: 'episodic', source: 'conversation' }, 'chats'],
    [{ memoryClass: 'working', source: 'conversation' }, 'chats'],
    [{ memoryClass: 'procedural', source: 'conversation' }, 'howTo'],
    // A memory a person wrote is theirs whatever its class.
    [{ memoryClass: 'semantic', source: 'operator' }, 'you'],
  ] as const;

  test('groups each class in plain words, and a person’s own memory apart', () => {
    for (const [memory, group] of kinds) expect(groupOf(memory)).toBe(group);
    expect(groupOf({ memoryClass: 'dreamt', source: 'conversation' })).toBeUndefined();
  });

  test('shows every memory under all, and a group’s own under its name', () => {
    for (const [memory, group] of kinds) {
      expect(matchesKind(memory, 'all')).toBe(true);
      expect(matchesKind(memory, group)).toBe(true);
      expect(matchesKind(memory, group === 'facts' ? 'you' : 'facts')).toBe(false);
    }
    // A class the page has no group for is listed under All only.
    const dreamt = { memoryClass: 'dreamt', source: 'conversation' };
    expect(matchesKind(dreamt, 'all')).toBe(true);
    expect(matchesKind(dreamt, 'facts')).toBe(false);
  });

  test('names a row in plain words, and shows a class it has no group for as written', () => {
    expect(plainKindOf({ memoryClass: 'episodic', source: 'conversation' })).toBe('From chats');
    expect(plainKindOf({ memoryClass: 'procedural', source: 'conversation' })).toBe('How-to');
    expect(plainKindOf({ memoryClass: 'semantic', source: 'conversation' })).toBe('Facts');
    expect(plainKindOf({ memoryClass: 'semantic', source: 'operator' })).toBe('From you');
    expect(plainKindOf({ memoryClass: 'dreamt', source: 'conversation' })).toBe('dreamt');
  });
});

describe('refusalWords', () => {
  test('words each refusal the page tells apart, and shows the server’s own words for any other', () => {
    for (const kind of [
      'superseded',
      'successor-not-admitted',
      'forbidden',
      'not-found',
    ] as const) {
      expect(refusalWords({ kind })).toEqual(MEMORY_COPY.correct.refusal[kind]);
    }
    expect(refusalWords({ kind: 'invalid-grantee' })).toEqual(
      MEMORY_COPY.govern.refusal['invalid-grantee'],
    );
    expect(refusalWords({ kind: 'other', message: 'The disk is full.' })).toEqual({
      title: MEMORY_COPY.correct.refusal.other.title,
      description: 'The disk is full.',
    });
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

describe('matchesQuery', () => {
  test('is true when the text holds a word of the query, ignoring case, and false otherwise', () => {
    expect(matchesQuery('The staging database is called orca', 'ORCA tiger')).toBe(true);
    expect(matchesQuery('The staging database is called orca', 'india')).toBe(false);
    expect(matchesQuery('anything', '   ')).toBe(false);
  });

  test('agrees with the marks, so a count of matches is a count of marked memories', () => {
    for (const [text, query] of [
      ['echo is support priority database on mode', 'echo build'],
      ['Deploys go out on Fridays', 'india'],
      ['costs $5 (maybe)', '$5 ('],
    ] as const) {
      expect(matchesQuery(text, query)).toBe(
        highlightSegments(text, query).some((segment) => segment.match),
      );
    }
  });
});
