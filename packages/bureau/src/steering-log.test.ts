import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { ImplementedSteeringCommand } from './steering';
import {
  appendSteeringLogEvent,
  deleteSteeringLog,
  readSteeringKeyBinding,
  readSteeringLogEntries,
  readSteeringLogHead,
  SteeringLogCorruptError,
  type SteeringLogEvent,
  listSteeringLogIncarnations,
  steeringSessionRunTag,
} from './steering-log';

function command(overrides: Partial<ImplementedSteeringCommand> = {}): ImplementedSteeringCommand {
  return {
    id: 'cmd-1',
    idOrigin: 'caller',
    sessionId: 'session-1',
    principal: 'alice',
    requestedValue: { target: 'model', override: 'claude-sonnet-5' },
    requestedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function admit(overrides: Partial<ImplementedSteeringCommand> = {}): SteeringLogEvent {
  return {
    type: 'admit',
    command: command(overrides),
    liveRunIds: ['run-1'],
    now: '2026-09-02T00:00:01.000Z',
  };
}

const applied: SteeringLogEvent = {
  type: 'applied',
  runId: 'run-1',
  configVersion: 1,
  now: '2026-09-02T00:00:02.000Z',
};

describe('steering log', () => {
  it('appends in order and reads back exactly what was appended', async () => {
    const kv = textValueStore(new MemoryStorage());
    const empty = await readSteeringLogHead(kv, 'session-1', 'inc-1');
    expect(empty).toEqual({ raw: null, sequence: 0 });

    const first = await appendSteeringLogEvent(kv, 'session-1', 'inc-1', empty, admit());
    if (first.status !== 'appended') throw new Error('expected appended');
    const second = await appendSteeringLogEvent(kv, 'session-1', 'inc-1', first.head, applied);
    if (second.status !== 'appended') throw new Error('expected appended');

    const head = await readSteeringLogHead(kv, 'session-1', 'inc-1');
    expect(head).toEqual(second.head);
    expect(await readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, head.sequence)).toEqual([
      admit(),
      applied,
    ]);
    expect(await readSteeringLogEntries(kv, 'session-1', 'inc-1', 1, head.sequence)).toEqual([
      applied,
    ]);
    const bound = await readSteeringKeyBinding(kv, 'alice', 'cmd-1');
    expect(bound?.binding).toEqual({
      sessionId: 'session-1',
      incarnation: 'inc-1',
      sequence: 1,
    });
  });

  it('refuses an append decided against a stale head', async () => {
    const kv = textValueStore(new MemoryStorage());
    const empty = await readSteeringLogHead(kv, 'session-1', 'inc-1');
    await appendSteeringLogEvent(kv, 'session-1', 'inc-1', empty, applied);

    expect(await appendSteeringLogEvent(kv, 'session-1', 'inc-1', empty, admit())).toEqual({
      status: 'head-moved',
    });
    expect(await readSteeringKeyBinding(kv, 'alice', 'cmd-1')).toBeUndefined();
  });

  it('refuses to bind a key another session already bound', async () => {
    const kv = textValueStore(new MemoryStorage());
    await appendSteeringLogEvent(
      kv,
      'session-1',
      'inc-1',
      await readSteeringLogHead(kv, 'session-1', 'inc-1'),
      admit(),
    );

    const elsewhere = await readSteeringLogHead(kv, 'session-2', 'inc-1');
    expect(
      await appendSteeringLogEvent(
        kv,
        'session-2',
        'inc-1',
        elsewhere,
        admit({ sessionId: 'session-2' }),
      ),
    ).toEqual({ status: 'key-taken' });
    expect(await readSteeringLogHead(kv, 'session-2', 'inc-1')).toEqual(elsewhere);
  });

  it('fails closed on a malformed head, entry, or key binding', async () => {
    const kv = textValueStore(new MemoryStorage());
    await appendSteeringLogEvent(
      kv,
      'session-1',
      'inc-1',
      await readSteeringLogHead(kv, 'session-1', 'inc-1'),
      admit(),
    );
    const [headKey] = await kv.list('steering-log:v1:session-1:inc-1:head');
    const [entryKey] = await kv.list('steering-log:v1:session-1:inc-1:entry:');
    const [bindingKey] = await kv.list('steering-key:v1:');
    if (headKey === undefined || entryKey === undefined || bindingKey === undefined) {
      throw new Error('expected the head, an entry, and a binding');
    }

    await kv.set(entryKey, JSON.stringify({ ...admit(), command: { id: 'cmd-1' } }));
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    await kv.delete(entryKey);
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(/missing/);

    await kv.set(entryKey, JSON.stringify({ ...applied, configVersion: 1.5 }));
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    await kv.set(
      entryKey,
      JSON.stringify(admit({ requestedValue: { target: 'effort', override: 'turbo' } as never })),
    );
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    const refused = (failure: Record<string, unknown>) =>
      JSON.stringify({
        type: 'refused',
        command: command(),
        outcome: { outcome: 'rejected', failure },
        now: '2026-09-02T00:00:01.000Z',
      });
    for (const failure of [
      { failedAt: '2026-09-02T00:00:01.000Z', reason: 'superseded-by' },
      { failedAt: '2026-09-02T00:00:01.000Z', reason: 'no-such-reason' },
      { failedAt: '2026-09-02T00:00:01.000Z', reason: 'policy-denied', supersededBy: 'x' },
      // Well-formed, but never a refusal Bureau decides before the gate.
      { failedAt: '2026-09-02T00:00:01.000Z', reason: 'run-terminal' },
      { failedAt: '2026-09-02T00:00:01.000Z', reason: 'deadline-passed' },
    ]) {
      await kv.set(entryKey, refused(failure));
      await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
        SteeringLogCorruptError,
      );
    }
    await kv.set(
      entryKey,
      JSON.stringify({
        type: 'refused',
        command: command(),
        outcome: { outcome: 'unsupported-capability', reason: 'anything-else' },
        now: '2026-09-02T00:00:01.000Z',
      }),
    );
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    // A run control is decided by the gate, never refused before it.
    await kv.set(
      entryKey,
      JSON.stringify({
        type: 'refused',
        command: command({ requestedValue: { target: 'pause' } }),
        outcome: {
          outcome: 'rejected',
          failure: { failedAt: '2026-09-02T00:00:01.000Z', reason: 'policy-denied' },
        },
        now: '2026-09-02T00:00:01.000Z',
      }),
    );
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    // The selector refusal belongs to an identity selector, nothing else.
    await kv.set(
      entryKey,
      JSON.stringify({
        type: 'refused',
        command: command(),
        outcome: { outcome: 'unsupported-capability', reason: 'selector-unavailable' },
        now: '2026-09-02T00:00:01.000Z',
      }),
    );
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    await kv.set(
      entryKey,
      JSON.stringify(admit({ requestedValue: { target: 'pause', override: 'x' } as never })),
    );
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    await kv.set(
      entryKey,
      JSON.stringify({
        ...admit(),
        submittedValue: { target: 'provider', policyRef: 'fast-tier' },
      }),
    );
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    await kv.set(entryKey, JSON.stringify({ ...admit(), liveRunIds: ['run-1', 'run-1'] }));
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    // An admitted command is always concrete: a selector is resolved before
    // admission, or refused before the gate.
    await kv.set(
      entryKey,
      JSON.stringify(admit({ requestedValue: { target: 'model', policyRef: 'fast-tier' } })),
    );
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    await kv.set(entryKey, JSON.stringify(admit({ requestedAt: 'not a timestamp' })));
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    // An entry deciding a command for another session is not this log's.
    await kv.set(entryKey, JSON.stringify(admit({ sessionId: 'session-2' })));
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    await kv.set(
      entryKey,
      JSON.stringify({
        type: 'refused',
        command: command({ sessionId: 'session-2' }),
        outcome: { outcome: 'unsupported-capability', reason: 'selector-unavailable' },
        now: '2026-09-02T00:00:01.000Z',
      }),
    );
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
    await kv.set(entryKey, JSON.stringify({ ...admit(), now: 'not a timestamp' }));
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );

    await kv.set(headKey, '{"sequence":"1"}');
    await expect(readSteeringLogHead(kv, 'session-1', 'inc-1')).rejects.toThrow(
      SteeringLogCorruptError,
    );

    for (const sequence of [0, -1, 1.5]) {
      await kv.set(
        bindingKey,
        JSON.stringify({ sessionId: 'session-1', incarnation: 'inc-1', sequence }),
      );
      await expect(readSteeringKeyBinding(kv, 'alice', 'cmd-1')).rejects.toThrow(
        SteeringLogCorruptError,
      );
    }
    await kv.set(bindingKey, 'not json');
    await expect(readSteeringKeyBinding(kv, 'alice', 'cmd-1')).rejects.toThrow(
      SteeringLogCorruptError,
    );
  });

  it('tags each session incarnation distinctly, whatever its parts contain', () => {
    expect(steeringSessionRunTag('a', 'b\nc')).not.toBe(steeringSessionRunTag('a\nb', 'c'));
    expect(steeringSessionRunTag('session', 'incarnation')).toBe(
      steeringSessionRunTag('session', 'incarnation'),
    );
  });

  it('reads a refusal back with the selector it was resolved from', async () => {
    const kv = textValueStore(new MemoryStorage());
    const refused: SteeringLogEvent = {
      type: 'refused',
      command: command(),
      outcome: {
        outcome: 'rejected',
        failure: { failedAt: '2026-09-02T00:00:01.000Z', reason: 'policy-denied' },
      },
      now: '2026-09-02T00:00:01.000Z',
      submittedValue: { target: 'model', policyRef: 'fast-tier' },
    };
    const head = await readSteeringLogHead(kv, 'session-1', 'inc-1');
    await appendSteeringLogEvent(kv, 'session-1', 'inc-1', head, refused);
    expect(await readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).toEqual([refused]);

    // A selector for another target is not this refusal's.
    const logKeys = await kv.list('steering-log:v1:');
    const entryKey = logKeys.find((key) => key.includes(':entry:'));
    if (entryKey === undefined) throw new Error('expected an entry');
    await kv.set(
      entryKey,
      JSON.stringify({
        ...refused,
        submittedValue: { target: 'provider', policyRef: 'fast-tier' },
      }),
    );
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );

    // A concrete value is not a selector: retrying it must not replay a
    // decision made for a different concrete value.
    await kv.set(
      entryKey,
      JSON.stringify({
        ...refused,
        submittedValue: { target: 'model', override: 'claude-opus-4-8' },
      }),
    );
    await expect(readSteeringLogEntries(kv, 'session-1', 'inc-1', 0, 1)).rejects.toThrow(
      SteeringLogCorruptError,
    );
  });

  it('lists every decodable log incarnation, skipping a key no encoder wrote', async () => {
    const kv = textValueStore(new MemoryStorage());
    await kv.set('steering-log:v1:%E0%A4%A:inc-0:head', '{"sequence":1}');
    for (const sessionId of ['session-1', 'session-2']) {
      const head = await readSteeringLogHead(kv, sessionId, 'inc-1');
      await appendSteeringLogEvent(
        kv,
        sessionId,
        'inc-1',
        head,
        admit({ sessionId, id: sessionId }),
      );
    }
    const listed = await listSteeringLogIncarnations(kv);
    expect(listed.toSorted((left, right) => left.sessionId.localeCompare(right.sessionId))).toEqual(
      [
        { sessionId: 'session-1', incarnation: 'inc-1' },
        { sessionId: 'session-2', incarnation: 'inc-1' },
      ],
    );
  });

  it('deletes only its own incarnation, and never a key another log has since rebound', async () => {
    const kv = textValueStore(new MemoryStorage());
    const old = await appendSteeringLogEvent(
      kv,
      'session-1',
      'inc-1',
      await readSteeringLogHead(kv, 'session-1', 'inc-1'),
      admit(),
    );
    if (old.status !== 'appended') throw new Error('expected appended');
    await appendSteeringLogEvent(kv, 'session-1', 'inc-1', old.head, admit({ id: 'cmd-rebound' }));
    // The recreated session rebinds `cmd-rebound` (replacing the stale
    // binding) before the old incarnation's cleanup runs.
    const stale = await readSteeringKeyBinding(kv, 'alice', 'cmd-rebound');
    await appendSteeringLogEvent(
      kv,
      'session-1',
      'inc-2',
      await readSteeringLogHead(kv, 'session-1', 'inc-2'),
      admit({ id: 'cmd-rebound' }),
      stale?.raw ?? null,
    );

    await deleteSteeringLog(kv, 'session-1', 'inc-1');

    expect(await readSteeringLogHead(kv, 'session-1', 'inc-1')).toEqual({ raw: null, sequence: 0 });
    expect(await readSteeringKeyBinding(kv, 'alice', 'cmd-1')).toBeUndefined();
    const rebound = await readSteeringKeyBinding(kv, 'alice', 'cmd-rebound');
    expect(rebound?.binding.incarnation).toBe('inc-2');
    const newHead = await readSteeringLogHead(kv, 'session-1', 'inc-2');
    expect(newHead.sequence).toBe(1);
  });
});
