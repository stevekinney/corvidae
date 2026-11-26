/**
 * COR-2097 (review round 1) — what a session's ending, a run's boundary and a run's end announce
 * about steering commands that were accepted, with two Bureau processes over one SQLite file.
 *
 * The class under test: a process must not announce a steering outcome from a gate that the durable
 * log may contradict, and each accepted command's terminal outcome has exactly one announcer, on
 * every ending, whichever process admitted the command, hosts the run, or ends it.
 *
 * The table of endings (revision 2026-11-16; round 2 moved the announcer of a session's ending from
 * the process that committed it to the drainer of its `session.deleted` entry). "Admitted" is where
 * `contexts.steer` was called, "hosted" where the run lives.
 *
 * | ending | announces | silent | how it is decided |
 * | --- | --- | --- | --- |
 * | boundary applies the command | host, `steering.applied`, after its `applied` append commits (never from the run's own observation, which precedes the write) | every fold | the host's `applied` append |
 * | boundary finds its deadline passed | host, `steering.failed deadline-passed`, after its append, and no `steering.applied` | the others fold it | the host's append |
 * | run ends | host, `steering.failed run-terminal`, after its `run-ended` append | the others fold it | the host's append |
 * | session deleted or expired | the drainer of the `session.deleted` entry (any process, COR-174), when its seal of the log wins | the deleter or expirer, the host (its poller finds the session gone), the admitter, a drainer that finds the log sealed | a fold of the log up to the sealed head: a command it records as applied, failed or superseded is not announced |
 * | deletion races a boundary | whichever the log records first: an `applied` appended before the seal is in the drainer's fold, so it announces no failure; one after it finds a sealed log and is refused | the loser | the seal is one write conditioned on the head |
 *
 * No cell depends on any process holding a gate or remembering the ending: the drainer folds the log
 * into a gate of its own. `steering-outcome-table.slow.test.ts` crosses every ending with every kind,
 * binding and placement; the tests here are the four round 1 asked for: (1) a deletion on the
 * process that admitted a command the other process applied announces no failure and the command has
 * one terminal outcome; (2) a deletion on a process with no gate announces one failure for each
 * accepted command; (3) an expiry announces its failure after the store removed the session, and
 * none for an applied command; (4) a deletion that wins the race against the boundary is the only
 * outcome, and the late boundary appends nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgent, stopWhen } from '@lostgradient/operative';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer/testing';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { readSteeringLogEntries, readSteeringLogHead } from './steering-log';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { STEERABLE_MODELS } from './testing/default-agent.test-support';
import { createVendorCatalog } from './testing/vendor-catalog.test-support';

interface Envelope {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

const STEERING_KINDS = new Set([
  'steering.accepted',
  'steering.applied',
  'steering.rejected',
  'steering.superseded',
  'steering.failed',
]);

async function steeringEvents(bureau: Bureau, kind?: string): Promise<Envelope[]> {
  await bureau.internals.taskRegistry.flush();
  const found: Envelope[] = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
    const entry = envelope as unknown as Envelope;
    if (STEERING_KINDS.has(entry.kind) && (kind === undefined || entry.kind === kind)) {
      found.push({ kind: entry.kind, payload: entry.payload });
    }
  }
  return found;
}

async function taskStatus(bureau: Bureau, id: string): Promise<string | undefined> {
  const task = await bureau.tasks.get(id);
  return task?.status;
}

async function isRunning(bureau: Bureau, contextId: string): Promise<boolean> {
  const session = await bureau.contexts.get(contextId);
  return session?.metadata['lastRunStatus'] === 'running';
}

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

/** The real host polls every two seconds. Run this suite in the slow lane to exercise that path. */
const HOST_POLLS = 2500;

const pause = (id: string) =>
  ({ id, principal: 'alice', requestedValue: { target: 'pause' } }) as const;

const models = createVendorCatalog().descriptors;

