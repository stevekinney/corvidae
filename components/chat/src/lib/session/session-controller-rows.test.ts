/**
 * The outcome matrix of `mergeRunHistory`: every kind of row the merge can meet, crossed with every
 * shape of run the chat can end. Each shape states the order the Bureau's thread has (the terminal
 * frame's order, which is the thread's) and which rows are of which kind; each cell asserts where
 * that kind's rows land and whose object each keeps.
 *
 * The shapes are the ones the controller's caller produces (`session-controller-run.ts`): on a page
 * that started the run, the run's user turn and its placeholder are provisional and on screen when
 * the run starts; on a page that joined or resumed a run (Interborough's attach), the turn runs over
 * a hidden row and every snapshot replaces the transcript on screen, so the provisional rows are
 * gone from the screen by the time the terminal arrives and the follow-ups carry no marker. A page
 * that never had a snapshot keeps its own order, with a follow-up appended after the replies.
 */
import { describe, expect, test } from 'bun:test';
import {
  appendMessages,
  createConversationHistory,
  isFollowUpMessage,
  markMessageFollowUp,
} from '../components/chat/builders.ts';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import { getOwn } from '../utilities/get-own.ts';
import { mergeRunHistory } from './session-controller-rows.ts';

const KINDS = [
  'follow-up',
  'retained',
  'streamed provisional',
  'snapshot only',
  'client only',
  'earlier run',
] as const;
type Kind = (typeof KINDS)[number];

interface Shape {
  readonly name: string;
  /** On screen when the terminal arrives; `*` marks a follow-up, `~` a hidden row. */
  readonly current: readonly string[];
  /** The terminal frame's history: the Bureau's thread order. */
  readonly terminal: readonly string[];
  readonly provisional: readonly string[];
  readonly start: readonly string[];
  /** The required order: the thread's order for every row the Bureau names. */
  readonly expected: readonly string[];
  /** Which rows are of which kind; a kind absent from the shape has none. */
  readonly rows: Readonly<Partial<Record<Kind, readonly string[]>>>;
}

/**
 * Ids: `u` the turn that opened the run, `p` the client's placeholder for a reply, `h` the hidden
 * row an attach runs over, `r*` replies under the Bureau's ids, `F*` follow-ups, `L` a follow-up the
 * terminal omits, `x`/`xa` a turn a second tab or a schedule added, `e*` an earlier run's rows, `t`
 * the turn that parked and `A` the answer that resumed it.
 */
