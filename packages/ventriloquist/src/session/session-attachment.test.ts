import { describe, expect, test } from 'bun:test';

import { ManualClock } from './fixtures/manual-clock.ts';
import { createScriptedBackend } from './fixtures/scripted-backend.ts';
import { createScriptedSubscription } from './fixtures/scripted-sources.ts';
import type { SessionOptions } from './session-types.ts';
import {
  createHarness,
  expectAttached,
  flush,
  Recorder,
  SESSION_ID,
  startAndAttach,
  utf8,
} from './session.test-support.ts';
import { Session } from './session.ts';

function optionsFor(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    sessionId: SESSION_ID,
    profile: { profileId: 'shell' },
    dimensions: { columns: 80, rows: 24 },
    clock: new ManualClock(),
    sources: [],
    ...overrides,
  };
}

describe('creating a session', () => {
  test('requires an identity and a profile', () => {
    expect(() => new Session(optionsFor({ sessionId: '' }))).toThrow(TypeError);
    expect(() => new Session(optionsFor({ profile: { profileId: '' } }))).toThrow(TypeError);
  });

  test.each([
    [0, 24],
    [80, 0],
    [65_536, 24],
    [80, 1.5],
    [Number.NaN, 24],
  ])('refuses the unvalidated geometry %j by %j', (columns, rows) => {
    expect(() => new Session(optionsFor({ dimensions: { columns, rows } }))).toThrow(RangeError);
  });

  test('refuses a budget outside its documented range', () => {
    expect(() => new Session(optionsFor({ budgets: { inputQueueBytes: 0 } }))).toThrow(RangeError);
  });

  test('snapshots an immutable copy of the profile and dimensions', () => {
    const profile = { profileId: 'shell' };
    const dimensions = { columns: 80, rows: 24 };
    const session = new Session(optionsFor({ profile, dimensions }));
    profile.profileId = 'tampered';
    dimensions.columns = 1;
    expect(session.profile).toEqual({ profileId: 'shell' });
    expect(session.dimensions).toEqual({ columns: 80, rows: 24 });
    expect(Object.isFrozen(session.profile)).toBe(true);
    expect(Object.isFrozen(session.dimensions)).toBe(true);
  });

  test('starts with every state axis separate and nothing owned by a view', () => {
    const { session } = createHarness();
    expect(session.snapshot).toEqual({
      sessionIdentity: SESSION_ID,
      process: { kind: 'starting' },
      connection: { kind: 'detached' },
      cleanup: { kind: 'idle' },
      quarantined: false,
      closed: false,
      ownership: { process: 'owned', sources: ['owned'], view: 'unbound' },
    });
  });

  test('states ownership of the process, each source and the view explicitly', () => {
    const subscription = createScriptedSubscription();
    const outputOnly = createHarness({ backend: false, sources: [subscription.source] });
    expect(outputOnly.session.snapshot.ownership).toEqual({
      process: 'none',
      sources: ['borrowed'],
      view: 'unbound',
    });
    expectAttached(
      outputOnly.session.attach({
        requestedMode: 'read-only',
        grant: 'read-only',
        listener: outputOnly.recorder.listener,
      }),
    );
    expect(outputOnly.session.snapshot.ownership.view).toBe('bound');
  });
});

describe('attachment authority is derived on the server', () => {
  test('an interactive PTY grant can write, resize and stop', () => {
    const { session, recorder } = createHarness();
    const result = session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: recorder.listener,
    });
    expect(result.accepted && result.authority).toEqual({
      generation: 1,
      canWrite: true,
      capabilities: { mode: 'pty', input: true, resize: true, kill: true, readOnly: false },
    });
    expect(session.snapshot.connection).toEqual({ kind: 'attached', generation: 1 });
  });

  test('a pipe has no terminal to resize', () => {
    const { session, recorder } = createHarness({ backend: { mode: 'pipe' } });
    const result = session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: recorder.listener,
    });
    expect(result.accepted && result.authority.capabilities).toEqual({
      mode: 'pipe',
      input: true,
      resize: false,
      kill: true,
      readOnly: false,
    });
  });

  test('a pipe opened without stdin advertises no input and refuses it as unsupported', () => {
    const session = new Session(
      optionsFor({ backend: { ...createScriptedBackend({ mode: 'pipe' }), acceptsInput: false } }),
    );
    const result = session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: () => undefined,
    });
    expect(result.accepted && result.authority).toEqual({
      generation: 1,
      canWrite: false,
      capabilities: { mode: 'pipe', input: false, resize: false, kill: true, readOnly: false },
    });
    const attachment = expectAttached(result);
    expect(attachment.write(utf8('x'))).toEqual({
      disposition: 'failed',
      sequence: 1,
      reason: 'unsupported',
    });
  });

  test.each([
    ['a read-only grant', 'interactive', 'read-only'],
    ['a read-only request', 'read-only', 'interactive'],
  ] as const)('%s can only narrow what the session offers', (_name, requestedMode, grant) => {
    const { session, recorder } = createHarness();
    const result = session.attach({ requestedMode, grant, listener: recorder.listener });
    expect(result.accepted && result.authority).toEqual({
      generation: 1,
      canWrite: false,
      capabilities: { mode: 'pty', input: false, resize: false, kill: false, readOnly: true },
    });
  });

  test('an output-only session is read-only whatever the client or host asks for', () => {
    const { session, recorder } = createHarness({ backend: false });
    const result = session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: recorder.listener,
    });
    expect(result.accepted && result.authority.capabilities).toEqual({
      mode: 'output-only',
      input: false,
      resize: false,
      kill: false,
      readOnly: true,
    });
  });

  test('a backend without resize offers no resize on a PTY either', () => {
    const backend = createScriptedBackend({ mode: 'pty' });
    const { resize: _resize, ...withoutResize } = backend;
    const session = new Session(optionsFor({ backend: withoutResize }));
    const result = session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: () => undefined,
    });
    expect(result.accepted && result.authority.capabilities.resize).toBe(false);
  });

  test('issues the generation the host supplies and never reuses one', () => {
    let next = 6;
    const first = createHarness({ issueGeneration: () => next++ });
    const second = createHarness({ issueGeneration: () => next++ });
    const request = (recorder: Recorder) => ({
      requestedMode: 'interactive' as const,
      grant: 'interactive' as const,
      listener: recorder.listener,
    });
    expect(expectAttached(first.session.attach(request(first.recorder))).generation).toBe(6);
    expect(expectAttached(second.session.attach(request(second.recorder))).generation).toBe(7);
  });
});

