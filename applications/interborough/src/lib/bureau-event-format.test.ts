/**
 * `formatBureauEvents` (COR-2227): batches of at most 200, one call each, answers matched to their
 * envelopes by position, and a batch that fails is `null` for its envelopes and never a throw.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { formatBureauEvents, MAXIMUM_EVENTS_PER_FORMAT } from './bureau-event-format.ts';
import type { BureauEventFrame } from './live-source/bureau-event-frame.ts';
import { installFetchImplementation } from './live-source/fetch.test-support.ts';

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

interface FormatCall {
  readonly events: readonly { kind: string; bureauId: string; payload: unknown; source?: string }[];
}

/** Answers `bureau.deployment.get` and `bureau.events.format`; `answer` decides each format call. */
function stubBureau(answer: (call: FormatCall, index: number) => Response): FormatCall[] {
  const calls: FormatCall[] = [];
  restoreFetch = installFetchImplementation(async (_input, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      method?: string;
      params?: FormatCall;
    };
    if (body.method === 'bureau.deployment.get') {
      return Response.json({ jsonrpc: '2.0', id: 'x', result: { id: 'bureau-1' } });
    }
    const call = body.params ?? { events: [] };
    calls.push(call);
    return answer(call, calls.length - 1);
  });
  return calls;
}

function envelope(index: number, extra: Partial<BureauEventFrame> = {}): BureauEventFrame {
  return {
    kind: 'run.settled',
    sequence: index,
    cursor: `c:${String(index)}`,
    emittedAtMs: index,
    payload: { runId: `run-${String(index)}` },
    ...extra,
  };
}

const worded = (call: FormatCall) =>
  Response.json({
    jsonrpc: '2.0',
    id: 'x',
    result: {
      events: call.events.map((event) => ({
        kind: event.kind,
        title: `Worded ${event.kind}`,
        tier: 'info',
      })),
    },
  });

describe('formatBureauEvents', () => {
  test('sends at most 200 events a call, in order, and matches the answers by position', async () => {
    const calls = stubBureau(worded);
    const envelopes = Array.from({ length: MAXIMUM_EVENTS_PER_FORMAT * 2 + 50 }, (_, index) =>
      envelope(index, { kind: `kind.${String(index)}` }),
    );
    const answers = await formatBureauEvents(envelopes);
    expect(calls.map((call) => call.events.length)).toEqual([200, 200, 50]);
    expect(answers).toHaveLength(envelopes.length);
    expect(answers[0]?.title).toBe('Worded kind.0');
    expect(answers.at(-1)?.title).toBe(`Worded kind.${String(envelopes.length - 1)}`);
    expect(calls[0]?.events[0]?.bureauId).toBe('bureau-1');
  });

  test('sends a frame’s payload, null when it carried none, and the plugin that caused it', async () => {
    const calls = stubBureau(worded);
    await formatBureauEvents([envelope(1, { payload: undefined, source: 'github' }), envelope(2)]);
    const sent = calls[0]?.events ?? [];
    expect(sent[0]).toEqual({
      kind: 'run.settled',
      bureauId: 'bureau-1',
      emittedAtMs: 1,
      payload: null,
      source: 'github',
    } as never);
    expect(sent[1]?.payload).toEqual({ runId: 'run-2' });
    expect(Object.hasOwn(sent[1] ?? {}, 'source')).toBe(false);
  });

  test('a batch whose call fails is null for its envelopes, and the batches that answered stay worded', async () => {
    stubBureau((call, index) =>
      index === 1
        ? Response.json({ jsonrpc: '2.0', id: 'x', error: { code: -32000, message: 'down' } })
        : worded(call),
    );
    const envelopes = Array.from({ length: MAXIMUM_EVENTS_PER_FORMAT + 3 }, (_, index) =>
      envelope(index),
    );
    const answers = await formatBureauEvents(envelopes);
    expect(answers.slice(0, MAXIMUM_EVENTS_PER_FORMAT).every((answer) => answer !== null)).toBe(
      true,
    );
    expect(answers.slice(MAXIMUM_EVENTS_PER_FORMAT)).toEqual([null, null, null]);
  });

  test('an answer that does not hold one entry per envelope is null for the whole batch', async () => {
    stubBureau(() =>
      Response.json({
        jsonrpc: '2.0',
        id: 'x',
        result: { events: [{ kind: 'run.settled', title: 'Only one', tier: 'info' }] },
      }),
    );
    expect(await formatBureauEvents([envelope(1), envelope(2)])).toEqual([null, null]);
  });

  test('nothing to format makes no call', async () => {
    const calls = stubBureau(worded);
    expect(await formatBureauEvents([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