export const MATRIX: readonly Shape[] = [
  {
    name: 'page-started, one follow-up, no snapshot on screen',
    current: ['e0', 'e1', 'u', 'r0', 'r1', 'F*'],
    terminal: ['e0', 'e1', 'u', 'r0', 'F', 'r1'],
    provisional: ['u', 'r0', 'r1'],
    start: ['e0', 'e1', 'u'],
    expected: ['e0', 'e1', 'u', 'r0', 'F', 'r1'],
    rows: {
      'follow-up': ['F'],
      retained: ['u'],
      'streamed provisional': ['r0', 'r1'],
      'earlier run': ['e0', 'e1'],
    },
  },
  {
    name: 'page-started, two follow-ups, no snapshot on screen',
    current: ['u', 'r0', 'r1', 'r2', 'F1*', 'F2*'],
    terminal: ['u', 'r0', 'F1', 'r1', 'F2', 'r2'],
    provisional: ['u', 'r0', 'r1', 'r2'],
    start: ['u'],
    expected: ['u', 'r0', 'F1', 'r1', 'F2', 'r2'],
    rows: {
      'follow-up': ['F1', 'F2'],
      retained: ['u'],
      'streamed provisional': ['r0', 'r1', 'r2'],
    },
  },
  {
    name: 'page-started, two follow-ups, closing snapshot on screen',
    current: ['u', 'r0', 'F1', 'r1', 'F2', 'r2'],
    terminal: ['u', 'r0', 'F1', 'r1', 'F2', 'r2'],
    provisional: ['u', 'r0', 'r1', 'r2'],
    start: ['u'],
    expected: ['u', 'r0', 'F1', 'r1', 'F2', 'r2'],
    rows: {
      'follow-up': ['F1', 'F2'],
      retained: ['u'],
      'streamed provisional': ['r0', 'r1', 'r2'],
    },
  },
  {
    name: 'page-started, one follow-up, placeholder never renamed',
    current: ['u', 'p', 'F*'],
    terminal: ['u', 'r0', 'F', 'r1'],
    provisional: ['u', 'p'],
    start: ['u'],
    expected: ['u', 'r0', 'F', 'r1'],
    rows: {
      'follow-up': ['F'],
      retained: ['u'],
      'streamed provisional': ['p'],
      'snapshot only': ['r0', 'r1'],
    },
  },
  {
    name: 'no-snapshot start, a follow-up the terminal omits, after a streamed reply',
    current: ['u', 'p', 'L*'],
    terminal: ['u', 'r0'],
    provisional: ['u', 'p'],
    start: ['u'],
    expected: ['u', 'r0', 'L'],
    rows: {
      'follow-up': ['L'],
      retained: ['u'],
      'streamed provisional': ['p'],
      'snapshot only': ['r0'],
      'client only': ['L'],
    },
  },
  {
    name: 'no-snapshot start, a turn from elsewhere the terminal omits',
    current: ['u', 'p', 'x'],
    terminal: ['u', 'r0'],
    provisional: ['u', 'p'],
    start: ['u'],
    expected: ['u', 'r0', 'x'],
    rows: {
      retained: ['u'],
      'streamed provisional': ['p'],
      'snapshot only': ['r0'],
      'client only': ['x'],
    },
  },
  {
    name: "no-snapshot start, an earlier run's rows the terminal omits",
    current: ['e0', 'e1', 'u', 'p'],
    terminal: ['u', 'r0'],
    provisional: ['u', 'p'],
    start: ['e0', 'e1', 'u'],
    expected: ['e0', 'e1', 'u', 'r0'],
    rows: {
      retained: ['u'],
      'streamed provisional': ['p'],
      'snapshot only': ['r0'],
      'client only': ['e0', 'e1'],
      'earlier run': ['e0', 'e1'],
    },
  },
  {
    name: 'attach, one follow-up, snapshot on screen',
    current: ['u1', 'r0', 'F', 'r1'],
    terminal: ['u1', 'r0', 'F', 'r1'],
    provisional: ['h', 'p'],
    start: ['u1', 'r0', 'h'],
    expected: ['u1', 'r0', 'F', 'r1'],
    rows: {
      'follow-up': ['F'],
      retained: ['u1', 'r0'],
      'streamed provisional': ['p'],
      'client only': ['h'],
      'earlier run': ['u1', 'r0'],
    },
  },
  {
    name: 'attach, one follow-up marked, nothing on screen at the start',
    current: ['u', 'r0', 'F*', 'r1'],
    terminal: ['u', 'r0', 'F', 'r1'],
    provisional: [],
    start: [],
    expected: ['u', 'r0', 'F', 'r1'],
    rows: { 'follow-up': ['F'], 'earlier run': ['u'] },
  },
  {
    name: 'attach, two follow-ups marked, nothing on screen at the start',
    current: ['u', 'F1*', 'r0', 'F2*', 'r1'],
    terminal: ['u', 'F1', 'r0', 'F2', 'r1'],
    provisional: [],
    start: [],
    expected: ['u', 'F1', 'r0', 'F2', 'r1'],
    rows: { 'follow-up': ['F1', 'F2'], 'earlier run': ['u'] },
  },
  {
    name: 'attach, a follow-up sent after the closing snapshot',
    current: ['u', 'r0', 'F', 'r1', 'L*'],
    terminal: ['u', 'r0', 'F', 'r1'],
    provisional: ['h', 'p'],
    start: ['u', 'h'],
    expected: ['u', 'r0', 'F', 'r1', 'L'],
    rows: {
      'follow-up': ['F', 'L'],
      retained: ['u'],
      'streamed provisional': ['p'],
      'client only': ['L', 'h'],
      'earlier run': ['u'],
    },
  },
  {
    name: 'attach on a live cursor, hidden row still on screen',
    current: ['u1', 'r0', 'h~', 'p'],
    terminal: ['u1', 'r0', 'r1'],
    provisional: ['h', 'p'],
    start: ['u1', 'r0', 'h'],
    expected: ['u1', 'r0', 'r1'],
    rows: {
      retained: ['u1', 'r0'],
      'streamed provisional': ['p'],
      'snapshot only': ['r1'],
      'client only': ['h'],
      'earlier run': ['u1', 'r0'],
    },
  },
  {
    name: 'parked and resumed with a snapshot, after a second tab added a turn',
    current: ['u1', 'a1', 'x', 'xa', 't', 'r2', 'A'],
    terminal: ['u1', 'a1', 'x', 'xa', 't', 'r2', 'A', 'r3'],
    provisional: ['p', 'a'],
    start: ['u1', 'a1', 't', 'r2', 'a'],
    expected: ['u1', 'a1', 'x', 'xa', 't', 'r2', 'A', 'r3'],
    rows: {
      retained: ['u1', 'a1', 't', 'r2'],
      'streamed provisional': ['p', 'a'],
      'snapshot only': ['x', 'xa', 'A', 'r3'],
      'earlier run': ['u1', 'a1'],
    },
  },
  {
    name: 'parked and resumed, no snapshot on screen, after a second tab added a turn',
    current: ['u1', 'a1', 't', 'r2', 'A', 'p'],
    terminal: ['u1', 'a1', 'x', 'xa', 't', 'r2', 'A', 'r3'],
    provisional: ['A', 'p'],
    start: ['u1', 'a1', 't', 'r2', 'A'],
    expected: ['u1', 'a1', 'x', 'xa', 't', 'r2', 'A', 'r3'],
    rows: {
      retained: ['u1', 'a1', 't', 'r2', 'A'],
      'streamed provisional': ['p'],
      'snapshot only': ['x', 'xa', 'r3'],
      'earlier run': ['u1', 'a1'],
    },
  },
  {
    name: 'snapshot-opened resume, a follow-up after the row the snapshot added',
    current: ['u', 'x', 'u2', 'r2', 'F', 'r3'],
    terminal: ['u', 'x', 'u2', 'r2', 'F', 'r3'],
    provisional: ['u2', 'r2', 'r3'],
    start: ['u', 'u2'],
    expected: ['u', 'x', 'u2', 'r2', 'F', 'r3'],
    rows: {
      'follow-up': ['F'],
      retained: ['u', 'u2'],
      'streamed provisional': ['r2', 'r3'],
      'snapshot only': ['x'],
      'earlier run': ['u'],
    },
  },
  {
    name: "an earlier run's follow-up stays, the new one moves",
    current: ['u', 'Fa*', 'u2', 'r0', 'Fb*'],
    terminal: ['u', 'Fa', 'u2', 'Fb', 'r0'],
    provisional: ['u2', 'r0'],
    start: ['u', 'Fa', 'u2'],
    expected: ['u', 'Fa', 'u2', 'Fb', 'r0'],
    rows: {
      'follow-up': ['Fa', 'Fb'],
      retained: ['u', 'Fa', 'u2'],
      'streamed provisional': ['r0'],
      'earlier run': ['u', 'Fa'],
    },
  },
];

