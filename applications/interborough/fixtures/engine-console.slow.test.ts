/**
 * `update-desk`'s `slow` update (`fixtures/engine-console.ts`) really takes seconds to answer, which is
 * the point of it: `tests/e2e/30-run-attributes-streams-updates.spec.ts` sends it with a one-second
 * wait, sees the wait end, and then sees the answer land. This pins that behavior against a real
 * `Engine`, in the slow lane, because the handler's delay is real time. Nothing here asserts on how
 * long anything takes.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '@lostgradient/weft';

import { seedEngineConsole } from './engine-console.ts';
import { workflows } from './workflows.ts';

let engines: Engine[] = [];

afterEach(async () => {
  const pending = engines;
  engines = [];
  await Promise.all(pending.map((engine) => engine[Symbol.asyncDispose]()));
});

describe('seedEngineConsole slow update', () => {
  it('answers a slow update after the wait a form submission gives it has ended', async () => {
    const engine = await Engine.create({ workflows });
    engines.push(engine);
    await seedEngineConsole(engine);
    const { items } = await engine.list({ type: 'update-desk' });
    const run = items[0];
    if (run === undefined) throw new Error('no update-desk run was seeded');

    const timedOut = await engine
      .submitCoordinatedUpdate(run.id, 'slow', 'x', { timeout: 1_000 })
      .then(
        () => 'answered',
        (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
      );
    expect(timedOut).toBe('UpdateTimeoutError');

    const pending = await engine.listUpdateHistory(run.id, { limit: 1 });
    expect(pending.items[0]).toMatchObject({ name: 'slow', outcome: 'pending' });

    // The handler finishes on its own; the history entry and the stored result settle together.
    const updateId = pending.items[0]!.updateId;
    const deadline = Date.now() + 10_000;
    let settled = await engine.getUpdateResult(updateId);
    while (settled === null && Date.now() < deadline) {
      await Bun.sleep(100);
      settled = await engine.getUpdateResult(updateId);
    }
    expect(settled?.result).toBe('slow-done:x');
    const after = await engine.listUpdateHistory(run.id, { limit: 1 });
    expect(after.items[0]).toMatchObject({ name: 'slow', outcome: 'completed' });
  });
});
