/**
 * COR-2097 — `steering.applied`, `steering.rejected`, `steering.superseded` and `steering.failed`
 * reach the feed with the session, the command and a reason from a closed list, once, in the process
 * that decided them.
 *
 * Two Bureaus share one SQLite file, which is all two real processes share. A Bureau that only folds
 * the other's log (to decide its own command, or after a restart) announces nothing of what it
 * folds, and a retry of a key the log already decided is answered from the log and announces
 * nothing again. `steering.accepted` is the control: it follows the same rule on `main`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgent, stopWhen } from '@lostgradient/operative';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { STEERABLE_MODELS } from './testing/default-agent.test-support';
import { createVendorCatalog } from './testing/vendor-catalog.test-support';

const CANARY = 'CANARY-2097-STEER-d44e';

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

/** Every steering envelope the Bureau's feed holds, in feed order, as its kind and payload. */
async function steeringEvents(bureau: Bureau): Promise<Envelope[]> {
  await bureau.internals.taskRegistry.flush();
  const found: Envelope[] = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
    const { kind, payload } = envelope as unknown as Envelope;
    if (STEERING_KINDS.has(kind)) found.push({ kind, payload });
  }
  return found;
}

/** The steering envelopes of one kind. */
async function eventsOfKind(bureau: Bureau, kind: string): Promise<Envelope[]> {
  const events = await steeringEvents(bureau);
  return events.filter((entry) => entry.kind === kind);
}

/** The kinds of the steering envelopes the feed holds, in feed order. */
async function kindsOnFeed(bureau: Bureau): Promise<string[]> {
  const events = await steeringEvents(bureau);
  return events.map((entry) => entry.kind);
}

/** How a steering request was answered. */
async function outcomeOf(request: Promise<{ readonly outcome: string }>): Promise<string> {
  const answer = await request;
  return answer.outcome;
}

/** The status of a task, or `undefined` when there is none. */
async function taskStatus(bureau: Bureau, id: string): Promise<string | undefined> {
  const task = await bureau.tasks.get(id);
  return task?.status;
}

/** Whether the session's last run is still running. */
async function isRunning(bureau: Bureau, contextId: string): Promise<boolean> {
  const session = await bureau.contexts.get(contextId);
  return session?.metadata['lastRunStatus'] === 'running';
}

const models = createVendorCatalog().descriptors;

const model = (id: string, override: string) =>
  ({ id, principal: 'alice', requestedValue: { target: 'model', override } }) as const;

