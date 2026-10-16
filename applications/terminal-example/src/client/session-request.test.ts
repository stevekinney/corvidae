import { describe, expect, test } from 'bun:test';

import {
  describeRefusal,
  requestSession,
  requestSlotStatus,
  waitForFreeSlot,
  type SessionRefusal,
} from './session-request.ts';

type Call = { input: string; init: RequestInit | undefined };

function respond(...answers: Response[]) {
  const calls: Call[] = [];
  const queue = [...answers];
  const fetcher = (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve((next as Response).clone());
  };
  return { fetcher, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('requestSession', () => {
  test('sends a profile and a mode and nothing else, with the cookie the browser holds', async () => {
    const { fetcher, calls } = respond(json(201, { sessionId: 'id', ticket: 'ticket' }));
    const outcome = await requestSession('fullscreen', true, fetcher);
    expect(outcome).toEqual({ ok: true, grant: { sessionId: 'id', ticket: 'ticket' } });
    expect(calls[0]?.input).toBe('/session');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      profile: 'fullscreen',
      readOnly: true,
    });
  });

  test.each([
    [401, { kind: 'signed-out' }],
    [409, { kind: 'busy' }],
    [423, { kind: 'quarantined' }],
    [503, { kind: 'unavailable' }],
    [500, { kind: 'failed', status: 500 }],
  ] as const)('turns a %p answer into a refusal', async (status, refusal) => {
    const { fetcher } = respond(json(status, {}));
    expect(await requestSession('shell', false, fetcher)).toEqual({ ok: false, refusal });
  });
});

describe('the slot', () => {
  test('is read from the status route', async () => {
    const { fetcher, calls } = respond(json(200, { slot: 'busy' }));
    expect(await requestSlotStatus(fetcher)).toBe('busy');
    expect(calls[0]?.input).toBe('/session/status');
  });

  test('reports a lost cookie and refuses to guess at a failed request', async () => {
    expect(await requestSlotStatus(respond(json(401, {})).fetcher)).toBe('signed-out');
    const failure = await requestSlotStatus(respond(json(500, {})).fetcher).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('500');
  });

  test('is polled until it is free', async () => {
    const { fetcher, calls } = respond(
      json(200, { slot: 'busy' }),
      json(200, { slot: 'busy' }),
      json(200, { slot: 'free' }),
    );
    const pauses: number[] = [];
    expect(
      await waitForFreeSlot(fetcher, (milliseconds) => {
        pauses.push(milliseconds);
        return Promise.resolve();
      }),
    ).toBe('free');
    expect(calls).toHaveLength(3);
    expect(pauses).toEqual([250, 250]);
  });

  test('is polled only so long, and a quarantined slot ends the wait', async () => {
    const stuck = respond(json(200, { slot: 'busy' }));
    expect(await waitForFreeSlot(stuck.fetcher, () => Promise.resolve())).toBe('busy');
    expect(stuck.calls).toHaveLength(60);
    const quarantined = respond(json(200, { slot: 'quarantined' }));
    expect(await waitForFreeSlot(quarantined.fetcher, () => Promise.resolve())).toBe('quarantined');
    expect(quarantined.calls).toHaveLength(1);
  });
});

describe('describeRefusal', () => {
  test('says something a person can act on, and names no command, path or token', () => {
    const refusals: SessionRefusal[] = [
      { kind: 'signed-out' },
      { kind: 'busy' },
      { kind: 'quarantined' },
      { kind: 'unavailable' },
      { kind: 'failed', status: 500 },
    ];
    for (const refusal of refusals) {
      const message = describeRefusal(refusal);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/\/bin|ticket|cookie=|argument/i);
    }
    expect(describeRefusal({ kind: 'failed', status: 500 })).toContain('500');
  });
});
