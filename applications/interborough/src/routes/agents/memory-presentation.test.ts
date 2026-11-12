import { describe, expect, test } from 'bun:test';

import { MEMORY_COPY } from '../../app/copy/memory.ts';
import type { Memory } from '../../lib/memory-client.ts';
import {
  addRefusalWords,
  contextLine,
  correctionRefusalWords,
  excerpt,
  highlightSegments,
  historySummary,
  kindName,
  labelFor,
  matchesKind,
  matchesQuery,
  matchesWriter,
  memoryTimes,
  refusalWords,
  rowLine,
  writerName,
} from './memory-presentation.ts';

const MEMORY: Memory = {
  id: 'memory-1',
  content: 'The user prefers aisle seats.',
  memoryClass: 'episodic',
  kind: 'fact',
  source: 'conversation',
  writer: 'agent',
  trust: 'untrusted',
  createdAt: '2026-10-19T08:00:00.000Z',
  sessionId: 'session-1',
};

/** The clock the times are read against, and the zone, so nothing depends on where the tests run. */
const ZONE = 'UTC';
const NOW = Date.parse('2026-11-02T10:45:00.000Z');

describe('labelFor', () => {
  test('words a value the page knows, and shows any other as the Bureau wrote it', () => {
    expect(labelFor(MEMORY_COPY.forget.targets, 'indexes')).toBe(
      MEMORY_COPY.forget.targets.indexes,
    );
    expect(labelFor(MEMORY_COPY.forget.targets, 'a-newer-target')).toBe('a-newer-target');
  });
});

describe('memoryTimes', () => {
  const at = (iso: string) => memoryTimes(iso, NOW, ZONE);

  test('says "Just now" under a minute, and for a time a little ahead of the clock', () => {
    expect(at('2026-11-02T10:44:30.000Z')).toEqual({ row: 'Just now', remembered: 'just now' });
    expect(at('2026-11-02T10:45:20.000Z')).toEqual({ row: 'Just now', remembered: 'just now' });
  });

  test('says the clock for today, and "Yesterday" for the day before', () => {
    expect(at('2026-11-02T08:15:00.000Z')).toEqual({
      row: '8:15 AM',
      remembered: 'today at 8:15 AM',
    });
    expect(at('2026-11-01T16:12:00.000Z')).toEqual({
      row: 'Yesterday',
      remembered: 'yesterday',
    });
  });

  test('says the day for anything older, and gives back a time that is not a date as written', () => {
    expect(at('2026-10-21T09:00:00.000Z')).toEqual({ row: 'Oct 21', remembered: 'Oct 21' });
    expect(at('last Tuesday')).toEqual({ row: 'last Tuesday', remembered: 'last Tuesday' });
  });

  test('counts days in the zone it is given, not in UTC', () => {
    // 11:30 PM in Denver on Nov 1 is the next day in UTC, but still yesterday in Denver.
    const denver = memoryTimes('2026-11-02T06:30:00.000Z', NOW, 'America/Denver');
    expect(denver.row).toBe('Yesterday');
  });
});

describe('what a memory is, and who wrote it', () => {
  test('words a kind as Fact or How-to', () => {
    expect(kindName({ kind: 'fact' })).toBe('Fact');
    expect(kindName({ kind: 'how-to' })).toBe('How-to');
  });

  test('says "you" in a row and "You" in the detail for a person, and the agent’s own name for the agent', () => {
    expect(writerName({ writer: 'person' }, 'Tool runner', 'row')).toBe('you');
    expect(writerName({ writer: 'person' }, 'Tool runner', 'detail')).toBe('You');
    expect(writerName({ writer: 'agent' }, 'Tool runner', 'row')).toBe('Tool runner');
    expect(writerName({ writer: 'agent' }, 'Tool runner', 'detail')).toBe('Tool runner');
    expect(writerName({ writer: 'system' }, 'Tool runner', 'row')).toBe('the system');
    expect(writerName({ writer: 'system' }, 'Tool runner', 'detail')).toBe('The system');
  });

  test('puts a row’s kind, writer and time on one line, joined by commas, never a middle dot', () => {
    const line = rowLine(
      { ...MEMORY, createdAt: '2026-11-02T08:15:00.000Z' },
      'Tool runner',
      NOW,
      ZONE,
    );

    expect(line).toBe('Fact, From Tool runner, 8:15 AM');
    expect(line).not.toContain(String.fromCodePoint(0xb7));
    expect(
      rowLine(
        { ...MEMORY, kind: 'how-to', writer: 'person', createdAt: '2026-10-21T09:00:00.000Z' },
        'Tool runner',
        NOW,
        ZONE,
      ),
    ).toBe('How-to, From you, Oct 21');
  });

  test('puts the detail’s kind and when on one line: "Fact, remembered yesterday"', () => {
    expect(contextLine({ ...MEMORY, createdAt: '2026-11-01T16:12:00.000Z' }, NOW, ZONE)).toBe(
      'Fact, remembered yesterday',
    );
    expect(contextLine({ kind: 'how-to', createdAt: '2026-10-21T09:00:00.000Z' }, NOW, ZONE)).toBe(
      'How-to, remembered Oct 21',
    );
    expect(contextLine({ kind: 'fact', createdAt: '2026-11-02T10:44:50.000Z' }, NOW, ZONE)).toBe(
      'Fact, remembered just now',
    );
  });
});

