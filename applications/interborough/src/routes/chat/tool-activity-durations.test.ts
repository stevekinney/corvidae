/**
 * How long each call ran on the rail (COR-2014, rows 16j, 17h, 19x and 20a): read from the times
 * the Bureau recorded, never the page's clock. A finished call's result row records its start and
 * end; a running call counts from its start to the Bureau's now; an interrupted one counts to when
 * its run stopped; a call that waits on a person has none.
 */
import type { ConversationHistory } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import {
  formatCallDuration,
  railCall,
  recordedTiming,
  TOOL_TIMING_METADATA_KEY,
  toolGroups,
  type ToolTimingContext,
} from './tool-activity.ts';

type Row = ConversationHistory['messages'][string];

const at = (time: string) => `2026-11-02T${time}Z`;
const row = (value: Record<string, unknown>): Row =>
  ({
    role: 'assistant',
    content: '',
    metadata: {},
    createdAt: at('16:41:00.000'),
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
    createdAt: at('16:41:00.000'),
    updatedAt: at('16:41:00.000'),
  };
}

const call = (id: string, callId: string, createdAt: string) =>
  row({
    id,
    role: 'tool-call',
    createdAt: at(createdAt),
    toolCall: { id: callId, name: 'lookup-order', arguments: { orderId: '4471' } },
  });
const result = (
  id: string,
  callId: string,
  outcome: string,
  options: { readonly createdAt?: string; readonly timing?: readonly [string, string] } = {},
) =>
  row({
    id,
    role: 'tool-result',
    createdAt: at(options.createdAt ?? '16:41:09.000'),
    metadata:
      options.timing === undefined
        ? {}
        : {
            [TOOL_TIMING_METADATA_KEY]: {
              startedAt: at(options.timing[0]),
              endedAt: at(options.timing[1]),
            },
          },
    toolResult: { callId, outcome, content: '$42.00, delivered Monday, flagged damaged' },
  });

const NOW: ToolTimingContext = { now: Date.parse(at('16:45:01.200')) };

function entriesOf(history: ConversationHistory, options: Parameters<typeof toolGroups>[1] = {}) {
  return [...toolGroups(history, options).groups.values()].flatMap((group) => group.entries);
}