/** Runs `body` against two Bureaus over one SQLite file, and disposes both before the file goes. */
async function withTwoProcesses(
  body: (processes: { a: Bureau; b: Bureau; sessionId: string; runId: string }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-events-'));
  const database = createSqliteStorageFixture({ path: join(directory, 'bureau.sqlite') });
  const opened: Bureau[] = [];
  const open = async () => {
    const bureau = await createBureau<AgentDefinitions>({
      models: { catalog: models },
      agents: {
        default: createAgent({
          allowedCandidates: STEERABLE_MODELS,
          generate: () => new Promise<never>(() => {}),
          toolbox: createToolbox([]),
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
    const run = await a.tasks.start('default', `Wait forever ${CANARY}`, { principal: 'alice' });
    await waitUntil(() => isRunning(a, run.contextId), { message: 'the session is running' });
    await body({ a, b, sessionId: run.contextId, runId: run.id });
  } finally {
    for (const bureau of opened) await bureau.dispose();
    await database[Symbol.asyncDispose]();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('steering outcomes on the feed, across two Bureau processes (COR-2097)', () => {
  it('announces a replaced command once, where the replacement was admitted, and never in a process that folds it', async () => {
    await withTwoProcesses(async ({ a, b, sessionId }) => {
      expect(await outcomeOf(a.contexts.steer(sessionId, model('k1', 'claude-sonnet-5')))).toBe(
        'accepted',
      );
      expect(await outcomeOf(a.contexts.steer(sessionId, model('k2', 'claude-opus-4-8')))).toBe(
        'accepted',
      );

      const fromA = await steeringEvents(a);
      expect(fromA.map((entry) => entry.kind)).toEqual([
        'steering.accepted',
        'steering.superseded',
        'steering.accepted',
      ]);
      expect(fromA[1]?.payload).toEqual({
        sessionId,
        commandId: 'k1',
        failureReason: 'superseded-by',
      });

      // B folds A's whole log (both commands and the supersession) before deciding its own.
      const fromBRequest = b.contexts.steer(sessionId, {
        id: 'b1',
        principal: 'alice',
        requestedValue: { target: 'provider', override: 'anthropic' },
      });
      expect(await outcomeOf(fromBRequest)).toBe('accepted');
      const fromB = await steeringEvents(b);
      expect(fromB.map((entry) => entry.kind)).toEqual(['steering.accepted']);
      expect(fromB[0]?.payload).toMatchObject({ sessionId, commandId: 'b1' });

      // Nor does A announce it again once it folds B's command.
      await a.contexts.steer(sessionId, {
        id: 'a3',
        principal: 'alice',
        requestedValue: { target: 'effort', override: 'high' },
      });
      expect(await kindsOnFeed(a)).toEqual([
        'steering.accepted',
        'steering.superseded',
        'steering.accepted',
        'steering.accepted',
      ]);
    });
  });

  it('announces a refusal once, and a retry of its key announces nothing in either process', async () => {
    await withTwoProcesses(async ({ a, b, sessionId }) => {
      const refusedByGate = {
        id: 'late',
        principal: 'alice',
        deadline: '2000-01-01T00:00:00.000Z',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      } as const;

      // The gate refuses it: its deadline has passed.
      expect(await outcomeOf(a.contexts.steer(sessionId, refusedByGate))).toBe('rejected');
      // Bureau refuses it before the gate: the model is not in the catalog.
      expect(await outcomeOf(a.contexts.steer(sessionId, model('off', CANARY)))).toBe('rejected');

      const afterRefusals = await steeringEvents(a);
      expect(afterRefusals).toEqual([
        {
          kind: 'steering.rejected',
          payload: { sessionId, commandId: 'late', failureReason: 'deadline-passed' },
        },
        {
          kind: 'steering.rejected',
          payload: { sessionId, commandId: 'off', failureReason: 'policy-denied' },
        },
      ]);
      expect(JSON.stringify(afterRefusals)).not.toContain(CANARY);

      // The same keys again, here and in the other process: answered from the log, decided nowhere.
      expect(await outcomeOf(a.contexts.steer(sessionId, refusedByGate))).toBe('rejected');
      expect(await outcomeOf(b.contexts.steer(sessionId, refusedByGate))).toBe('rejected');
      expect(await outcomeOf(b.contexts.steer(sessionId, model('off', CANARY)))).toBe('rejected');

      expect(await steeringEvents(a)).toEqual(afterRefusals);
      expect(await steeringEvents(b)).toEqual([]);
    });
  });

  it('announces a command that failed because its run ended once, and a process that folds it announces nothing', async () => {
    await withTwoProcesses(async ({ a, b, sessionId, runId }) => {
      // The run is in its first generate call, so a pause is accepted and has no boundary to apply at.
      const pause = await a.contexts.steer(sessionId, {
        id: 'p1',
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pause.outcome).toBe('accepted');
      await a.tasks.cancel(runId);
      await waitUntil(
        async () => {
          const failedYet = await eventsOfKind(a, 'steering.failed');
          return failedYet.length > 0;
        },
        { message: 'the pause failed with its run' },
      );

      const failed = await eventsOfKind(a, 'steering.failed');
      expect(failed).toEqual([
        {
          kind: 'steering.failed',
          payload: { sessionId, commandId: 'p1', failureReason: 'run-terminal' },
        },
      ]);

      // B folds the log with the pause, the run's end and the failure, and announces none of it.
      await b.contexts.steer(sessionId, model('b1', 'claude-sonnet-5')).catch(() => undefined);
      const kindsOnB = await kindsOnFeed(b);
      expect(kindsOnB.filter((kind) => kind !== 'steering.accepted')).toEqual([]);
      expect(await eventsOfKind(a, 'steering.failed')).toHaveLength(1);
    });
  });
});

/** An agent whose first step calls a tool that waits for `release`, then answers. */
function stepsThroughATool() {
  let releaseTool: (() => void) | undefined;
  const toolGate = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  let calls = 0;
  const next = createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => {
      await toolGate;
      return 'ok';
    },
  });
  return {
    release: () => releaseTool?.(),
    calls: () => calls,
    agent: createAgent({
      name: 'default',
      generate: async ({ step }) => {
        calls += 1;
        return step === 0
          ? { content: '', toolCalls: [{ name: 'next', arguments: {} }] }
          : { content: 'done', toolCalls: [] };
      },
      toolbox: createToolbox([next]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  };
}

describe('steering outcomes on the feed, in one process (COR-2097)', () => {
  const bureaus: Bureau[] = [];
  afterEach(async () => {
    for (const bureau of bureaus.splice(0)) await bureau.dispose();
  });

  async function open(agent: ReturnType<typeof createAgent>) {
    const bureau = await createBureau<AgentDefinitions>({
      agents: { default: agent },
      storage: new MemoryStorage(),
      onDiagnostic: () => undefined,
    });
    bureaus.push(bureau);
    return bureau;
  }

  it('publishes steering.applied for a run that observes an accepted pause and resume, naming only the session, and not again for the next run', async () => {
    const steps = stepsThroughATool();
    const bureau = await open(steps.agent);
    const run = await bureau.tasks.start('default', `go ${CANARY}`, { principal: 'alice' });
    await waitUntil(() => steps.calls() === 1, { message: 'the run is in its tool' });

    expect(
      await outcomeOf(
        bureau.contexts.steer(run.contextId, {
          principal: 'alice',
          requestedValue: { target: 'pause' },
        }),
      ),
    ).toBe('accepted');
    steps.release();
    await waitUntil(
      async () => {
        const appliedYet = await eventsOfKind(bureau, 'steering.applied');
        return appliedYet.length > 0;
      },
      { message: 'the run applied the pause' },
    );
    expect(
      await outcomeOf(
        bureau.contexts.steer(run.contextId, {
          principal: 'alice',
          requestedValue: { target: 'resume' },
        }),
      ),
    ).toBe('accepted');
    await waitUntil(async () => (await taskStatus(bureau, run.id)) === 'completed', {
      message: 'the run completed',
    });

    const applied = await eventsOfKind(bureau, 'steering.applied');
    // One for each accepted command the run observed (the pause, then the resume), never a doubled one.
    expect(applied).toHaveLength(2);
    for (const entry of applied) expect(entry.payload).toEqual({ sessionId: run.contextId });
    expect(JSON.stringify(applied)).not.toContain(CANARY);

    // A second run on the session does not announce a version the first already applied.
    const second = await bureau.tasks.start('default', 'again', {
      contextId: run.contextId,
      principal: 'alice',
    });
    await waitUntil(async () => (await taskStatus(bureau, second.id)) === 'completed', {
      message: 'the second run completed',
    });
    expect(await eventsOfKind(bureau, 'steering.applied')).toHaveLength(applied.length);
  });

  it('announces a refusal and a replaced command in a Bureau with no durable log, once each', async () => {
    const steps = stepsThroughATool();
    const bureau = await open(steps.agent);
    const run = await bureau.tasks.start('default', 'go', { principal: 'alice' });
    await waitUntil(() => steps.calls() === 1, { message: 'the run is in its tool' });

    // A pause no boundary has applied yet, then a resume that replaces it.
    await bureau.contexts.steer(run.contextId, {
      id: 'p1',
      principal: 'alice',
      requestedValue: { target: 'pause' },
    });
    await bureau.contexts.steer(run.contextId, {
      id: 'r1',
      principal: 'alice',
      requestedValue: { target: 'resume' },
    });
    // A command naming an agent this Bureau does not have is refused before the gate.
    const refused = await bureau.contexts.steer(run.contextId, {
      id: 'ghost',
      principal: 'alice',
      requestedValue: { target: 'agent-identity', override: CANARY },
    });
    expect(refused.outcome).toBe('rejected');
    // And a command with a stale revision, which the gate refuses.
    const stale = await bureau.contexts.steer(run.contextId, {
      id: 'stale',
      principal: 'alice',
      expectedRevision: 0,
      requestedValue: { target: 'pause' },
    });
    expect(stale.outcome).toBe('rejected');
    steps.release();

    const everything = await steeringEvents(bureau);
    const outcomes = everything.filter(
      (entry) => entry.kind !== 'steering.accepted' && entry.kind !== 'steering.applied',
    );
    expect(outcomes).toEqual([
      {
        kind: 'steering.superseded',
        payload: { sessionId: run.contextId, commandId: 'p1', failureReason: 'superseded-by' },
      },
      {
        kind: 'steering.rejected',
        payload: { sessionId: run.contextId, commandId: 'ghost', failureReason: 'policy-denied' },
      },
      {
        kind: 'steering.rejected',
        payload: { sessionId: run.contextId, commandId: 'stale', failureReason: 'stale-revision' },
      },
    ]);
    expect(JSON.stringify(outcomes)).not.toContain(CANARY);
  });
});

/**
 * A storage that fails every conditional write to a session's steering log while `failing()` says
 * so, and passes everything else through. The log is the commit an event is published after.
 */
function failingSteeringWrites(storage: Storage, failing: () => boolean, attempts: () => void) {
  return new Proxy(storage, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      if (property !== 'conditionalBatch') return value.bind(target);
      return (conditions: readonly { readonly key: string }[], ...rest: unknown[]) => {
        if (
          failing() &&
          conditions.some((condition) => condition.key.startsWith('steering-log:'))
        ) {
          attempts();
          return Promise.reject(new Error('the steering log could not be written'));
        }
        return Reflect.apply(value, target, [conditions, ...rest]) as unknown;
      };
    },
  });
}

describe('a steering write whose commit throws publishes nothing (COR-2097)', () => {
  async function withFailingLog(
    body: (rig: {
      bureau: Bureau;
      fail: () => void;
      recover: () => void;
      attempted: () => number;
      steps: ReturnType<typeof stepsThroughATool>;
    }) => Promise<void>,
  ): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-commit-'));
    const database = createSqliteStorageFixture({ path: join(directory, 'bureau.sqlite') });
    let failing = false;
    let attempts = 0;
    const steps = stepsThroughATool();
    const bureau = await createBureau<AgentDefinitions>({
      agents: { default: steps.agent },
      storage: failingSteeringWrites(
        database.open(),
        () => failing,
        () => (attempts += 1),
      ),
      durable: true,
      onDiagnostic: () => undefined,
    });
    try {
      await body({
        bureau,
        fail: () => {
          failing = true;
        },
        recover: () => {
          failing = false;
        },
        attempted: () => attempts,
        steps,
      });
    } finally {
      steps.release();
      await bureau.dispose();
      await database[Symbol.asyncDispose]();
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('announces no command a refused append would have recorded', async () => {
    await withFailingLog(async ({ bureau, fail, attempted, steps }) => {
      const run = await bureau.tasks.start('default', 'go', { principal: 'alice' });
      await waitUntil(() => steps.calls() === 1, { message: 'the run is in its tool' });
      expect(
        await outcomeOf(
          bureau.contexts.steer(run.contextId, {
            id: 'p1',
            principal: 'alice',
            requestedValue: { target: 'pause' },
          }),
        ),
      ).toBe('accepted');
      const before = await kindsOnFeed(bureau);

      fail();
      // The replacement's append throws: the command it would have replaced is not announced. A
      // resume replaces the pause (a second pause would join it as one more owner), so a
      // `steering.superseded` announced before the commit would show here.
      await bureau.contexts
        .steer(run.contextId, {
          id: 'r1',
          principal: 'alice',
          requestedValue: { target: 'resume' },
        })
        .then(
          () => undefined,
          () => undefined,
        );

      expect(attempted()).toBeGreaterThan(0);
      expect(await kindsOnFeed(bureau)).toEqual(before);
    });
  });

  it('announces no boundary whose append throws', async () => {
    await withFailingLog(async ({ bureau, fail, attempted, steps }) => {
      const run = await bureau.tasks.start('default', 'go', { principal: 'alice' });
      await waitUntil(() => steps.calls() === 1, { message: 'the run is in its tool' });
      expect(
        await outcomeOf(
          bureau.contexts.steer(run.contextId, {
            principal: 'alice',
            requestedValue: { target: 'pause' },
          }),
        ),
      ).toBe('accepted');

      fail();
      steps.release();
      await waitUntil(() => attempted() > 0, { message: 'the boundary tried to log' });
      await quietFor(100);

      expect(await eventsOfKind(bureau, 'steering.applied')).toEqual([]);
    });
  });

  it('announces no failure for a session ending whose seal throws, and announces it once when a later drain seals', async () => {
    await withFailingLog(async ({ bureau, fail, recover, attempted, steps }) => {
      const run = await bureau.tasks.start('default', 'go', { principal: 'alice' });
      await waitUntil(() => steps.calls() === 1, { message: 'the run is in its tool' });
      expect(
        await outcomeOf(
          bureau.contexts.steer(run.contextId, {
            id: 'p1',
            principal: 'alice',
            requestedValue: { target: 'pause' },
          }),
        ),
      ).toBe('accepted');

      fail();
      // The drain of the deletion's `session.deleted` entry cannot seal the log, so it decides
      // nothing, announces nothing, and leaves the entry for a later drain.
      const deleting = bureau.contexts.delete(run.contextId);
      await waitUntil(() => attempted() > 0, { message: 'the drain tried to seal the log' });
      steps.release();
      await deleting;
      const outbox = bureau.internals.sessionStore!.outbox;
      const pendingKinds = async () => {
        const pending = await outbox.pending();
        return pending.map((entry) => entry.kind);
      };
      expect(await eventsOfKind(bureau, 'steering.failed')).toEqual([]);
      expect(await pendingKinds()).toEqual(['session.deleted']);

      recover();
      await bureau.maintain();
      await waitUntil(
        async () => {
          const kinds = await pendingKinds();
          return kinds.length === 0;
        },
        { message: 'the entry drained' },
      );
      const failed = await eventsOfKind(bureau, 'steering.failed');
      expect(failed.map((event) => event.payload)).toEqual([
        { sessionId: run.contextId, commandId: 'p1', failureReason: 'run-terminal' },
      ]);
    });
  });
});
