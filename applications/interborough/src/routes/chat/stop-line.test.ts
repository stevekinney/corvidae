/**
 * The status line under a reply that stopped: what it says is keyed to the tool the run was in the
 * middle of, so a refund cannot be said to have changed nothing.
 */
import {
  CINDER_NOTES_METADATA_KEY,
  resolveMessageNotes,
  type ConversationHistory,
} from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import {
  causeOf,
  failedStopNoteId,
  interruptedTool,
  stopSentence,
  subjectOf,
  withStopLine,
} from './stop-line.ts';
import type { ToolInfo } from './tool-activity.ts';

type Row = ConversationHistory['messages'][string];

const row = (value: Record<string, unknown>): Row =>
  ({
    role: 'assistant',
    content: '',
    hidden: false,
    metadata: {},
    createdAt: '2026-11-02T16:42:00.000Z',
    ...value,
  }) as Row;

function conversation(...rows: Row[]): ConversationHistory {
  return {
    schemaVersion: 4,
    id: 't',
    status: 'active',
    metadata: {},
    ids: rows.map((entry) => entry.id),
    messages: Object.fromEntries(rows.map((entry) => [entry.id, entry])),
    createdAt: '2026-11-02T16:00:00.000Z',
    updatedAt: '2026-11-02T16:00:00.000Z',
  };
}

const tools = new Map<string, ToolInfo>([
  ['lookup-order', { title: 'Lookup order', tier: 'read-only' }],
  ['issue-refund', { title: 'Issue refund', tier: 'dangerous' }],
]);

const calling = (name: string) =>
  conversation(
    row({ id: 'u1', role: 'user', content: 'Please refund order 4471' }),
    row({
      id: 's0',
      role: 'tool-call',
      toolCall: { id: 'c1', name, arguments: { orderId: 4471 } },
    }),
  );

/** `history` with `extra` after its last row. */
function appendLast(history: ConversationHistory, extra: Row): ConversationHistory {
  return {
    ...history,
    ids: [...history.ids, extra.id],
    messages: { ...history.messages, [extra.id]: extra },
  };
}

const FAILED = {
  kind: 'stopped',
  id: 'stopped',
  failed: true,
  reason: 'The model provider dropped the connection.',
} as const;

describe('the cause of a stop', () => {
  test('is lower case with no full stop, and an acronym keeps its capitals', () => {
    expect(causeOf('The model provider dropped the connection.')).toBe(
      'the model provider dropped the connection',
    );
    expect(causeOf('HTTP 429: too many requests')).toBe('HTTP 429: too many requests');
    expect(causeOf('  Budget exceeded  ')).toBe('budget exceeded');
  });
});

describe('the sentence', () => {
  test('a reply that stopped with no call under way stopped partway', () => {
    expect(stopSentence('The model provider dropped the connection.')).toBe(
      'The reply stopped partway: the model provider dropped the connection.',
    );
  });

  test('a call that only reads did not finish, and nothing was changed', () => {
    expect(
      stopSentence('The model provider dropped the connection.', {
        name: 'Lookup order',
        tier: 'read-only',
        subject: 'order',
      }),
    ).toBe(
      'The reply stopped while Lookup order was running: the model provider dropped the connection. Lookup order didn’t finish and nothing was changed.',
    );
  });

  test('a call that changes things may have run, goes back through the approval, and never says nothing was changed', () => {
    for (const tier of ['mutating', 'dangerous', null] as const) {
      const line = stopSentence('The model provider dropped the connection.', {
        name: 'Issue refund',
        tier,
        subject: undefined,
      });
      expect(line).toContain('Issue refund may have run. Check the result before retrying.');
      expect(line).toContain('Retry goes back through the approval.');
      expect(line.toLowerCase()).not.toContain('nothing was changed');
    }
  });
});

describe('the call a run was interrupted on', () => {
  test('is the last call with no answer, named for a person, with what it acted on', () => {
    expect(interruptedTool(calling('issue-refund'), tools)).toEqual({
      name: 'Issue refund',
      tier: 'dangerous',
      subject: 'order',
    });
  });

  test('says which thing to check when the call names it, and "result" when it does not', () => {
    const line = (interrupted: Parameters<typeof stopSentence>[1]) =>
      stopSentence('The model provider dropped the connection.', interrupted);
    const changing = { name: 'Issue refund', tier: 'dangerous', subject: 'order' } as const;

    expect(line(changing)).toBe(
      'The reply stopped while Issue refund was running: the model provider dropped the connection. Issue refund may have run. Check the order before retrying. Retry goes back through the approval.',
    );
    expect(line({ ...changing, subject: undefined })).toContain(
      'Check the result before retrying.',
    );
  });

  test('is none when every call was answered', () => {
    const answered = conversation(
      row({
        id: 's0',
        role: 'tool-call',
        toolCall: { id: 'c1', name: 'lookup-order', arguments: {} },
      }),
      row({
        id: 's0:r',
        role: 'tool-result',
        toolResult: { callId: 'c1', outcome: 'success', content: 'ok' },
      }),
    );
    expect(interruptedTool(answered, tools)).toBeUndefined();
  });
});

