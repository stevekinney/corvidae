/**
 * COR-1302 — the handle `bureau.run()` returns carries its run's stable id.
 *
 * The id exists before the run does: `bureau.run()` returns synchronously,
 * ahead of the agent resolution and durable start it defers. These tests pin
 * that the id on the handle is the one its liveness snapshot reports from the
 * first instant, the one the durable workflow is stored under, and the one
 * Bureau's read and control surfaces (`getRun`, `abortRun`, `getDurableRun`,
 * `eventHistory`) resolve.
 */

import { createAgent, createStore, type RunnableAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';

import { createBureau } from './create-bureau';

const databasePaths: string[] = [];

function nextDatabasePath(): string {
  const path = createTemporaryPath('bureau-run-identity', '.sqlite');
  databasePaths.push(path);
  return path;
}

afterEach(async () => {
  for (const path of databasePaths.splice(0)) {
    removeTemporaryPath(path);
  }
});

function echoAgent() {
  return createAgent({ generate: async () => ({ content: 'ok', toolCalls: [] }) });
}

/**
 * An agent whose model call parks until released, so a test can act on the run
 * while it is still running. `entered` settles once the run is calling its
 * model, which is after Bureau has registered the run it dispatched.
 */
function gatedAgent() {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const agent = createAgent({
    generate: async () => {
      markEntered();
      await gate;
      return { content: 'too late', toolCalls: [] };
    },
  });
  return { agent, entered, release };
}

describe('bureau.run() run identity (COR-1302)', () => {
  it('gives a direct-dispatch handle an id its snapshot reports before and after the run settles', async () => {
    const bureau = await createBureau({ agents: { echo: echoAgent() } });
    try {
      const run = bureau.run('echo', 'hi');
      const id = run.id;
      expect(id).not.toBe('echo');
      expect(run.snapshot().id).toBe(id);
      await run.result();
      expect(run.id).toBe(id);
      expect(run.snapshot().id).toBe(id);
    } finally {
      await bureau.dispose();
    }
  });

  it('gives a durable handle the workflow id that getDurableRun and eventHistory resolve', async () => {
    const bureau = await createBureau({
      agents: { echo: echoAgent() },
      storage: { type: 'sqlite', path: nextDatabasePath() },
      durable: true,
    });
    try {
      const run = bureau.run('echo', 'hi', { principal: 'alice' });
      const id = run.id;
      expect(id).not.toBe('echo');
      expect(run.snapshot().id).toBe(id);

      const result = await run.result();
      expect(result.content).toBe('ok');
      expect(run.id).toBe(id);
      expect(run.snapshot().id).toBe(id);

      const durableRuns = await bureau.listDurableRuns();
      expect(durableRuns?.items.map((item) => item.id)).toContain(id);
      expect(await bureau.getDurableRun(id)).toMatchObject({ id });

      // The run has settled and Bureau has released it from its run store,
      // without `deleteRun`: its attribution stays, so alice's read still
      // resolves the id to her run. The page is empty because a catalog run's
      // actions stay off the bureau's `'action'` stream, which is what durable
      // event history records; the release is not recorded as a deletion.
      expect(bureau.getRun(id)).toBeUndefined();
      expect(await bureau.eventHistory({ kind: 'run', id }, { principal: 'alice' })).toEqual({
        events: [],
        hasMore: false,
      });
      // A principal-gated read answers `not-found` for an id no run is
      // attributed under, so alice's page above is the id resolving to her
      // run, and another principal is refused that same id.
      expect(
        await bureau.eventHistory({ kind: 'run', id: `${id}-unknown` }, { principal: 'alice' }),
      ).toEqual({ outcome: 'not-found' });
      expect(await bureau.eventHistory({ kind: 'run', id }, { principal: 'mallory' })).toEqual({
        outcome: 'not-found',
      });
    } finally {
      await bureau.dispose();
    }
  });

  it('gives two concurrent runs of one agent distinct ids', async () => {
    const bureau = await createBureau({ agents: { echo: echoAgent() } });
    try {
      const first = bureau.run('echo', 'first');
      const second = bureau.run('echo', 'second');
      expect(first.id).not.toBe(second.id);
      await Promise.all([first.result(), second.result()]);
      expect(first.snapshot().id).toBe(first.id);
      expect(second.snapshot().id).toBe(second.id);
    } finally {
      await bureau.dispose();
    }
  });

  describe('getRun and abortRun accept the handle id', () => {
    const branches = [
      { name: 'direct', durable: false },
      { name: 'durable', durable: true },
    ] as const;

    for (const branch of branches) {
      it(`resolves and aborts a ${branch.name} catalog run by run.id`, async () => {
        const gated = gatedAgent();
        const bureau = await createBureau({
          agents: { echo: gated.agent },
          ...(branch.durable
            ? {
                storage: { type: 'sqlite', path: nextDatabasePath() } as const,
                durable: true,
              }
            : {}),
        });
        try {
          const run = bureau.run('echo', 'hi', { principal: 'alice' });
          await gated.entered;

          const live = bureau.getRun(run.id);
          expect(live?.id).toBe(run.id);
          expect(live?.status).toBe('running');
          expect(live?.liveness.id).toBe(run.id);
          expect(live?.liveness.owner).toBe('alice');
          // Only the durable branch records a catalog run's attribution
          // (AB-241), but the run's owner is read in one place (COR-1588): the
          // handle's own owner stands in where none was recorded, so the
          // principal a run reports is the owner `getOwner` reports, on both
          // branches.
          expect(live?.principal).toBe('alice');

          // A catalog run has no bureau session, and `listRuns` keeps listing
          // only the runs `createRun` started (run listing is COR-1304's).
          expect(bureau.listRuns().map((summary) => summary.id)).not.toContain(run.id);

          expect(bureau.abortRun(run.id)).toMatchObject({ id: run.id, status: 'aborting' });
          gated.release();
          const result = await run.result();
          expect(result.finishReason).toBe('aborted');

          // A settled `bureau.run()` run is released on its own, as it was
          // before it could be read by id, so a long-lived bureau does not
          // keep one entry per historical run (AB-22).
          expect(bureau.getRun(run.id)).toBeUndefined();
          expect(() => bureau.abortRun(run.id)).toThrow('Run not found');
        } finally {
          gated.release();
          await bureau.dispose();
        }
      });
    }

    for (const branch of branches) {
      it(`aborts a ${branch.name} catalog run by run.id in the tick bureau.run() returns it`, async () => {
        const gated = gatedAgent();
        const bureau = await createBureau({
          agents: { echo: gated.agent },
          ...(branch.durable
            ? {
                storage: { type: 'sqlite', path: nextDatabasePath() } as const,
                durable: true,
              }
            : {}),
        });
        try {
          const run = bureau.run('echo', 'hi', { principal: 'alice' });

          // Nothing has been built for the run yet: Bureau resolves it from
          // its handle, which reports the same id and owner.
          const pending = bureau.getRun(run.id);
          expect(pending).toMatchObject({
            id: run.id,
            status: 'running',
            agentName: 'echo',
            steps: 0,
            actionCount: 0,
          });
          expect(pending?.liveness.id).toBe(run.id);
          expect(pending?.liveness.owner).toBe('alice');

          expect(bureau.abortRun(run.id)).toMatchObject({ id: run.id, status: 'aborting' });
          const result = await run.result();
          expect(result.finishReason).toBe('aborted');
          expect(bureau.getRun(run.id)).toBeUndefined();
        } finally {
          gated.release();
          await bureau.dispose();
        }
      });
    }

    it('resolves and aborts a hand-written catalog agent, which Bureau never builds a run for', async () => {
      const gated = gatedAgent();
      const handWritten: RunnableAgent<unknown, boolean> = {
        name: 'hand',
        hasOutput: false,
        run: (input, context) => gated.agent.run(input, context),
      };
      const bureau = await createBureau({ agents: { hand: handWritten } });
      try {
        const run = bureau.run('hand', 'hi');
        await gated.entered;

        expect(bureau.getRun(run.id)).toMatchObject({ id: run.id, status: 'running' });
        expect(bureau.abortRun(run.id)).toMatchObject({ id: run.id, status: 'aborting' });
        gated.release();
        const result = await run.result();
        expect(result.finishReason).toBe('aborted');
        expect(bureau.getRun(run.id)).toBeUndefined();
      } finally {
        gated.release();
        await bureau.dispose();
      }
    });

    it('never registers a durable catalog run whose handle was aborted before its run was built', async () => {
      // The handle settles `aborted` at once, while the deferred dispatch is
      // still resolving the agent. When that dispatch resumes it builds the
      // durable run only to forward the cancellation for cleanup; registering
      // it then would make `getRun(run.id)` report a live run again after
      // `run.result()` had already resolved.
      const store = createStore();
      const registeredRunIds: string[] = [];
      const register = store.register;
      store.register = (activeRun, id) => {
        registeredRunIds.push(id ?? activeRun.runId);
        return register(activeRun, id);
      };
      const gated = gatedAgent();
      const bureau = await createBureau({
        agents: { echo: gated.agent },
        store,
        storage: { type: 'sqlite', path: nextDatabasePath() },
        durable: true,
      });
      try {
        const run = bureau.run('echo', 'hi', { principal: 'alice' });
        expect(bureau.abortRun(run.id)).toMatchObject({ id: run.id, status: 'aborting' });
        const result = await run.result();
        expect(result.finishReason).toBe('aborted');
        // `closed()` waits for the dispatch to build the run and finish the
        // cleanup the forwarded cancellation started.
        await run.closed();

        expect(registeredRunIds).not.toContain(run.id);
        expect(bureau.getRun(run.id)).toBeUndefined();
      } finally {
        gated.release();
        await bureau.dispose();
      }
    });

    it('leaves an unknown id not found', async () => {
      const bureau = await createBureau({ agents: { echo: echoAgent() } });
      try {
        const run = bureau.run('echo', 'hi');
        await run.result();
        expect(bureau.getRun(`${run.id}-unknown`)).toBeUndefined();
        expect(() => bureau.abortRun(`${run.id}-unknown`)).toThrow('Run not found');
      } finally {
        await bureau.dispose();
      }
    });
  });

  it('drops a released catalog run’s actions from the run store’s action log', async () => {
    // A long-lived bureau calls `bureau.run()` many times; each run's events
    // must leave the store with the run, not accumulate in its store-wide log.
    const store = createStore();
    const bureau = await createBureau({ agents: { echo: echoAgent() }, store });
    try {
      const first = bureau.run('echo', 'first');
      const second = bureau.run('echo', 'second');
      await Promise.all([first.result(), second.result()]);

      expect(bureau.getRun(first.id)).toBeUndefined();
      expect(bureau.getRun(second.id)).toBeUndefined();
      const loggedRunIds = store.getState().actions.map((action) => action.runId);
      expect(loggedRunIds).not.toContain(first.id);
      expect(loggedRunIds).not.toContain(second.id);
    } finally {
      await bureau.dispose();
    }
  });

  it('keeps catalog runs off the bureau event streams its consumers read', async () => {
    let judged = 0;
    const bureau = await createBureau({
      agents: { echo: echoAgent() },
      storage: { type: 'sqlite', path: nextDatabasePath() },
      durable: true,
      onlineEvals: {
        judges: [
          {
            name: 'counts',
            async evaluate() {
              judged += 1;
              return { pass: true, score: 1, message: 'counted' };
            },
          },
        ],
        sampleRate: 1,
        rng: () => 0,
      },
    });
    const observedRunIds = new Set<string>();
    const recordAction = (event: Event): void => {
      observedRunIds.add((event as Event & { action: { runId: string } }).action.runId);
    };
    const recordLifecycle = (event: Event): void => {
      observedRunIds.add((event as Event & { runId: string }).runId);
    };
    bureau.addEventListener('action', recordAction);
    bureau.addEventListener('run.registered', recordLifecycle);
    bureau.addEventListener('run.removed', recordLifecycle);
    try {
      const run = bureau.run('echo', 'hi', { principal: 'alice' });
      await run.result();
      await bureau.onlineEvalSampler?.flush();

      // The run was on the run store while it ran, but none of its actions,
      // nor its registration or release, reached a bureau listener, so the
      // online-eval judge (a model call in production) never ran for it.
      expect(observedRunIds.has(run.id)).toBe(false);
      expect(bureau.onlineEvalSampler?.observedCount()).toBe(0);
      expect(judged).toBe(0);
    } finally {
      bureau.removeEventListener('action', recordAction);
      bureau.removeEventListener('run.registered', recordLifecycle);
      bureau.removeEventListener('run.removed', recordLifecycle);
      await bureau.dispose();
    }
  });
});
