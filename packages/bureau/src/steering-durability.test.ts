/**
 * AB-200 — durable steering.
 *
 * The restart boundary is a genuine one: two independently constructed
 * `Mailbox` instances over the same reopened SQLite backend, with the
 * first disposed before the second opens. No sleeps and no real process
 * kill — the durability being tested is the storage backend's, and
 * reopening it is exactly what a restart does to it.
 */
import { createManualRuntimeServices } from '@corvidae/lifecycle';
import { resolveStorage } from '@corvidae/weft';
import { describe, expect, it } from 'bun:test';

import type { ImplementedSteeringCommand } from './steering';
import {
  createSteeringMailbox,
  persistSteeringCommand,
  recoverSteeringCommands,
} from './steering-durability';
import { createSqliteStorageFixture } from './test/storage-fixtures';

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
  } as ImplementedSteeringCommand;
}

describe('durable steering', () => {
  it('recovers an admitted command across a restart of the storage backend', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storageBefore = await resolveStorage(fixture.configuration);
      const mailboxBefore = createSteeringMailbox(storageBefore, 'session-1');
      const persisted = await persistSteeringCommand(mailboxBefore, steeringCommand());
      expect(persisted.persisted).toBe(true);
      mailboxBefore.dispose();
      storageBefore[Symbol.dispose]();

      // Restart: a second backend handle over the same path, and a
      // mailbox that shares nothing in memory with the first.
      const storageAfter = await resolveStorage(fixture.configuration);
      const mailboxAfter = createSteeringMailbox(storageAfter, 'session-1');
      const recovered = await recoverSteeringCommands(mailboxAfter);

      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.id).toBe('cmd-1');
      expect(recovered[0]?.principal).toBe('alice');
      expect(recovered[0]?.requestedValue).toEqual({
        target: 'model',
        override: 'claude-sonnet-5',
      });

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
      const mailboxBefore = createSteeringMailbox(storageBefore, 'session-1');
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
      const mailboxAfter = createSteeringMailbox(storageAfter, 'session-1');
      const recovered = await recoverSteeringCommands(mailboxAfter);

      expect(recovered.map((command) => command.id)).toEqual(['cmd-1', 'cmd-2']);

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
      const mailbox = createSteeringMailbox(storage, 'session-1');
      const first = await persistSteeringCommand(mailbox, steeringCommand());
      const second = await persistSteeringCommand(mailbox, steeringCommand());

      expect(first.persisted && second.persisted).toBe(true);
      if (first.persisted && second.persisted) {
        expect(second.commandId).toBe(first.commandId);
      }

      const recovered = await recoverSteeringCommands(mailbox);
      expect(recovered).toHaveLength(1);

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
      const mailbox = createSteeringMailbox(storage, 'session-1');
      await persistSteeringCommand(mailbox, steeringCommand());

      expect(await recoverSteeringCommands(mailbox)).toHaveLength(1);
      expect(await recoverSteeringCommands(mailbox)).toHaveLength(0);

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
      const first = createSteeringMailbox(storage, 'session-1');
      const second = createSteeringMailbox(storage, 'session-2');
      await persistSteeringCommand(first, steeringCommand({ sessionId: 'session-1' }));

      expect(await recoverSteeringCommands(second)).toHaveLength(0);
      expect(await recoverSteeringCommands(first)).toHaveLength(1);

      first.dispose();
      second.dispose();
      storage[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });
});
