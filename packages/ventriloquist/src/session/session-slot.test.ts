import { describe, expect, test } from 'bun:test';

import { ManualClock } from './fixtures/manual-clock.ts';
import { createScriptedBackend, type ScriptedBackendOptions } from './fixtures/scripted-backend.ts';
import { createScriptedStream, type ReleaseBehavior } from './fixtures/scripted-sources.ts';
import { SessionSlot } from './session-slot.ts';
import { flush, Recorder, SESSION_ID } from './session.test-support.ts';

const OTHER_ID = '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const THIRD_ID = '3f9a1b2c-5d4e-4f60-8a7b-1c2d3e4f5a6b';

function options(sessionId: string, backend?: ScriptedBackendOptions) {
  return {
    sessionId,
    profile: { profileId: 'shell' },
    dimensions: { columns: 80, rows: 24 },
    clock: new ManualClock(),
    sources: [createScriptedStream('pty').source],
    backend: createScriptedBackend(backend),
  };
}

function request(recorder = new Recorder()) {
  return {
    requestedMode: 'interactive' as const,
    grant: 'interactive' as const,
    listener: recorder.listener,
  };
}

describe('the ownership slot', () => {
  test('reserves itself for one session at a time', () => {
    const slot = new SessionSlot();
    const first = slot.create(options(SESSION_ID));
    expect(first.accepted && slot.current).toBe(first.accepted ? first.session : undefined);
    expect(slot.create(options(OTHER_ID))).toEqual({ accepted: false, reason: 'occupied' });
    expect(slot.current?.sessionId).toBe(SESSION_ID);
  });

  test('stays occupied while the old session is still cleaning up', async () => {
    const slot = new SessionSlot();
    const admission = slot.create(
      options(SESSION_ID, { cleanup: () => new Promise(() => undefined) }),
    );
    if (!admission.accepted) throw new Error('refused');
    void admission.session.dispose();
    await flush();
    expect(admission.session.snapshot.cleanup).toEqual({ kind: 'running' });
    expect(slot.create(options(OTHER_ID))).toEqual({ accepted: false, reason: 'occupied' });
  });

  test('admits a replacement with a new identity once the old cleanup is complete', async () => {
    const slot = new SessionSlot();
    const first = slot.create(options(SESSION_ID));
    if (!first.accepted) throw new Error('refused');
    await first.session.dispose();
    const second = slot.create(options(OTHER_ID));
    expect(second.accepted).toBe(true);
    expect(slot.current?.sessionId).toBe(OTHER_ID);
  });

  test('never accepts an identity it has already used', async () => {
    const slot = new SessionSlot();
    const first = slot.create(options(SESSION_ID));
    if (!first.accepted) throw new Error('refused');
    await first.session.dispose();
    expect(slot.create(options(SESSION_ID))).toEqual({
      accepted: false,
      reason: 'identity-reused',
    });
  });

  test.each(['incomplete', 'unknown'] as const)(
    'a %s cleanup quarantines the slot and nothing in the package clears it',
    async (outcome) => {
      const slot = new SessionSlot();
      const first = slot.create(options(SESSION_ID, { cleanup: () => Promise.resolve(outcome) }));
      if (!first.accepted) throw new Error('refused');
      await first.session.dispose();
      expect(first.session.snapshot.quarantined).toBe(true);
      for (const id of [OTHER_ID, THIRD_ID, SESSION_ID]) {
        expect(slot.create(options(id))).toEqual({ accepted: false, reason: 'quarantined' });
      }
      expect(slot.current).toBe(first.session);
    },
  );

  test('a session that fails validation does not reserve the slot', () => {
    const slot = new SessionSlot();
    expect(() => slot.create({ ...options(SESSION_ID), sessionId: '' })).toThrow(TypeError);
    expect(slot.current).toBeUndefined();
    expect(slot.create(options(SESSION_ID)).accepted).toBe(true);
  });

  test('issues generations that never repeat across sessions', async () => {
    const slot = new SessionSlot();
    const first = slot.create(options(SESSION_ID));
    if (!first.accepted) throw new Error('refused');
    const firstAttach = slot.attach(SESSION_ID, request());
    expect(firstAttach.accepted && firstAttach.attachment.generation).toBe(1);
    await first.session.dispose();
    const second = slot.create(options(OTHER_ID));
    if (!second.accepted) throw new Error('refused');
    const secondAttach = slot.attach(OTHER_ID, request());
    expect(secondAttach.accepted && secondAttach.attachment.generation).toBe(2);
  });

  test('routes an attach to the current identity and calls any other identity stale', async () => {
    const slot = new SessionSlot();
    expect(slot.attach(SESSION_ID, request())).toEqual({
      accepted: false,
      reason: 'stale-session',
    });
    const first = slot.create(options(SESSION_ID));
    if (!first.accepted) throw new Error('refused');
    expect(slot.attach(OTHER_ID, request())).toEqual({ accepted: false, reason: 'stale-session' });
    expect(slot.attach(SESSION_ID, request()).accepted).toBe(true);
    expect(slot.attach(SESSION_ID, request())).toEqual({
      accepted: false,
      reason: 'concurrent-attachment',
    });
    await first.session.dispose();
    const second = slot.create(options(OTHER_ID));
    if (!second.accepted) throw new Error('refused');
    // The retired identity can no longer reach anything.
    expect(slot.attach(SESSION_ID, request())).toEqual({
      accepted: false,
      reason: 'stale-session',
    });
  });
});

describe('a source that cannot be opened during construction', () => {
  /** A slot request whose second source throws on open, after the first has been acquired. */
  function failingOptions(sessionId: string, release: ReleaseBehavior, clock = new ManualClock()) {
    const acquired = createScriptedStream('pty', { cancel: release });
    const locked = {
      kind: 'stream' as const,
      channel: 'stderr' as const,
      stream: {
        getReader: (): never => {
          throw new TypeError('stream is locked');
        },
      },
    };
    return { ...options(sessionId), clock, sources: [acquired.source, locked] };
  }

  test.each(['reject', 'hang'] as const)(
    'quarantines the slot when releasing the sources already acquired %ss',
    async (release) => {
      const clock = new ManualClock();
      const slot = new SessionSlot();
      expect(() => slot.create(failingOptions(SESSION_ID, release, clock))).toThrow(
        'stream is locked',
      );
      await flush();
      // A hanging release has not been observed yet, so the slot is held rather than reusable.
      if (release === 'hang') {
        expect(slot.create(options(OTHER_ID))).toEqual({ accepted: false, reason: 'occupied' });
        clock.advance(5_000);
        await flush();
      }
      expect(slot.create(options(OTHER_ID))).toEqual({ accepted: false, reason: 'quarantined' });
      expect(slot.create(options(THIRD_ID))).toEqual({ accepted: false, reason: 'quarantined' });
      expect(slot.current).toBeUndefined();
    },
  );

  test('admits a replacement once the acquired sources are released completely', async () => {
    const slot = new SessionSlot();
    expect(() => slot.create(failingOptions(SESSION_ID, 'resolve'))).toThrow('stream is locked');
    await flush();
    expect(slot.create(options(OTHER_ID)).accepted).toBe(true);
  });

  test('holds the slot while the release is still in flight', async () => {
    const slot = new SessionSlot();
    expect(() => slot.create(failingOptions(SESSION_ID, 'hang'))).toThrow('stream is locked');
    expect(slot.create(options(OTHER_ID))).toEqual({ accepted: false, reason: 'occupied' });
  });
});
