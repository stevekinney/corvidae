/**
 * Durable steering survives real process kills, any number of them.
 *
 * Child processes (`test/steering-crash-child.ts`) admit or retry steering
 * commands through the public verb and SIGKILL themselves — no exit handler,
 * no `dispose()`, no flush — so whatever a later process finds was on disk
 * before the earlier one died. The steering log is never consumed, so the
 * second and third restarts must see exactly what the first did.
 *
 * No sleeps in the parent: it waits on process exit and on the child's own
 * marker file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveStorage, textValueStore } from '@lostgradient/weft';
import { stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import {
  appendSteeringLogEvent,
  readSteeringLogEntries,
  readSteeringLogHead,
} from './steering-log';

const CHILD = join(import.meta.dir, 'test', 'steering-crash-child.ts');

/** Matches the child's short workflow claim, so recovery can follow a kill quickly. */
const CLAIM_TTL_MS = 200;
const CLAIM_OPTIONS = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: CLAIM_TTL_MS,
  workflowClaimRenewIntervalMs: 50,
} as const;

interface Marker {
  readonly sessionId: string;
  readonly incarnation: string;
  readonly outcomes: readonly {
    readonly outcome: string;
    readonly command?: { readonly configVersion: number; readonly state: string };
  }[];
}

/** Runs the crash child to its own SIGKILL and returns the marker it wrote. */
async function runCrashingChild(
  directory: string,
  name: string,
  args: readonly string[],
): Promise<Marker> {
  const storagePath = join(directory, 'bureau.sqlite');
  const markerPath = join(directory, `${name}.json`);
  const child = Bun.spawn(['bun', CHILD, storagePath, markerPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await child.exited;
  const stderr = await new Response(child.stderr).text();
  // The child kills itself, so a clean exit would mean it returned normally
  // instead — which would invalidate the test's premise, not merely fail it.
  expect(child.signalCode ?? stderr).toBe('SIGKILL');
  expect(existsSync(markerPath)).toBe(true);
  return JSON.parse(readFileSync(markerPath, 'utf8')) as Marker;
}

async function openBureau(directory: string) {
  return createBureau({
    agents: {},
    generate: () => new Promise<never>(() => {}),
    toolbox: createToolbox([]),
    storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
    durableExecution: true,
    durableOwnership: CLAIM_OPTIONS,
  });
}

function withDirectory(prefix: string, body: (directory: string) => Promise<void>) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    try {
      await body(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

describe('durable steering survives SIGKILL', () => {
  it(
    'logs a command admitted by a process that was killed without disposing',
    withDirectory('corvidae-steering-crash-', async (directory) => {
      const { sessionId, incarnation } = await runCrashingChild(directory, 'admitted', [
        'admit',
        'pause',
      ]);

      // A fresh handle on the same file, in this process: nothing is shared
      // with the dead one but the bytes it left on disk.
      const storage = await resolveStorage({
        type: 'sqlite',
        path: join(directory, 'bureau.sqlite'),
      });
      const kv = textValueStore(storage);
      const head = await readSteeringLogHead(kv, sessionId, incarnation);
      const events = await readSteeringLogEntries(kv, sessionId, incarnation, 0, head.sequence);
      const admitted = events.filter((event) => event.type === 'admit');
      expect(admitted).toHaveLength(1);
      expect(admitted[0]?.type === 'admit' && admitted[0].command.id).toBe('crash-cmd-1');
      expect(admitted[0]?.type === 'admit' && admitted[0].command.requestedValue).toEqual({
        target: 'pause',
      });
      await kv.close();
    }),
    60_000,
  );

  it(
    'keeps (principal, id) idempotency across two and three restarts, and across sessions',
    withDirectory('corvidae-steering-crash-twice-', async (directory) => {
      const { sessionId } = await runCrashingChild(directory, 'admitted', ['admit', 'model']);
      const retried = await runCrashingChild(directory, 'retried', ['retry', 'model', sessionId]);
      expect(retried.outcomes.map(({ outcome }) => outcome)).toEqual(['replayed']);
      const again = await runCrashingChild(directory, 'retried-again', [
        'retry',
        'model',
        sessionId,
      ]);
      expect(again.outcomes.map(({ outcome }) => outcome)).toEqual(['replayed']);

      const bureau = await openBureau(directory);
      try {
        await bureau.waitForRecovery?.();
        const differentTarget = await bureau.submitSteeringCommand(sessionId, {
          id: 'crash-cmd-2',
          principal: 'alice',
          requestedValue: { target: 'provider', override: 'anthropic' },
        });
        expect(differentTarget.outcome).toBe('conflict');
        if (differentTarget.outcome !== 'conflict') throw new Error('expected conflict');
        expect(differentTarget.conflict.reason).toBe('target-mismatch');
        expect(differentTarget.conflict.original.requestedValue).toEqual({
          target: 'model',
          override: 'claude-sonnet-5',
        });

        // The key is bureau-wide: the same key sent to another session is a
        // `session-mismatch`, though that session's own log never saw it.
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
    }),
    60_000,
  );

  it(
    'keeps desired configuration and its configVersion across two restarts',
    withDirectory('corvidae-steering-desired-', async (directory) => {
      // The first process steers the model twice (configVersion 1, then 2)
      // and dies. A fresh id re-requesting the desired value is accepted
      // without advancing configVersion, which is how these assertions
      // observe both the folded value and the folded version: a fold that
      // lost the history would report 1, and one that double-applied it, 4.
      const first = await runCrashingChild(directory, 'admitted', ['admit', 'opus,model']);
      expect(first.outcomes.map(({ command }) => command?.configVersion)).toEqual([1, 2]);

      const probe = await runCrashingChild(directory, 'probed', [
        'retry',
        'probe',
        first.sessionId,
      ]);
      expect(probe.outcomes[0]?.outcome).toBe('accepted');
      expect(probe.outcomes[0]?.command?.configVersion).toBe(2);

      const bureau = await openBureau(directory);
      try {
        await bureau.waitForRecovery?.();
        const again = await bureau.submitSteeringCommand(first.sessionId, {
          id: 'after-two-restarts',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        });
        if (again.outcome !== 'accepted')
          throw new Error(`expected accepted, got ${again.outcome}`);
        expect(again.command.configVersion).toBe(2);

        const next = await bureau.submitSteeringCommand(first.sessionId, {
          id: 'next-coordinate',
          principal: 'alice',
          requestedValue: { target: 'provider', override: 'anthropic' },
        });
        if (next.outcome !== 'accepted') throw new Error(`expected accepted, got ${next.outcome}`);
        expect(next.command.configVersion).toBe(3);

        // `opus` was superseded by `model` in the first process; folding
        // the log reproduces that state.
        const superseded = await bureau.submitSteeringCommand(first.sessionId, {
          id: 'crash-cmd-3',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-opus-4-8' },
        });
        expect(superseded.outcome).toBe('replayed');
        if (superseded.outcome !== 'replayed') throw new Error('expected replayed');
        expect(superseded.command.state).toBe('superseded');
      } finally {
        await bureau.dispose();
      }
    }),
    60_000,
  );

  it(
    'hands a run recovered after a crash its steering, and logs what it applies',
    withDirectory('corvidae-steering-recovered-run-', async (directory) => {
      // The child's run is mid-step when the model is steered and the
      // process dies. Once the child's workflow claim lapses, the recovering
      // process resumes that run; with the steering folded in, the run's
      // next boundary marks the command applied in the log.
      const { sessionId } = await runCrashingChild(directory, 'admitted', ['admit', 'model']);
      await Bun.sleep(CLAIM_TTL_MS * 10);

      let generateCalls = 0;
      const recovering = await createBureau({
        agents: {},
        generate: async () => {
          generateCalls += 1;
          return { content: 'done', toolCalls: [] };
        },
        toolbox: createToolbox([]),
        storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
        durableExecution: true,
        durableOwnership: CLAIM_OPTIONS,
        stopWhen: stopWhen.noToolCalls(),
      });
      try {
        await recovering.waitForRecovery?.();
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const session = await recovering.getSession(sessionId);
          if (session?.metadata['lastRunStatus'] === 'completed') break;
          await Bun.sleep(10);
        }
        expect(generateCalls).toBeGreaterThan(0);
      } finally {
        await recovering.dispose();
      }

      // A process that only folds the log sees the command applied.
      const reader = await openBureau(directory);
      try {
        await reader.waitForRecovery?.();
        await reader.createRun({ message: 'again', principal: 'alice', sessionId });
        const outcome = await reader.submitSteeringCommand(sessionId, {
          id: 'crash-cmd-2',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        });
        expect(outcome.outcome).toBe('replayed');
        if (outcome.outcome !== 'replayed') throw new Error('expected replayed');
        expect(outcome.command.state).toBe('applied');
      } finally {
        await reader.dispose();
      }
    }),
    60_000,
  );

  it(
    'fails a recovered run whose steering log is corrupt instead of resuming it on defaults',
    withDirectory('corvidae-steering-recovered-corrupt-', async (directory) => {
      const { sessionId, incarnation } = await runCrashingChild(directory, 'admitted', [
        'admit',
        'model',
      ]);
      const storage = await resolveStorage({
        type: 'sqlite',
        path: join(directory, 'bureau.sqlite'),
      });
      const kv = textValueStore(storage);
      const [entryKey] = (await kv.list('steering-log:v1:')).filter((key) =>
        key.includes(':entry:'),
      );
      if (entryKey === undefined) throw new Error('expected a logged entry');
      await kv.set(entryKey, '{"type":"admit"}');
      expect((await readSteeringLogHead(kv, sessionId, incarnation)).sequence).toBeGreaterThan(0);
      await kv.close();
      await Bun.sleep(CLAIM_TTL_MS * 10);

      let generateCalls = 0;
      const recovering = await createBureau({
        agents: {},
        generate: async () => {
          generateCalls += 1;
          return { content: 'done', toolCalls: [] };
        },
        toolbox: createToolbox([]),
        storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
        durableExecution: true,
        durableOwnership: CLAIM_OPTIONS,
        stopWhen: stopWhen.noToolCalls(),
      });
      try {
        await recovering.waitForRecovery?.();
        let status: string | undefined;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const runs = await recovering.listDurableRuns?.();
          status = runs?.items[0]?.status;
          if (status === 'failed' || status === 'completed') break;
          await Bun.sleep(10);
        }
        expect(status).toBe('failed');
        expect(generateCalls).toBe(0);
      } finally {
        await recovering.dispose();
      }
    }),
    60_000,
  );

  it(
    'sweeps a steering log whose session no longer exists at boot',
    withDirectory('corvidae-steering-orphan-', async (directory) => {
      const path = join(directory, 'bureau.sqlite');
      // An orphan: a log for a session the store never had, as a crash after
      // a deletion committed (but before its log was removed) leaves behind.
      const storage = await resolveStorage({ type: 'sqlite', path });
      const kv = textValueStore(storage);
      await appendSteeringLogEvent(
        kv,
        'ghost-session',
        'ghost-incarnation',
        await readSteeringLogHead(kv, 'ghost-session', 'ghost-incarnation'),
        { type: 'run-ended', runId: 'ghost-run', now: '2026-09-02T00:00:00.000Z' },
      );
      await kv.close();

      const bureau = await openBureau(directory);
      await bureau.waitForRecovery?.();
      await bureau.dispose();

      const after = await resolveStorage({ type: 'sqlite', path });
      const afterKv = textValueStore(after);
      try {
        expect(await readSteeringLogHead(afterKv, 'ghost-session', 'ghost-incarnation')).toEqual({
          raw: null,
          sequence: 0,
        });
      } finally {
        await afterKv.close();
      }
    }),
    60_000,
  );
});
