/**
 * AB-200 — durable steering.
 *
 * The restart boundary is a genuine one: two independently constructed
 * `Mailbox` instances over the same reopened SQLite backend, with the
 * first disposed before the second opens. No sleeps and no real process
 * kill — the durability being tested is the storage backend's, and
 * reopening it is exactly what a restart does to it.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, resolveStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { ImplementedSteeringCommand } from './steering';
import {
  acquireSteeringLease,
  createSteeringMailbox,
  deleteSteeringSessionState,
  loadSteeringCommandRecord,
  loadSteeringDesiredState,
  persistSteeringCommand,
  persistSteeringDesiredState,
  recoverSteeringCommands,
  reserveSteeringCommandRecord,
  STEERING_LEASE_TTL_MS,
  type PersistedSteeringCommand,
  type SteeringLease,
  writeSteeringCommandRecord,
} from './steering-durability';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { throwingRejectionOf } from './testing/promise-outcome.test-support.ts';

function steeringCommand(
  overrides: Partial<ImplementedSteeringCommand> = {},
): ImplementedSteeringCommand {
  return {
    id: 'cmd-1',
    idOrigin: 'caller',
    sessionId: 'session-1',
    principal: 'alice',
    requestedValue: { target: 'model', override: 'claude-sonnet-5' },
    requestedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('durable steering', () => {
  it('recovers an admitted command across a restart of the storage backend', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storageBefore = await resolveStorage(fixture.configuration);
      const mailboxBefore = createSteeringMailbox(storageBefore, 'session-1', 'incarnation-1');
      const persisted = await persistSteeringCommand(mailboxBefore, steeringCommand());
      expect(persisted.persisted).toBe(true);
      mailboxBefore.dispose();
      storageBefore[Symbol.dispose]();

      // Restart: a second backend handle over the same path, and a
      // mailbox that shares nothing in memory with the first.
      const storageAfter = await resolveStorage(fixture.configuration);
      const mailboxAfter = createSteeringMailbox(storageAfter, 'session-1', 'incarnation-1');
      const recovered: PersistedSteeringCommand[] = [];
      await recoverSteeringCommands(mailboxAfter, (command) => recovered.push(command));

      // The full reconstructed record, not a spot-check of some fields:
      // optional fields the command never carried must stay absent rather
      // than being reconstructed as placeholders.
      expect(recovered).toEqual([
        {
          id: 'cmd-1',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
          requestedAt: '2026-09-19T00:00:00.000Z',
        },
      ]);

      mailboxAfter.dispose();
      storageAfter[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });

  it('preserves FIFO order across a restart, so the last value wins', async () => {
    // Replaying a later model change before an earlier one would leave
    // the wrong value in force, which is the whole reason order matters.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storageBefore = await resolveStorage(fixture.configuration);
      const mailboxBefore = createSteeringMailbox(storageBefore, 'session-1', 'incarnation-1');
      await persistSteeringCommand(
        mailboxBefore,
        steeringCommand({ id: 'cmd-1', requestedValue: { target: 'model', override: 'first' } }),
      );
      await persistSteeringCommand(
        mailboxBefore,
        steeringCommand({ id: 'cmd-2', requestedValue: { target: 'model', override: 'second' } }),
      );
      mailboxBefore.dispose();
      storageBefore[Symbol.dispose]();

      const storageAfter = await resolveStorage(fixture.configuration);
      const mailboxAfter = createSteeringMailbox(storageAfter, 'session-1', 'incarnation-1');
      const recovered: PersistedSteeringCommand[] = [];
      await recoverSteeringCommands(mailboxAfter, (command) => recovered.push(command));

      expect(recovered).toEqual([
        {
          id: 'cmd-1',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'first' },
          requestedAt: '2026-09-19T00:00:00.000Z',
        },
        {
          id: 'cmd-2',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'second' },
          requestedAt: '2026-09-19T00:00:00.000Z',
        },
      ]);

      mailboxAfter.dispose();
      storageAfter[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });

  it('does not duplicate a command when the same id is persisted twice', async () => {
    // The idempotency key is the caller-facing command id, so an exact
    // retry replays the original receipt instead of creating a second
    // command that a restart would then apply twice.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storage = await resolveStorage(fixture.configuration);
      const mailbox = createSteeringMailbox(storage, 'session-1', 'incarnation-1');
      const first = await persistSteeringCommand(mailbox, steeringCommand());
      const second = await persistSteeringCommand(mailbox, steeringCommand());

      expect(first.persisted && second.persisted).toBe(true);
      if (first.persisted && second.persisted) {
        expect(second.commandId).toBe(first.commandId);
      }

      const recovered: PersistedSteeringCommand[] = [];
      await recoverSteeringCommands(mailbox, (command) => recovered.push(command));
      expect(recovered).toEqual([
        {
          id: 'cmd-1',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
          requestedAt: '2026-09-19T00:00:00.000Z',
        },
      ]);

      mailbox.dispose();
      storage[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });

  it('drains the log, so a second recovery pass finds nothing', async () => {
    // Recovery consumes: acknowledging each command is what stops a
    // restart from re-applying the same steering forever.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storage = await resolveStorage(fixture.configuration);
      const mailbox = createSteeringMailbox(storage, 'session-1', 'incarnation-1');
      await persistSteeringCommand(mailbox, steeringCommand());

      expect(await recoverSteeringCommands(mailbox, () => {})).toBe(1);
      expect(await recoverSteeringCommands(mailbox, () => {})).toBe(0);

      mailbox.dispose();
      storage[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps separate sessions in separate mailboxes', async () => {
    // FIFO order is meaningful within a session and meaningless across
    // unrelated ones, so one session's log must never recover another's.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storage = await resolveStorage(fixture.configuration);
      const first = createSteeringMailbox(storage, 'session-1', 'incarnation-1');
      const second = createSteeringMailbox(storage, 'session-2', 'incarnation-1');
      await persistSteeringCommand(first, steeringCommand({ sessionId: 'session-1' }));

      expect(await recoverSteeringCommands(second, () => {})).toBe(0);
      expect(await recoverSteeringCommands(first, () => {})).toBe(1);

      first.dispose();
      second.dispose();
      storage[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });
});

describe('durable steering with nothing to reconstruct', () => {
  it('reports an empty mailbox as empty and recovers nothing', async () => {
    // The empty case, as this file already defines it: `claim()` answers
    // `{ status: 'empty' }` and recovery neither applies nor counts anything.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storage = await resolveStorage(fixture.configuration);
      const mailbox = createSteeringMailbox(storage, 'session-1', 'incarnation-1');
      const recovered: PersistedSteeringCommand[] = [];

      expect(await mailbox.claim()).toEqual({ status: 'empty' });
      expect(await recoverSteeringCommands(mailbox, (command) => recovered.push(command))).toBe(0);
      expect(recovered).toEqual([]);
      expect(await mailbox.list()).toEqual([]);

      mailbox.dispose();
      storage[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });

  it('is empty again after a drained recovery, across a restart', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storageBefore = await resolveStorage(fixture.configuration);
      const mailboxBefore = createSteeringMailbox(storageBefore, 'session-1', 'incarnation-1');
      await persistSteeringCommand(mailboxBefore, steeringCommand());
      expect(await recoverSteeringCommands(mailboxBefore, () => {})).toBe(1);
      mailboxBefore.dispose();
      storageBefore[Symbol.dispose]();

      const storageAfter = await resolveStorage(fixture.configuration);
      const mailboxAfter = createSteeringMailbox(storageAfter, 'session-1', 'incarnation-1');
      const recovered: PersistedSteeringCommand[] = [];
      expect(await mailboxAfter.claim()).toEqual({ status: 'empty' });
      expect(await recoverSteeringCommands(mailboxAfter, (c) => recovered.push(c))).toBe(0);
      expect(recovered).toEqual([]);

      mailboxAfter.dispose();
      storageAfter[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });
});

describe('durable steering crash safety', () => {
  it('leaves a command recoverable when the replay throws before acknowledgement', async () => {
    // The defect this pins: an earlier version acknowledged every command
    // as it drained and let the caller admit the batch afterwards, so a
    // crash between the two lost the command from both sides at once —
    // durably forgotten, never applied. Apply now runs per command,
    // before its acknowledgement, so a failure leaves the command
    // claimed; its lease expires and the next pass replays it.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storage = await resolveStorage(fixture.configuration);
      const mailbox = createSteeringMailbox(storage, 'session-1', 'incarnation-1');
      const persisted = await persistSteeringCommand(mailbox, steeringCommand());
      if (!persisted.persisted) throw new Error('expected the command to persist');

      expect(
        await throwingRejectionOf(
          recoverSteeringCommands(mailbox, () => {
            throw new Error('replay failed');
          }),
        ),
      ).toThrow('replay failed');

      // Not acknowledged, so still durably present. The receipt is
      // still `claimed` (its lease has not expired, so a second `claim()`
      // sees nothing claimable) rather than gone — the record survived the
      // failed replay, which is the whole guarantee.
      const receipts = await mailbox.list();
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.commandId).toBe(persisted.commandId);
      expect(receipts[0]?.state).toBe('claimed');
      expect(await mailbox.claim()).toEqual({ status: 'empty' });

      mailbox.dispose();
      storage[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });
});

describe('steering leases, command records, and desired-state snapshots', () => {
  const command = {
    id: 'cmd-1',
    sessionId: 'session-1',
    principal: 'alice',
    requestedValue: { target: 'model', override: 'claude-sonnet-5' },
    runId: undefined,
    requestedRunId: undefined,
    requestedAt: '2026-09-02T00:00:00.000Z',
    deadline: undefined,
    configVersion: 1,
    state: 'accepted',
    failure: undefined,
  } as const;

  async function leaseFor(
    kv: ReturnType<typeof textValueStore>,
    sessionId = 'session-1',
    incarnation = 'incarnation-1',
  ): Promise<SteeringLease> {
    const acquired = await acquireSteeringLease(kv, sessionId, incarnation, {
      owner: 'bureau-a',
      token: 'token-a',
      nowMs: 1_000,
      held: undefined,
    });
    if (!acquired.acquired) throw new Error('expected the lease');
    return acquired.lease;
  }

  it('refuses another owner while a lease is live, and hands it over once it expires', async () => {
    const kv = textValueStore(new MemoryStorage());
    const lease = await leaseFor(kv);

    const renewed = await acquireSteeringLease(kv, 'session-1', 'incarnation-1', {
      owner: 'bureau-a',
      token: 'token-a',
      nowMs: 2_000,
      held: lease,
    });
    expect(renewed).toMatchObject({ acquired: true, continuous: true });

    const refused = await acquireSteeringLease(kv, 'session-1', 'incarnation-1', {
      owner: 'bureau-b',
      token: 'token-b',
      nowMs: 3_000,
      held: undefined,
    });
    expect(refused.acquired).toBe(false);

    const takenOver = await acquireSteeringLease(kv, 'session-1', 'incarnation-1', {
      owner: 'bureau-b',
      token: 'token-b',
      nowMs: 2_000 + STEERING_LEASE_TTL_MS + 1,
      held: undefined,
    });
    expect(takenOver).toMatchObject({ acquired: true, continuous: false });
  });

  it('fences every write on the lease, so a superseded owner can no longer write', async () => {
    const kv = textValueStore(new MemoryStorage());
    const stale = await leaseFor(kv);
    const current = await acquireSteeringLease(kv, 'session-1', 'incarnation-1', {
      owner: 'bureau-b',
      token: 'token-b',
      nowMs: 1_000 + STEERING_LEASE_TTL_MS + 1,
      held: undefined,
    });
    if (!current.acquired) throw new Error('expected the takeover');

    expect(await reserveSteeringCommandRecord(kv, stale, 'incarnation-1', command)).toEqual({
      status: 'fence-lost',
    });
    expect(
      await persistSteeringDesiredState(kv, stale, 'session-1', 'incarnation-1', {
        mailboxSequence: 1,
        state: {
          rawConfigVersion: 1,
          effectiveConfigVersion: 1,
          lastConfigurationVersion: 1,
          lastIdentityVersion: 0,
          configuration: {},
        },
      }),
    ).toBe('fence-lost');
    expect(await loadSteeringDesiredState(kv, 'session-1', 'incarnation-1')).toBeUndefined();
  });

  it('reserves a key once, reporting the existing record to a second reservation', async () => {
    const kv = textValueStore(new MemoryStorage());
    const lease = await leaseFor(kv);

    expect(await reserveSteeringCommandRecord(kv, lease, 'incarnation-1', command)).toEqual({
      status: 'reserved',
    });
    const second = await reserveSteeringCommandRecord(kv, lease, 'incarnation-1', {
      ...command,
      requestedValue: { target: 'provider', override: 'anthropic' },
    });
    expect(second.status).toBe('exists');
    if (second.status !== 'exists') throw new Error('expected exists');
    expect(second.record.phase).toBe('reserved');
    expect(second.record.command.requestedValue).toEqual(command.requestedValue);

    expect(
      await writeSteeringCommandRecord(kv, lease, {
        phase: 'admitted',
        incarnation: 'incarnation-1',
        command: { ...command, state: 'superseded' },
      }),
    ).toBe('committed');
    const loaded = await loadSteeringCommandRecord(kv, 'alice', 'cmd-1');
    expect(loaded?.phase).toBe('admitted');
    expect(loaded?.command.state).toBe('superseded');
  });

  it('refuses to read a malformed snapshot as absent', async () => {
    const kv = textValueStore(new MemoryStorage());
    const lease = await leaseFor(kv);
    await persistSteeringDesiredState(kv, lease, 'session-1', 'incarnation-1', {
      mailboxSequence: 2,
      state: {
        rawConfigVersion: 2,
        effectiveConfigVersion: 2,
        lastConfigurationVersion: 2,
        lastIdentityVersion: 0,
        configuration: { model: 'claude-sonnet-5' },
      },
    });
    const keys = await kv.list('steering-desired-state:');
    expect(keys).toHaveLength(1);
    await kv.set(keys[0] ?? '', '{not json');

    await expect(loadSteeringDesiredState(kv, 'session-1', 'incarnation-1')).rejects.toThrow(
      /malformed/,
    );
  });

  it('deletes only the named incarnation, never a recreated session under the same id', async () => {
    const kv = textValueStore(new MemoryStorage());
    const oldLease = await leaseFor(kv, 'session-1', 'incarnation-1');
    const newLease = await leaseFor(kv, 'session-1', 'incarnation-2');
    await reserveSteeringCommandRecord(kv, oldLease, 'incarnation-1', command);
    await reserveSteeringCommandRecord(kv, newLease, 'incarnation-2', {
      ...command,
      id: 'cmd-2',
    });
    const state = {
      rawConfigVersion: 1,
      effectiveConfigVersion: 1,
      lastConfigurationVersion: 1,
      lastIdentityVersion: 0,
      configuration: { model: 'claude-sonnet-5' },
    };
    await persistSteeringDesiredState(kv, oldLease, 'session-1', 'incarnation-1', {
      mailboxSequence: 1,
      state,
    });
    await persistSteeringDesiredState(kv, newLease, 'session-1', 'incarnation-2', {
      mailboxSequence: 1,
      state,
    });

    await deleteSteeringSessionState(kv, 'session-1', 'incarnation-1');

    expect(await loadSteeringCommandRecord(kv, 'alice', 'cmd-1')).toBeUndefined();
    expect(await loadSteeringDesiredState(kv, 'session-1', 'incarnation-1')).toBeUndefined();
    const survivor = await loadSteeringCommandRecord(kv, 'alice', 'cmd-2');
    expect(survivor?.incarnation).toBe('incarnation-2');
    expect(await loadSteeringDesiredState(kv, 'session-1', 'incarnation-2')).toEqual({
      mailboxSequence: 1,
      state,
    });
  });

  it('hands each recovered command its mailbox sequence, in FIFO order', async () => {
    const storage = new MemoryStorage();
    const mailbox = createSteeringMailbox(storage, 'session-1', 'incarnation-1');
    const first = await persistSteeringCommand(mailbox, steeringCommand({ id: 'a' }));
    const second = await persistSteeringCommand(mailbox, steeringCommand({ id: 'b' }));
    if (!first.persisted || !second.persisted) throw new Error('expected both persisted');

    const seen: [string, number][] = [];
    await recoverSteeringCommands(mailbox, (command, sequence) => {
      seen.push([command.id, sequence]);
    });

    expect(seen).toEqual([
      ['a', first.sequence],
      ['b', second.sequence],
    ]);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    mailbox.dispose();
  });
});
