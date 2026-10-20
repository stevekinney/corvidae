/**
 * Contract tests for `fixtures/engine-console.ts` (COR-1461, COR-1462, COR-1463), run against a REAL
 * `Engine`. `tests/e2e/32-run-attributes-streams-updates.spec.ts` assumes the seed produces three
 * states: a run whose attributes are of every type the console edits, a run with three stored stream
 * chunks, and a run whose update history holds one completed and one failed update, with a `slow`
 * handler that outlasts a one-second wait. If any of that stops being true the spec fails on a UI
 * assertion; these tests fail with the reason.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '@lostgradient/weft';

import {
  ATTRIBUTE_SHOWCASE_RUN_ID,
  CHUNK_STREAMER_RUN_ID,
  UPDATE_DESK_RUN_ID,
} from '../../../../fixtures/engine-console-ids.ts';
import {
  ATTRIBUTE_SHOWCASE_ATTRIBUTES,
  seedEngineConsole,
} from '../../../../fixtures/engine-console.ts';
import { workflows } from '../../../../fixtures/workflows.ts';

let engines: AsyncDisposable[] = [];

async function seededEngine() {
  const engine = await Engine.create({ workflows });
  engines.push(engine);
  await seedEngineConsole(engine);
  return engine;
}

type SeededEngine = Awaited<ReturnType<typeof seededEngine>>;
type Run = Awaited<ReturnType<SeededEngine['list']>>['items'][number];

async function runOfType(engine: SeededEngine, type: string): Promise<Run> {
  const { items } = await engine.list({ type });
  const run = items[0];
  if (items.length !== 1 || run === undefined) {
    throw new Error(`expected one ${type} run, found ${items.length}`);
  }
  return run;
}

afterEach(async () => {
  const pending = engines;
  engines = [];
  await Promise.all(pending.map((engine) => engine[Symbol.asyncDispose]()));
});

describe('seedEngineConsole', () => {
  it('starts a run whose attributes have every type the console edits, still running', async () => {
    const engine = await seededEngine();
    const run = await runOfType(engine, 'attribute-showcase');
    expect(run.id).toBe(ATTRIBUTE_SHOWCASE_RUN_ID);

    expect(run.status).toBe('running');
    const attributes = await engine.getAttributes(run.id);
    expect(attributes).toEqual({
      owner: 'ops-team',
      priority: 2,
      urgent: false,
      reviewBy: ATTRIBUTE_SHOWCASE_ATTRIBUTES.reviewBy,
      labels: ['quarterly', 'finance'],
    });
    expect(attributes?.['reviewBy']).toBeInstanceOf(Date);
  });

  it('starts a running run with three stored chunks in its progress stream', async () => {
    const engine = await seededEngine();
    const run = await runOfType(engine, 'chunk-streamer');
    expect(run.id).toBe(CHUNK_STREAMER_RUN_ID);

    expect(run.status).toBe('running');
    const chunks = await engine.getStreamChunks(run.id, 'progress');
    expect(chunks).toEqual([
      { sequence: 0, value: { stage: 'queued' } },
      { sequence: 1, value: { stage: 'running' } },
      { sequence: 2, value: { stage: 'verifying' } },
    ]);
  });

  it('lets each run end on its own signal, so none stays parked for good', async () => {
    const engine = await seededEngine();

    for (const [type, signal] of [
      ['attribute-showcase', 'finish'],
      ['chunk-streamer', 'finish'],
      ['update-desk', 'close'],
    ] as const) {
      const run = await runOfType(engine, type);
      await engine.signal(run.id, signal);
      const deadline = Date.now() + 2_000;
      let status = (await engine.get(run.id))?.status;
      while (status !== 'completed' && Date.now() < deadline) {
        await Bun.sleep(5);
        status = (await engine.get(run.id))?.status;
      }
      expect(status).toBe('completed');
    }
  });

  it('starts a run whose history holds one completed and one failed update', async () => {
    const engine = await seededEngine();
    const run = await runOfType(engine, 'update-desk');
    expect(run.id).toBe(UPDATE_DESK_RUN_ID);

    expect(run.status).toBe('running');
    const history = await engine.listUpdateHistory(run.id);
    expect(history.items.map((entry) => [entry.name, entry.outcome, entry.error])).toEqual([
      ['explode', 'failed', 'the desk refused this update'],
      ['greet', 'completed', undefined],
    ]);
  });
});
