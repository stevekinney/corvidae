/**
 * The outcome table of where a note goes. A note belongs to its own turn: a turn that has a reply
 * carries it there, a turn that only called a tool carries it on the call, and a turn that made no
 * row carries it under the person's message, but never on the reply of an earlier turn.
 *
 * The turns are crossed with every way a note reaches a row: announced while the run streams (the
 * terminal history, where only the run's own rows count, then the page after the merge), carried
 * across a refresh, and read back from a reloaded thread (a stored memory record, why a run
 * stopped).
 */
import {
  appendMessages,
  createConversationHistory,
  resolveMessageNotes,
  type ConversationHistory,
  type MessageNoteInfo,
} from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import {
  CHILD_RUN_SETTLED_EVENT_NAME,
  CHILD_RUN_STARTED_EVENT_NAME,
  MEMORY_WRITTEN_EVENT_NAME,
  WAKEUP_SCHEDULED_EVENT_NAME,
  carryLiveNotes,
  noteAnnouncementOf,
  placeEventNotes,
  withEventNotes,
  withStopReason,
  withStoredMemoryNotes,
  type NoteAnnouncement,
} from './event-notes.ts';

type Shape = 'reply' | 'tool-only' | 'no-row' | 'parked';

/** The row each shape of second turn carries a note on, and the rows the second turn made. */
const SHAPES: Record<Shape, { carrier: string; made: readonly string[] }> = {
  // The turn answered: its reply carries the note.
  reply: { carrier: 'a2', made: ['a2', 'c2', 'r2'] },
  // The turn only called a tool: the call's row carries it.
  'tool-only': { carrier: 'c2', made: ['c2', 'r2'] },
  // The turn failed before any row: the person's message carries it.
  'no-row': { carrier: 'u2', made: [] },
  // The turn parked on its tool call, and the resumed turn made no row of its own: the page's own
  // row of the turn carries it.
  parked: { carrier: 'c2', made: [] },
};

const STORE_RESULT = { stored: true, id: 'rec-2', collection: 'prefs', memoryClass: 'semantic' };

function history(shape: Shape, tail: 'memory' | 'plain' = 'plain'): ConversationHistory {
  const base = appendMessages(
    createConversationHistory({ id: 'thread' }),
    { id: 'u1', role: 'user', content: 'First.' },
    { id: 'a1', role: 'assistant', content: 'First answer.' },
    { id: 'u2', role: 'user', content: 'Second.' },
  );
  const call = {
    id: 'c2',
    role: 'tool-call' as const,
    content: '',
    toolCall: { id: 'call-2', name: 'memory_store', arguments: {} },
  };
  const result = {
    id: 'r2',
    role: 'tool-result' as const,
    content: '',
    toolResult: {
      callId: 'call-2',
      outcome: 'success' as const,
      content: tail === 'memory' ? STORE_RESULT : {},
    },
  };
  switch (shape) {
    case 'reply':
      return appendMessages(
        base,
        { id: 'a2', role: 'assistant', content: 'Saving.' },
        call,
        result,
      );
    case 'tool-only':
    case 'parked':
      return appendMessages(base, call, result);
    case 'no-row':
      return base;
  }
}

function notesOn(conversation: ConversationHistory, id: string): MessageNoteInfo[] {
  const row = conversation.messages[id];
  return row === undefined ? [] : (resolveMessageNotes(row) ?? []);
}

/** Every row that holds a note, with the notes it holds. */
function placed(conversation: ConversationHistory): Record<string, string[]> {
  return Object.fromEntries(
    conversation.ids.flatMap((id) => {
      const notes = notesOn(conversation, id);
      return notes.length === 0 ? [] : [[id, notes.map((note) => note.kind)] as const];
    }),
  );
}

function announce(name: string, value: unknown): NoteAnnouncement {
  const announcement = noteAnnouncementOf({ type: 'CUSTOM', name, value }, 'helper');
  if (announcement === undefined) throw new Error('Expected an announcement.');
  return announcement;
}

const wakeup = announce(WAKEUP_SCHEDULED_EVENT_NAME, { runId: 'run', wakeAt: 1_900_000_000_000 });
const memory = (anchor?: string) =>
  announce(MEMORY_WRITTEN_EVENT_NAME, {
    ...(anchor === undefined ? {} : { messageId: anchor }),
    recordId: 'rec-2',
    collection: 'prefs',
    class: 'semantic',
  });

const shapes = Object.keys(SHAPES) as Shape[];

