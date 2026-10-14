/**
 * AB-200 — durable steering survives a real process kill.
 *
 * `steering-durability.test.ts` reaches its restart boundary by disposing
 * a backend cleanly and reopening it. That proves a record survives an
 * orderly shutdown, which is the common case but not the interesting one:
 * a write buffered until `dispose()` flushed it would pass that test and
 * still lose the command in a genuine crash.
 *
 * This test removes the orderly shutdown. A child process admits a
 * steering command through the public `submitSteeringCommand` verb and
 * then SIGKILLs itself — no exit handler, no `dispose()`, no flush. The
 * parent then opens the same SQLite path and asserts the command is
 * recoverable, so whatever it finds was on disk before the process died.
 *
 * No sleeps in the parent: it waits on process exit and on the child's
 * own marker file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveStorage } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';

import type { PersistedSteeringCommand } from './steering-durability';
import { createSteeringMailbox, recoverSteeringCommands } from './steering-durability';

const CHILD = join(import.meta.dir, 'test', 'steering-crash-child.ts');

/** Runs the crash child to its own SIGKILL and returns the marker it wrote. */
async function runCrashingChild(args: readonly string[], markerPath: string): Promise<unknown> {
  const child = Bun.spawn(['bun', CHILD, ...args], { stdout: 'pipe', stderr: 'pipe' });
  await child.exited;
  const stderr = await new Response(child.stderr).text();
  expect(child.signalCode ?? stderr).toBe('SIGKILL');
  expect(existsSync(markerPath)).toBe(true);
  return JSON.parse(readFileSync(markerPath, 'utf8'));
}