describe('historySummary', () => {
  const none = { corrects: null, correctedBy: null };

  test('says nothing for a memory never corrected', () => {
    expect(historySummary(none, [])).toEqual({});
  });

  test('says what a correction replaced, in the earlier version’s words, and where to find it', () => {
    expect(
      historySummary({ corrects: 'older', correctedBy: null }, [
        { id: 'older', content: 'Prefers phone updates.' },
        { id: 'oldest', content: 'Prefers letters.' },
      ]),
    ).toEqual({
      corrects: {
        id: 'older',
        text: MEMORY_COPY.detail.history.corrects('Prefers phone updates.'),
      },
    });
  });

  test('names the earlier memory without its words when it can no longer be read', () => {
    expect(historySummary({ corrects: 'older', correctedBy: null }, [])).toEqual({
      corrects: { id: 'older', text: MEMORY_COPY.detail.history.correctsUnread },
    });
  });

  test('takes the earlier memory from the history when the ledger names none', () => {
    expect(
      historySummary(none, [{ id: 'older', content: 'Prefers phone updates.' }]).corrects?.id,
    ).toBe('older');
  });

  test('names the memory that corrected this one', () => {
    expect(historySummary({ corrects: null, correctedBy: 'newer' }, [])).toEqual({
      correctedBy: { id: 'newer' },
    });
  });
});

describe('the filters', () => {
  test('shows every memory under all kinds, and a kind’s own under its name', () => {
    expect(matchesKind({ kind: 'fact' }, 'all')).toBe(true);
    expect(matchesKind({ kind: 'how-to' }, 'all')).toBe(true);
    expect(matchesKind({ kind: 'fact' }, 'fact')).toBe(true);
    expect(matchesKind({ kind: 'fact' }, 'how-to')).toBe(false);
    expect(matchesKind({ kind: 'how-to' }, 'how-to')).toBe(true);
  });

  test('shows every memory under anyone, a person’s under you, and the agent’s under the agent', () => {
    for (const writer of ['person', 'agent', 'system'] as const) {
      expect(matchesWriter({ writer }, 'all')).toBe(true);
    }
    expect(matchesWriter({ writer: 'person' }, 'you')).toBe(true);
    expect(matchesWriter({ writer: 'agent' }, 'you')).toBe(false);
    expect(matchesWriter({ writer: 'agent' }, 'agent')).toBe(true);
    expect(matchesWriter({ writer: 'person' }, 'agent')).toBe(false);
    // The system wrote it for neither: it is listed under Anyone only.
    expect(matchesWriter({ writer: 'system' }, 'agent')).toBe(false);
    expect(matchesWriter({ writer: 'system' }, 'you')).toBe(false);
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

describe('addRefusalWords', () => {
  test('says what happened to a memory that was not admitted', () => {
    expect(addRefusalWords({ kind: 'not-admitted' })).toEqual(
      MEMORY_COPY.add.refusal['not-admitted'],
    );
    expect(addRefusalWords({ kind: 'forbidden' })).toEqual(MEMORY_COPY.correct.refusal.forbidden);
  });

  test('says the agent is gone, because a new memory has no memory to miss', () => {
    expect(addRefusalWords({ kind: 'not-found' })).toEqual(MEMORY_COPY.add.refusal['not-found']);
  });

  test('titles a failure it has no name for as the add it is, with the status and that the text is kept', () => {
    expect(addRefusalWords({ kind: 'other', message: 'The disk is full.', status: 500 })).toEqual({
      title: 'Couldn’t save the memory',
      description: 'The server answered with an error (500). What you typed is still here.',
    });
  });

  test('says the server did not answer when no status came back', () => {
    expect(addRefusalWords({ kind: 'other', message: 'Failed to fetch' })).toEqual({
      title: MEMORY_COPY.add.notSaved,
      description: MEMORY_COPY.add.stillHere.unreached,
    });
  });
});

describe('correctionRefusalWords', () => {
  test('words a refusal the server named as the correction’s own', () => {
    expect(correctionRefusalWords({ kind: 'superseded' })).toEqual(
      MEMORY_COPY.correct.refusal.superseded,
    );
  });

  test('says a failure with no name, by its status, with the typed text kept', () => {
    expect(correctionRefusalWords({ kind: 'other', message: 'Broke.', status: 502 })).toEqual({
      title: MEMORY_COPY.correct.refusal.other.title,
      description: 'The server answered with an error (502). What you typed is still here.',
    });
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
