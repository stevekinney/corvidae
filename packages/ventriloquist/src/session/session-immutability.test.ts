import { describe, expect, test } from 'bun:test';

import { createHarness, expectAttached, flush } from './session.test-support.ts';

/** Assign through a cast, the way a careless or hostile consumer would. A frozen object throws; either way the caller sees the effect. */
function tamper(mutation: () => void): void {
  try {
    mutation();
  } catch {
    // A frozen object refuses the write, which is the behavior under test.
  }
}

describe('a snapshot is a copy', () => {
  test('mutating the exposed process state cannot enable input on a session that is still starting', async () => {
    const harness = createHarness();
    const attachment = expectAttached(
      harness.session.attach({
        requestedMode: 'interactive',
        grant: 'interactive',
        listener: harness.recorder.listener,
      }),
    );
    const { process } = harness.session.snapshot;
    tamper(() => {
      (process as { kind: string }).kind = 'running';
    });
    expect(harness.session.snapshot.process).toEqual({ kind: 'starting' });
    expect(attachment.write(Uint8Array.of(1))).toMatchObject({
      disposition: 'failed',
      reason: 'input-disabled',
    });
    expect(harness.backend?.calls).toEqual([]);
  });

  test('the connection, cleanup, ownership and sources are frozen too', () => {
    const { session } = createHarness();
    const snapshot = session.snapshot;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.process)).toBe(true);
    expect(Object.isFrozen(snapshot.connection)).toBe(true);
    expect(Object.isFrozen(snapshot.cleanup)).toBe(true);
    expect(Object.isFrozen(snapshot.ownership)).toBe(true);
    expect(Object.isFrozen(snapshot.ownership.sources)).toBe(true);
  });

  test('the process state in the closing summary is a copy', async () => {
    const harness = createHarness();
    void harness.session.start();
    await flush();
    const summary = await harness.session.dispose();
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.process)).toBe(true);
    expect(Object.isFrozen(summary.drain)).toBe(true);
  });
});

describe('authority is a copy', () => {
  test('mutating the exposed capabilities cannot enable writes on a read-only grant', async () => {
    const harness = createHarness();
    const attachment = expectAttached(
      harness.session.attach({
        requestedMode: 'interactive',
        grant: 'read-only',
        listener: harness.recorder.listener,
      }),
    );
    void harness.session.start();
    await flush();
    const { authority } = attachment;
    tamper(() => {
      (authority.capabilities as { input: boolean }).input = true;
    });
    tamper(() => {
      (authority.capabilities as { resize: boolean }).resize = true;
    });
    tamper(() => {
      (authority.capabilities as { readOnly: boolean }).readOnly = false;
    });
    tamper(() => {
      (authority as { canWrite: boolean }).canWrite = true;
    });
    expect(attachment.write(Uint8Array.of(1))).toMatchObject({ reason: 'read-only' });
    expect(attachment.resize(100, 40)).toMatchObject({ reason: 'read-only' });
    expect(attachment.stop()).toEqual({ accepted: false, reason: 'read-only' });
    expect(harness.backend?.calls).toEqual([{ call: 'start' }]);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.capabilities)).toBe(true);
  });

  test('the authority returned from attach is the one the handle carries, and both are frozen', () => {
    const harness = createHarness();
    const result = harness.session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: harness.recorder.listener,
    });
    if (!result.accepted) throw new Error('refused');
    expect(Object.isFrozen(result.authority)).toBe(true);
    expect(result.attachment.authority).toBe(result.authority);
  });
});