/** A history of the given rows in order; `*` marks a follow-up, `~` a hidden row. */
function rowsOf(specs: readonly string[]): ConversationHistory {
  let history = createConversationHistory({ id: 'matrix' });
  for (const spec of specs) {
    const id = spec.replace(/[*~]$/, '');
    history = appendMessages(
      history,
      {
        role: /^[arp]/.test(id) ? 'assistant' : 'user',
        content: id,
        ...(spec.endsWith('~') ? { hidden: true } : {}),
      },
      { randomId: () => id },
    );
    if (spec.endsWith('*')) history = markMessageFollowUp(history, id);
  }
  return history;
}

function merge(shape: Shape): {
  current: ConversationHistory;
  terminal: ConversationHistory;
  merged: ConversationHistory;
} {
  const current = rowsOf(shape.current);
  const terminal = rowsOf(shape.terminal);
  return {
    current,
    terminal,
    merged: mergeRunHistory(current, terminal, new Set(shape.provisional), new Set(shape.start)),
  };
}

const cells = MATRIX.flatMap((shape) =>
  KINDS.flatMap((kind) => (shape.rows[kind] ?? []).map((id) => ({ shape, kind, id }))),
);

describe('mergeRunHistory over the outcome matrix', () => {
  test.each(MATRIX)('$name: the thread order', (shape) => {
    expect(merge(shape).merged.ids).toEqual([...shape.expected]);
  });

  test.each(cells)('$shape.name: $kind $id', ({ shape, kind, id }) => {
    const { current, terminal, merged } = merge(shape);
    const named = getOwn(terminal.messages, id) !== undefined;
    const retained = shape.start.includes(id) && named;
    const dropped = shape.provisional.includes(id) && !retained;
    const required = shape.expected.indexOf(id);

    expect(merged.ids.indexOf(id)).toBe(required);
    if (required === -1) {
      // A row the run appended that the terminal does not name is gone, object included.
      expect(dropped).toBe(true);
      expect(getOwn(merged.messages, id)).toBeUndefined();
      return;
    }
    expect(merged.ids.filter((row) => row === id)).toHaveLength(1);
    // Who owns the object: the client for a row on screen at the start, a marked follow-up and a
    // row the terminal omits; the terminal for every other row it names.
    const clientObject = getOwn(current.messages, id);
    const keepsClient =
      retained || !named || (isFollowUpMessage(clientObject) && !shape.provisional.includes(id));
    expect(getOwn(merged.messages, id)).toBe(
      keepsClient ? clientObject! : getOwn(terminal.messages, id)!,
    );
    if (kind === 'follow-up' && isFollowUpMessage(clientObject))
      expect(isFollowUpMessage(getOwn(merged.messages, id))).toBe(true);
  });

  test('every kind appears in the matrix', () => {
    for (const kind of KINDS) expect(cells.some((cell) => cell.kind === kind)).toBe(true);
  });
});