/** Two Bureaus over one SQLite file, and the agents they run: one parks, one steps through a gated tool. */
async function withTwoProcesses(
  body: (rig: {
    a: Bureau;
    b: Bureau;
    /** Starts a run on `host`, and answers its session and run ids once the run is live. */
    start: (
      host: Bureau,
      agent: 'parked' | 'stepping',
    ) => Promise<{ sessionId: string; runId: string }>;
    /** Lets every stepping run's tool return. */
    releaseTools: () => void;
    /** How many stepping runs have entered their tool. */
    toolsEntered: () => number;
  }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-endings-'));
  const database = createSqliteStorageFixture({ path: join(directory, 'bureau.sqlite') });
  const opened: Bureau[] = [];
  let release: () => void = () => undefined;
  const toolGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const open = async () => {
    const next = createTool({
      name: 'next',
      description: 'continue',
      input: z.object({}),
      execute: async () => {
        entered += 1;
        await toolGate;
        return 'ok';
      },
    });
    const bureau = await createBureau<AgentDefinitions>({
      models: { catalog: models },
      agents: {
        parked: createAgent({
          allowedCandidates: STEERABLE_MODELS,
          // Parks until its run is aborted, as a provider call does.
          generate: ({ signal }) =>
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
          toolbox: createToolbox([]),
        }),
        stepping: createAgent({
          allowedCandidates: STEERABLE_MODELS,
          generate: async ({ step }) =>
            step === 0
              ? { content: '', toolCalls: [{ name: 'next', arguments: {} }] }
              : { content: 'done', toolCalls: [] },
          toolbox: createToolbox([next]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: database.open(),
      durable: true,
      onDiagnostic: () => undefined,
    });
    opened.push(bureau);
    return bureau;
  };
  try {
    const a = await open();
    const b = await open();
    await body({
      a,
      b,
      start: async (host, agent) => {
        const run = await host.tasks.start(agent, 'go', { principal: 'alice' });
        await waitUntil(() => isRunning(host, run.contextId), {
          message: 'the session is running',
        });
        return { sessionId: run.contextId, runId: run.id };
      },
      releaseTools: () => release(),
      toolsEntered: () => entered,
    });
  } finally {
    release();
    for (const bureau of opened) await bureau.dispose();
    await database[Symbol.asyncDispose]();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Starts a stepping run on `host`, pauses it through `admitter` while it is in its tool, and lets `host` fold the pause. */
async function pausedInTool(
  rig: Parameters<Parameters<typeof withTwoProcesses>[0]>[0],
  host: Bureau,
  admitter: Bureau,
  commandId: string,
) {
  const entering = rig.toolsEntered() + 1;
  const { sessionId, runId } = await rig.start(host, 'stepping');
  await waitUntil(() => rig.toolsEntered() >= entering, { message: 'the run is in its tool' });
  const admitted = await admitter.contexts.steer(sessionId, pause(commandId));
  expect(admitted.outcome).toBe('accepted');
  // The host folds the log at its next read of it, and a request of its own makes that read now.
  // It is refused for a stale revision, so it takes no configuration version of its own: the
  // boundary then observes the pause's version, which is what marks a pause applied.
  const folded = await host.contexts.steer(sessionId, {
    id: `${commandId}-fold`,
    principal: 'alice',
    expectedRevision: 0,
    requestedValue: { target: 'model', override: 'claude-sonnet-5' },
  });
  expect(folded.outcome).toBe('rejected');
  return { sessionId, runId };
}

describe('a session ended through the process that admitted a command another process applied (COR-2097)', () => {
  it('announces no failure for it, and the command has one terminal outcome across both processes', async () => {
    await withTwoProcesses(async (rig) => {
      const { a, b } = rig;
      const { sessionId, runId } = await pausedInTool(rig, b, a, 'p1');

      // The host reaches its boundary and applies the pause, which it logs.
      rig.releaseTools();
      await waitUntil(
        async () => {
          const applied = await steeringEvents(b, 'steering.applied');
          return applied.length > 0;
        },
        { message: 'the run applied the pause' },
      );
      const kv = b.internals.kv!;
      await waitUntil(
        async () => {
          const head = await readSteeringLogHead(
            kv,
            sessionId,
            (await b.contexts.get(sessionId))!.incarnation,
          );
          const entries = await readSteeringLogEntries(
            kv,
            sessionId,
            (await b.contexts.get(sessionId))!.incarnation,
            0,
            head.sequence,
          );
          return entries.some((entry) => entry.type === 'applied');
        },
        { message: 'the host logged the application' },
      );

      // The admitter's gate has not folded that: it holds p1 accepted. It deletes the session.
      await a.contexts.delete(sessionId);
      await waitUntil(async () => TERMINAL.has((await taskStatus(b, runId)) ?? ''), {
        message: 'the host released its run',
      });
      await quietFor(100);

      const terminal = [
        ...(await steeringEvents(a, 'steering.failed')),
        ...(await steeringEvents(b, 'steering.failed')),
        ...(await steeringEvents(b, 'steering.applied')),
        ...(await steeringEvents(a, 'steering.applied')),
      ];
      expect(terminal.map((event) => event.kind)).toEqual(['steering.applied']);
      expect(await steeringEvents(a, 'steering.failed')).toEqual([]);
    });
  });
});

describe('a session deleted through a process that holds no gate for it (COR-2097)', () => {
  it('announces one failure for each accepted, unapplied command, and the other processes stay silent', async () => {
    await withTwoProcesses(async ({ a, b, start }) => {
      const { sessionId, runId } = await start(a, 'parked');
      const firstPause = await a.contexts.steer(sessionId, pause('p1'));
      const secondPause = await a.contexts.steer(sessionId, pause('p2'));
      expect([firstPause.outcome, secondPause.outcome]).toEqual(['accepted', 'accepted']);

      // `b` never served this session: it has no cursor and no gate for it.
      expect(b.internals.sessionStore).toBeDefined();
      await b.contexts.delete(sessionId);
      // The host's poller reads the session every two seconds and finds it gone; a run with a
      // pause accepted is released, not aborted, so it is ended here.
      await quietFor(HOST_POLLS);
      await a.tasks.cancel(runId);

      const onB = await steeringEvents(b, 'steering.failed');
      expect(onB.map((event) => event.payload)).toEqual([
        { sessionId, commandId: 'p1', failureReason: 'run-terminal' },
        { sessionId, commandId: 'p2', failureReason: 'run-terminal' },
      ]);
      // Neither the admitter that hosts the run nor anyone else announces them a second time.
      expect(await steeringEvents(a, 'steering.failed')).toEqual([]);
    });
  });
});

describe('a session that expires (COR-2097)', () => {
  it('announces the run-terminal failure of an unapplied command once, after the store removed the session, and none for an applied one', async () => {
    await withTwoProcesses(async (rig) => {
      const { a, b, start } = rig;
      // One session whose command is applied, one whose command is not.
      const applied = await pausedInTool(rig, b, a, 'applied-1');
      rig.releaseTools();
      await waitUntil(
        async () => {
          const events = await steeringEvents(b, 'steering.applied');
          return events.length > 0;
        },
        { message: 'the run applied the pause' },
      );
      const unapplied = await start(b, 'parked');
      const admitted = await a.contexts.steer(unapplied.sessionId, pause('unapplied-1'));
      expect(admitted.outcome).toBe('accepted');

      // `a` expires every session.
      const expired = await a.internals.sessionStore!.cleanup({ olderThan: -60_000 });
      expect(expired).toBeGreaterThanOrEqual(2);
      await waitUntil(
        async () => {
          const failed = await steeringEvents(a, 'steering.failed');
          return failed.length > 0;
        },
        { message: 'the expiry announced the failure' },
      );
      await quietFor(100);

      // After the commit: the store no longer has the session when its failure is on the feed.
      expect(await a.internals.sessionStore!.load(unapplied.sessionId)).toBeUndefined();
      const failed = await steeringEvents(a, 'steering.failed');
      expect(failed.map((event) => event.payload)).toEqual([
        { sessionId: unapplied.sessionId, commandId: 'unapplied-1', failureReason: 'run-terminal' },
      ]);
      expect(JSON.stringify(failed)).not.toContain(applied.sessionId);
      expect(await steeringEvents(b, 'steering.failed')).toEqual([]);
    });
  });
});

describe('a deletion that races the boundary of the process hosting the run (COR-2097)', () => {
  it('is the only outcome when the log records it first, and the late boundary announces nothing', async () => {
    await withTwoProcesses(async (rig) => {
      const { a, b } = rig;
      const { sessionId, runId } = await pausedInTool(rig, b, a, 'p1');

      // The deletion commits first: the deleter reads the log with p1 accepted and announces it.
      await a.contexts.delete(sessionId);
      const failed = await steeringEvents(a, 'steering.failed');
      expect(failed.map((event) => event.payload)).toEqual([
        { sessionId, commandId: 'p1', failureReason: 'run-terminal' },
      ]);

      // The host has not polled yet: its tool returns and it reaches the boundary after the
      // deletion committed. The boundary's append finds the log sealed, so it applies nothing and
      // announces nothing, and the one outcome is the deleter's.
      rig.releaseTools();
      await waitUntil(async () => TERMINAL.has((await taskStatus(b, runId)) ?? ''), {
        message: 'the host ended its run',
      });
      await quietFor(100);

      expect(await steeringEvents(b, 'steering.applied')).toEqual([]);
      expect(await steeringEvents(b, 'steering.failed')).toEqual([]);
      expect(await steeringEvents(a, 'steering.failed')).toEqual(failed);
    });
  });
});