describe('the stop note on the transcript', () => {
  const noted = (base: ConversationHistory, rowId: string) => ({
    ...base,
    messages: {
      ...base.messages,
      [rowId]: {
        ...base.messages[rowId]!,
        metadata: { [CINDER_NOTES_METADATA_KEY]: [FAILED] },
      },
    },
  });

  test('a stored failed note is worded from the call it stopped on', () => {
    const reworded = withStopLine(noted(calling('issue-refund'), 's0'), { tools });
    const note = resolveMessageNotes(reworded.messages['s0']!)?.[0];
    expect(note).toMatchObject({ kind: 'stopped', failed: true });
    expect(note?.kind === 'stopped' && note.reason).toContain('Issue refund may have run.');
    expect(failedStopNoteId(reworded)).toBe('stopped');
  });

  test('rewords the failed note and leaves the notes beside it as they were', () => {
    const base = calling('issue-refund');
    const beside = { kind: 'stopped', id: 'earlier', reason: 'Stopped.' };
    const mixed = {
      ...base,
      messages: {
        ...base.messages,
        s0: {
          ...base.messages['s0']!,
          metadata: { [CINDER_NOTES_METADATA_KEY]: [beside, FAILED] },
        },
      },
    };
    const notes = resolveMessageNotes(withStopLine(mixed, { tools }).messages['s0']!);
    expect(notes?.[0]).toMatchObject(beside);
    expect(notes?.[1]?.kind === 'stopped' && notes[1].reason).toContain(
      'Issue refund may have run.',
    );
  });

  test('a stop the person asked for stays the plain line it was', () => {
    const base = calling('issue-refund');
    const plain = {
      ...base,
      messages: {
        ...base.messages,
        s0: {
          ...base.messages['s0']!,
          metadata: {
            [CINDER_NOTES_METADATA_KEY]: [{ kind: 'stopped', id: 'stopped', reason: 'Stopped.' }],
          },
        },
      },
    };
    expect(withStopLine(plain, { tools })).toBe(plain);
    expect(failedStopNoteId(plain)).toBeUndefined();
  });

  test('a transcript with no failed stop note is the very transcript it was', () => {
    const base = calling('issue-refund');
    expect(withStopLine(base, { tools })).toBe(base);
  });
});

describe('the lines of a failed attempt Retry kept (B06, row 20b)', () => {
  const failedOn = (runId: string) => ({ ...FAILED, id: `stopped:${runId}` });
  /** Two turns that each stopped: the first on a refund, the second on a lookup. */
  const twoAttempts = () => {
    const base = conversation(
      row({ id: 'u1', role: 'user', content: 'Please refund order 4471' }),
      row({
        id: 's0',
        role: 'tool-call',
        toolCall: { id: 'c1', name: 'issue-refund', arguments: {} },
      }),
      row({ id: 'u2', role: 'user', content: 'Please refund order 4471' }),
      row({
        id: 's1',
        role: 'tool-call',
        toolCall: { id: 'c2', name: 'lookup-order', arguments: {} },
      }),
    );
    const noted = (history: ConversationHistory, rowId: string, runId: string) => ({
      ...history,
      messages: {
        ...history.messages,
        [rowId]: {
          ...history.messages[rowId]!,
          metadata: { [CINDER_NOTES_METADATA_KEY]: [failedOn(runId)] },
        },
      },
    });
    return noted(noted(base, 's0', 'run-1'), 's1', 'run-2');
  };

  test('each line is worded from its own turn’s call', () => {
    const reworded = withStopLine(twoAttempts(), { tools });
    const first = resolveMessageNotes(reworded.messages['s0']!)?.[0];
    const second = resolveMessageNotes(reworded.messages['s1']!)?.[0];
    expect(first?.kind === 'stopped' && first.reason).toContain('Issue refund may have run.');
    expect(second?.kind === 'stopped' && second.reason).toContain(
      'Lookup order didn’t finish and nothing was changed.',
    );
  });

  test('only the last turn’s line is the one Retry is offered beside', () => {
    expect(failedStopNoteId(twoAttempts())).toBe('stopped:run-2');
    const answered = appendLast(twoAttempts(), row({ id: 'u3', role: 'user', content: 'Thanks' }));
    expect(failedStopNoteId(answered)).toBeUndefined();
  });

  test('the interrupted tool of the last turn is never an earlier turn’s', () => {
    const base = twoAttempts();
    const settled = appendLast(
      base,
      row({
        id: 's1:r',
        role: 'tool-result',
        toolResult: { callId: 'c2', outcome: 'success', content: {} },
      }),
    );
    expect(interruptedTool(settled, tools)).toBeUndefined();
  });
});

describe('what a call acted on', () => {
  test('is the noun before the identifier word of an argument name, in any casing', () => {
    expect(subjectOf({ orderId: 4471 })).toBe('order');
    expect(subjectOf({ order_id: 4471 })).toBe('order');
    expect(subjectOf({ 'order-id': 4471 })).toBe('order');
    expect(subjectOf({ amount: 5, customerAccountId: 'c1' })).toBe('customer account');
    expect(subjectOf({ orderID: 4471 })).toBe('order');
  });

  test('is nothing for arguments that name no thing, or that are not a record', () => {
    expect(subjectOf({ id: 'x', amount: 5, valid: true })).toBeUndefined();
    expect(subjectOf({ identity: 'x' })).toBeUndefined();
    expect(subjectOf('orderId')).toBeUndefined();
    expect(subjectOf(null)).toBeUndefined();
    expect(subjectOf([{ orderId: 1 }])).toBeUndefined();
  });
});