describe('a call’s duration', () => {
  test('is its result row’s recorded start to end, not the gap between its rows', () => {
    const [entry] = entriesOf(
      conversation(
        call('c', 'call-1', '16:41:01.000'),
        result('r', 'call-1', 'success', { timing: ['16:41:05.000', '16:41:05.400'] }),
      ),
      { timing: NOW },
    );
    expect(entry?.durationMilliseconds).toBe(400);
    expect(railCall(entry!, false).duration).toBe('0.4s');
  });

  test('falls back to the gap between the call’s row and its answer’s when no timing was kept', () => {
    const [entry] = entriesOf(
      conversation(
        call('c', 'call-1', '16:41:05.000'),
        result('r', 'call-1', 'error', { createdAt: '16:41:06.500' }),
      ),
      { timing: NOW },
    );
    expect(entry?.state).toBe('failed');
    expect(railCall(entry!, false).duration).toBe('1.5s');
  });

  test('counts a call the page watched answer to the Bureau’s time on its answer, not its row’s page time', () => {
    const [entry] = entriesOf(
      conversation(
        call('c', 'call-1', '16:41:05.000'),
        // The page wrote this row on its own clock, three days on from the Bureau's.
        row({
          id: 'r',
          role: 'tool-result',
          createdAt: '2026-11-05T15:00:00.000Z',
          toolResult: { callId: 'call-1', outcome: 'success', content: '$42.00' },
        }),
      ),
      {
        timing: {
          ...NOW,
          callStarts: new Map([['call-1', Date.parse(at('16:41:05.000'))]]),
          callEnds: new Map([['call-1', Date.parse(at('16:41:05.400'))]]),
        },
      },
    );
    expect(railCall(entry!, false).duration).toBe('0.4s');
  });

  test('gives a call a person denied no duration unless one was recorded', () => {
    const history = conversation(
      call('c', 'call-4', '16:40:00.000'),
      row({
        id: 'r',
        role: 'tool-result',
        createdAt: at('16:40:30.000'),
        toolResult: {
          callId: 'call-4',
          outcome: 'error',
          content: 'Tool call denied: not this one',
        },
      }),
    );
    const [entry] = entriesOf(history, { timing: NOW });
    expect(entry?.state).toBe('denied');
    expect(entry?.durationMilliseconds).toBeUndefined();
  });

  test('counts a running call from when the page watched it start to the Bureau’s now', () => {
    const [entry] = entriesOf(conversation(call('c', 'call-2', '16:45:00.500')), {
      runActive: true,
      timing: { ...NOW, callStarts: new Map([['call-2', Date.parse(at('16:45:00.000'))]]) },
    });
    expect(entry?.state).toBe('running');
    expect(railCall(entry!, false).duration).toBe('1.2s');
  });

  test('counts a running call read from the stored thread from its row’s recorded time', () => {
    const [entry] = entriesOf(conversation(call('c', 'call-2', '16:45:00.000')), {
      runActive: true,
      timing: NOW,
    });
    expect(railCall(entry!, false).duration).toBe('1.2s');
  });

  test('counts an interrupted call to when its run stopped, and leaves it out until that is known', () => {
    const history = conversation(call('c', 'call-1', '16:41:04.000'));
    const [stopped] = entriesOf(history, {
      runActive: false,
      timing: { ...NOW, stoppedAt: Date.parse(at('16:41:05.200')) },
    });
    expect(stopped?.state).toBe('interrupted');
    expect(railCall(stopped!, false)).toMatchObject({ status: 'interrupted', duration: '1.2s' });
    const [unknown] = entriesOf(history, { runActive: false, timing: NOW });
    expect(unknown?.durationMilliseconds).toBeUndefined();
    expect(railCall(unknown!, false).duration).toBeUndefined();
  });

  test('is absent for a call that waits on a person, and for every call without a timing context', () => {
    const history = conversation(
      call('c', 'call-3', '16:41:04.000'),
      result('r', 'call-3', 'action_required', { timing: ['16:41:04.000', '16:41:04.100'] }),
    );
    expect(entriesOf(history, { timing: NOW })[0]?.durationMilliseconds).toBeUndefined();
    const done = conversation(
      call('c', 'call-1', '16:41:01.000'),
      result('r', 'call-1', 'success', { timing: ['16:41:05.000', '16:41:05.400'] }),
    );
    expect(entriesOf(done)[0]?.durationMilliseconds).toBeUndefined();
  });
});

describe('recordedTiming', () => {
  test('reads a start and an end, and refuses times that are missing, unparsed or backwards', () => {
    const timing = (startedAt: unknown, endedAt: unknown) => ({
      [TOOL_TIMING_METADATA_KEY]: { startedAt, endedAt },
    });
    expect(recordedTiming(timing(at('16:41:05.000'), at('16:41:05.400')))).toEqual({
      startedAt: Date.parse(at('16:41:05.000')),
      endedAt: Date.parse(at('16:41:05.400')),
    });
    expect(recordedTiming(timing(at('16:41:05.400'), at('16:41:05.000')))).toBeUndefined();
    expect(recordedTiming(timing('soon', at('16:41:05.000')))).toBeUndefined();
    expect(recordedTiming({})).toBeUndefined();
    expect(recordedTiming(undefined)).toBeUndefined();
  });
});

describe('formatCallDuration', () => {
  test('prints tenths under ten seconds, whole seconds under a minute, then minutes and seconds', () => {
    expect(formatCallDuration(400)).toBe('0.4s');
    expect(formatCallDuration(1_200)).toBe('1.2s');
    expect(formatCallDuration(12_400)).toBe('12s');
    expect(formatCallDuration(65_000)).toBe('1m 5s');
    expect(formatCallDuration(-5)).toBe('0.0s');
  });
});
