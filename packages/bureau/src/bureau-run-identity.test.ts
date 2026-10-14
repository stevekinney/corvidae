/**
 * COR-1302 — the handle `bureau.run()` returns carries its run's stable id.
 *
 * The id exists before the run does: `bureau.run()` returns synchronously,
 * ahead of the agent resolution and durable start it defers. These tests pin
 * that the id on the handle is the one its liveness snapshot reports from the
 * first instant, the one the durable workflow is stored under, and the one
 * Bureau's durable read surfaces (`getDurableRun`, `eventHistory`) resolve.
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
});