describe('durable steering survives SIGKILL', () => {
  it('recovers a command admitted by a process that was killed without disposing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-crash-'));
    const storagePath = join(directory, 'bureau.sqlite');
    const markerPath = join(directory, 'admitted.json');

    try {
      const child = Bun.spawn(['bun', CHILD, storagePath, markerPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await child.exited;

      const stderr = await new Response(child.stderr).text();
      // The child kills itself, so a clean exit code 0 would mean it
      // returned normally instead — which would invalidate the whole
      // premise of the test rather than merely fail an assertion.
      expect(child.signalCode ?? stderr).toBe('SIGKILL');
      expect(existsSync(markerPath)).toBe(true);

      const { sessionId } = JSON.parse(readFileSync(markerPath, 'utf8')) as {
        sessionId: string;
      };

      // Fresh handle on the same backend, in this process. Nothing is
      // shared with the dead one but the bytes it left on disk.
      const storage = await resolveStorage({ type: 'sqlite', path: storagePath });
      const mailbox = createSteeringMailbox(storage, sessionId);
      const recovered: PersistedSteeringCommand[] = [];
      await recoverSteeringCommands(mailbox, (command) => recovered.push(command));

      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.id).toBe('crash-cmd-1');
      expect(recovered[0]?.principal).toBe('alice');
      expect(recovered[0]?.requestedValue).toEqual({ target: 'pause' });

      mailbox.dispose();
      storage[Symbol.dispose]();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('still reports a reused id with a different value as a conflict after the mailbox was drained by an earlier restart', async () => {
    // Repeated crashes. The first leaves `crash-cmd-2` (a model override) in the
    // mailbox. The second process retries it exactly, which replays and
    // acknowledges it, then dies too. A session-scoped target is used
    // because it needs no live run to replay into. This third process therefore starts with a drained
    // mailbox and an empty in-memory ledger, while the mailbox's idempotency
    // binding for `crash-cmd-1` survives. Reusing the id with a different
    // target must still be a typed conflict, never a fresh acceptance.
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-crash-twice-'));
    const storagePath = join(directory, 'bureau.sqlite');

    try {
      const admitted = join(directory, 'admitted.json');
      const { sessionId } = (await runCrashingChild(
        [storagePath, admitted, 'admit', 'model'],
        admitted,
      )) as { sessionId: string };
      const retried = join(directory, 'retried.json');
      const retry = (await runCrashingChild(
        [storagePath, retried, 'retry', 'model', sessionId],
        retried,
      )) as { outcomes: { outcome: string }[] };
      expect(retry.outcomes.map(({ outcome }) => outcome)).toEqual(['replayed']);
      // A third crash, this time starting from an already-drained mailbox:
      // the exact retry must still replay rather than be admitted afresh.
      const retriedAgain = join(directory, 'retried-again.json');
      const retryAgain = (await runCrashingChild(
        [storagePath, retriedAgain, 'retry', 'model', sessionId],
        retriedAgain,
      )) as { outcomes: { outcome: string }[] };
      expect(retryAgain.outcomes.map(({ outcome }) => outcome)).toEqual(['replayed']);

      const bureau = await createBureau({
        agents: {},
        generate: () => new Promise<never>(() => {}),
        toolbox: createToolbox([]),
        storage: { type: 'sqlite', path: storagePath },
        durableExecution: true,
      });
      try {
        await bureau.waitForRecovery?.();
        const outcome = await bureau.submitSteeringCommand(sessionId, {
          id: 'crash-cmd-2',
          principal: 'alice',
          requestedValue: { target: 'provider', override: 'anthropic' },
        });

        expect(outcome.outcome).toBe('conflict');
        if (outcome.outcome !== 'conflict') throw new Error('expected conflict');
        expect(outcome.conflict.reason).toBe('target-mismatch');
        expect(outcome.conflict.original.requestedValue).toEqual({
          target: 'model',
          override: 'claude-sonnet-5',
        });

        // The idempotency key is bureau-wide, so the same key sent to a
        // different session is a `session-mismatch`, even though that
        // session's own mailbox has never seen it.
        const other = await bureau.createRun({ message: 'Wait forever', principal: 'alice' });
        const elsewhere = await bureau.submitSteeringCommand(other.sessionId, {
          id: 'crash-cmd-2',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        });
        expect(elsewhere.outcome).toBe('conflict');
        if (elsewhere.outcome !== 'conflict') throw new Error('expected conflict');
        expect(elsewhere.conflict.reason).toBe('session-mismatch');
      } finally {
        await bureau.dispose();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps desired configuration and its configVersion across restarts after the mailbox is drained', async () => {
    // The first process steers the model twice (configVersion 1, then 2)
    // and dies. The second restores, replays nothing it already reflects,
    // and dies too. Desired state must survive both, at the same version
    // the first process reported: a restore that also re-applied the
    // drained commands would report 4, and no restore at all would fall
    // back to the default model at version 0.
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-desired-'));
    const storagePath = join(directory, 'bureau.sqlite');

    try {
      const admitted = join(directory, 'admitted.json');
      const first = (await runCrashingChild(
        [storagePath, admitted, 'admit', 'opus,model'],
        admitted,
      )) as { sessionId: string; outcomes: { command: { configVersion: number } }[] };
      expect(first.outcomes.map(({ command }) => command.configVersion)).toEqual([1, 2]);
      const { sessionId } = first;

      // A fresh id re-requesting the desired value is accepted without
      // advancing configVersion, which is how these assertions observe
      // both the restored value and the restored version.
      const probed = join(directory, 'probed.json');
      const probe = (await runCrashingChild(
        [storagePath, probed, 'retry', 'probe', sessionId],
        probed,
      )) as { outcomes: { outcome: string; command: { configVersion: number } }[] };
      expect(probe.outcomes[0]?.outcome).toBe('accepted');
      expect(probe.outcomes[0]?.command.configVersion).toBe(2);

      const bureau = await createBureau({
        agents: {},
        generate: () => new Promise<never>(() => {}),
        toolbox: createToolbox([]),
        storage: { type: 'sqlite', path: storagePath },
        durableExecution: true,
      });
      try {
        await bureau.waitForRecovery?.();
        const again = await bureau.submitSteeringCommand(sessionId, {
          id: 'after-two-restarts',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        });
        expect(again.outcome).toBe('accepted');
        if (again.outcome !== 'accepted') throw new Error('expected accepted');
        expect(again.command.configVersion).toBe(2);

        const next = await bureau.submitSteeringCommand(sessionId, {
          id: 'next-coordinate',
          principal: 'alice',
          requestedValue: { target: 'provider', override: 'anthropic' },
        });
        if (next.outcome !== 'accepted') throw new Error(`expected accepted, got ${next.outcome}`);
        expect(next.command.configVersion).toBe(3);
      } finally {
        await bureau.dispose();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
