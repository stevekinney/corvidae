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
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';

let databaseCounter = 0;
const databasePaths: string[] = [];

function nextDatabasePath(): string {
  const path = join(tmpdir(), `bureau-run-identity-${process.pid}-${databaseCounter++}.sqlite`);
  databasePaths.push(path);
  return path;
}

afterEach(async () => {
  for (const path of databasePaths.splice(0)) {
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
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
      durableExecution: true,
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

      const history = await bureau.eventHistory({ kind: 'run', id }, { principal: 'alice' });
      if ('outcome' in history) throw new Error(`expected a page, got ${history.outcome}`);
      // The run is registered on the run store, so its own actions are
      // recorded under the id its handle carries.
      expect(history.events.map((event) => event.kind)).toContain('run.completed');
      for (const event of history.events) {
        expect(event.owner).toEqual({ kind: 'run', id });
      }
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
                durableExecution: true,
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
          // (AB-241); registering the run does not widen that.
          expect(live?.principal).toBe(branch.durable ? 'alice' : undefined);

          // A catalog run has no bureau session, and `listRuns` keeps listing
          // only the runs `createRun` started (run listing is COR-1304's).
          expect(bureau.listRuns().map((summary) => summary.id)).not.toContain(run.id);

          expect(bureau.abortRun(run.id)).toMatchObject({ id: run.id, status: 'aborting' });
          gated.release();
          const result = await run.result();
          expect(result.finishReason).toBe('aborted');

          // The run stays readable after it settles, until `deleteRun`
          // releases it, exactly as a `createRun` run does.
          expect(bureau.getRun(run.id)?.status).toBe('aborted');
          expect(bureau.abortRun(run.id)).toMatchObject({ id: run.id, status: 'aborted' });
          await bureau.deleteRun(run.id);
          expect(bureau.getRun(run.id)).toBeUndefined();
        } finally {
          gated.release();
          await bureau.dispose();
        }
      });
    }

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
});