describe('a second or stale attachment is refused immediately', () => {
  test('a concurrent attachment is rejected without disturbing the current one', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    const second = harness.session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: () => undefined,
    });
    expect(second).toEqual({ accepted: false, reason: 'concurrent-attachment' });
    expect(harness.session.snapshot.connection).toEqual({ kind: 'attached', generation: 1 });
    expect(attachment.write(utf8('still works'))).toEqual({ disposition: 'accepted', sequence: 1 });
    expect(harness.recorder.events).toEqual([]);
  });

  test('presenting a generation to resume is refused, because v1 never resumes or replays', async () => {
    const harness = createHarness();
    await startAndAttach(harness);
    expect(
      harness.session.attach({
        requestedMode: 'interactive',
        grant: 'interactive',
        listener: () => undefined,
        resumeGeneration: 1,
      }),
    ).toEqual({ accepted: false, reason: 'stale-generation' });
    expect(harness.session.snapshot.connection).toEqual({ kind: 'attached', generation: 1 });
  });

  test('a session that is closing or closed takes no attachment', async () => {
    const harness = createHarness();
    await startAndAttach(harness);
    const closing = harness.session.dispose();
    const request = {
      requestedMode: 'interactive' as const,
      grant: 'interactive' as const,
      listener: () => undefined,
    };
    expect(harness.session.attach(request)).toEqual({ accepted: false, reason: 'session-closed' });
    await closing;
    expect(harness.session.attach(request)).toEqual({ accepted: false, reason: 'session-closed' });
  });

  test('a quarantined session reports why, not just that it is closed', async () => {
    const harness = createHarness({ backend: { cleanup: () => Promise.resolve('incomplete') } });
    await startAndAttach(harness);
    await harness.session.dispose();
    expect(harness.session.snapshot.quarantined).toBe(true);
    expect(
      harness.session.attach({
        requestedMode: 'interactive',
        grant: 'interactive',
        listener: () => undefined,
      }),
    ).toEqual({ accepted: false, reason: 'quarantined' });
  });
});

describe('a read-only attachment has no write path at all', () => {
  test('refuses input, terminal replies, resize and stop, and the process sees none of it', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness, 'read-only');
    expect(attachment.write(utf8('ls'), { sequence: 3 })).toEqual({
      disposition: 'failed',
      sequence: 3,
      reason: 'read-only',
    });
    expect(attachment.reply(utf8('\u001b[0n'))).toEqual({
      disposition: 'failed',
      sequence: 1,
      reason: 'read-only',
    });
    expect(attachment.resize(100, 40)).toEqual({
      disposition: 'failed',
      sequence: 2,
      reason: 'read-only',
    });
    expect(attachment.stop()).toEqual({ accepted: false, reason: 'read-only' });
    await flush();
    expect(harness.backend?.calls).toEqual([{ call: 'start' }]);
    expect(harness.session.snapshot.connection).toEqual({ kind: 'attached', generation: 1 });
    expect(harness.session.snapshot.cleanup).toEqual({ kind: 'idle' });
  });

  test('an interactive client that asked for read-only is held to read-only', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness, 'interactive', 'read-only');
    expect(attachment.write(utf8('rm'))).toMatchObject({
      disposition: 'failed',
      reason: 'read-only',
    });
  });

  test('an attachment with the capability missing but not read-only names it unsupported', async () => {
    const harness = createHarness({ backend: { mode: 'pipe' } });
    const attachment = await startAndAttach(harness);
    expect(attachment.resize(100, 40)).toMatchObject({
      disposition: 'failed',
      reason: 'unsupported',
    });
  });
});

describe('starting the process', () => {
  test('input is disabled until the process is running', async () => {
    const harness = createHarness();
    const attachment = expectAttached(
      harness.session.attach({
        requestedMode: 'interactive',
        grant: 'interactive',
        listener: harness.recorder.listener,
      }),
    );
    expect(attachment.write(utf8('early'))).toMatchObject({
      disposition: 'failed',
      reason: 'input-disabled',
    });
    await harness.session.start();
    expect(harness.session.snapshot.process).toEqual({ kind: 'running' });
    expect(attachment.write(utf8('now'))).toMatchObject({ disposition: 'accepted' });
  });

  test('start is idempotent and launches the backend once', async () => {
    const harness = createHarness();
    const first = harness.session.start();
    expect(harness.session.start()).toBe(first);
    await first;
    expect(harness.backend?.calls.filter((call) => call.call === 'start')).toHaveLength(1);
  });

  test('a session with no backend is running at once', async () => {
    const harness = createHarness({ backend: false });
    await harness.session.start();
    expect(harness.session.snapshot.process).toEqual({ kind: 'running' });
  });
});