describe('a note announced while a run streams', () => {
  /** The rows the page held when the turn began, which the merge keeps over the terminal's copy. */
  const owns = (shape: Shape) => (id: string) => SHAPES[shape].made.includes(id);

  for (const shape of shapes) {
    const { carrier, made } = SHAPES[shape];

    test(`${shape}: the terminal history takes it only on a row the run made`, () => {
      const result = placeEventNotes(history(shape), [wakeup, memory()], {
        owns: owns(shape),
        ownedOnly: true,
      });

      if (made.length === 0) {
        expect(placed(result.conversation)).toEqual({});
        expect(result.unplaced).toEqual([wakeup, memory()]);
      } else {
        expect(placed(result.conversation)).toEqual({ [carrier]: ['wakeup', 'memory'] });
        expect(result.unplaced).toEqual([]);
      }
    });

    test(`${shape}: the page takes what the terminal could not, on its own turn`, () => {
      const result = withEventNotes(history(shape), [wakeup, memory('a1')], {
        owns: owns(shape),
      });

      // `a1` is the first turn's reply: an announcement that names it does not move the note there.
      expect(placed(result)).toEqual({ [carrier]: expect.arrayContaining(['wakeup', 'memory']) });
      expect(notesOn(result, 'a1')).toEqual([]);
    });
  }

  test('an announcement that names a row the run made keeps it', () => {
    const result = withEventNotes(history('reply'), [memory('a2')], { owns: owns('reply') });

    expect(placed(result)).toEqual({ a2: ['memory'] });
  });
});

describe('a note held by a row when the thread is read again', () => {
  for (const shape of shapes) {
    const { carrier } = SHAPES[shape];

    test(`${shape}: stays on the row that held it`, () => {
      const live = withEventNotes(history(shape), [wakeup], {});
      expect(placed(live)).toEqual({ [carrier]: ['wakeup'] });

      expect(placed(carryLiveNotes(live, history(shape)))).toEqual({ [carrier]: ['wakeup'] });
    });
  }

  test('a wakeup held on a tool row is not moved to a reply by the read', () => {
    const live = withEventNotes(history('tool-only'), [wakeup]);
    // The read also holds a later reply of the same turn.
    const next = appendMessages(history('tool-only'), {
      id: 'a3',
      role: 'assistant',
      content: 'Done.',
    });

    expect(placed(carryLiveNotes(live, next))).toEqual({ c2: ['wakeup'] });
  });
});

describe('a memory record a reloaded thread says was stored', () => {
  for (const shape of ['reply', 'tool-only', 'parked'] as const) {
    test(`${shape}: shows on its own turn, never on the first turn's reply`, () => {
      const { carrier } = SHAPES[shape];

      const result = withStoredMemoryNotes(history(shape, 'memory'), 'helper');

      expect(placed(result)).toEqual({ [shape === 'reply' ? 'a2' : carrier]: ['memory'] });
      expect(notesOn(result, 'a1')).toEqual([]);
    });
  }

  test('a turn that stored a record before it replied does not borrow the turn before', () => {
    const result = withStoredMemoryNotes(history('tool-only', 'memory'), 'helper');

    expect(notesOn(result, 'a1')).toEqual([]);
    expect(notesOn(result, 'c2')).toHaveLength(1);
  });

  test('the first turn’s record stays on the first turn', () => {
    const first = appendMessages(
      createConversationHistory({ id: 'thread' }),
      { id: 'u1', role: 'user', content: 'First.' },
      { id: 'a1', role: 'assistant', content: 'Saving.' },
      {
        id: 'c1',
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'memory_store', arguments: {} },
      },
      {
        id: 'r1',
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: STORE_RESULT },
      },
      { id: 'u2', role: 'user', content: 'Second.' },
      { id: 'a2', role: 'assistant', content: 'Second answer.' },
    );

    expect(placed(withStoredMemoryNotes(first, 'helper'))).toEqual({ a1: ['memory'] });
  });
});

describe('why the last run stopped, in a reloaded thread', () => {
  const stopped = { status: 'failed', finishReason: null, statusMessage: 'Provider down' } as const;

  for (const shape of shapes) {
    test(`${shape}: shows on the last turn, never on the first turn's reply`, () => {
      const result = withStopReason(history(shape), stopped);

      expect(placed(result)).toEqual({ [SHAPES[shape].carrier]: ['stopped'] });
      expect(notesOn(result, 'a1')).toEqual([]);
    });
  }
});

describe('a child run that settles in a turn after the one it started in', () => {
  const started = announce(CHILD_RUN_STARTED_EVENT_NAME, {
    parentRunId: 'run',
    childRunId: 'child-1',
    childAgentName: 'researcher',
  });
  const settled = announce(CHILD_RUN_SETTLED_EVENT_NAME, {
    childRunId: 'child-1',
    status: 'failed',
  });

  test('is left for the page’s row when the terminal does not hold the start', () => {
    // The page's row carries the start; the terminal's copy of that row does not.
    const page = withEventNotes(history('parked'), [started]);
    const terminal = history('parked');

    const result = placeEventNotes(terminal, [settled], { owns: () => false, ownedOnly: true });
    expect(result.unplaced).toEqual([settled]);
    expect(placed(result.conversation)).toEqual({});

    expect(notesOn(withEventNotes(page, result.unplaced), 'c2')).toMatchObject([
      { kind: 'child-run', status: 'failed' },
    ]);
  });
});
