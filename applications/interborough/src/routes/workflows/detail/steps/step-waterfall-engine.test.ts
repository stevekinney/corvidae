/**
 * The waterfall against a REAL `Engine`: a run that parks on `waitForSignal` and is signalled keeps
 * the parked entry as `running` for good, with settled entries after it. The page must not read that
 * entry as a step still going, while the run is in flight or after it ends.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '@lostgradient/weft';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { workflows } from '../../../../../fixtures/workflows.ts';
import { openStepNumbers, stepWaterfall } from './step-waterfall.ts';

let engines: AsyncDisposable[] = [];

afterEach(async () => {
  const pending = engines;
  engines = [];
  await Promise.all(pending.map((engine) => engine[Symbol.asyncDispose]()));
});

async function parkedRun() {
  const engine = await Engine.create({ workflows });
  engines.push(engine);
  const started = await engine.start('signal-stepped', { steps: 2 });
  const id = typeof started === 'string' ? started : started.id;
  await waitUntil(async () => {
    const timeline = await engine.getTimeline(id);
    return timeline.length >= 1;
  });
  return { engine, id };
}

describe('the waterfall of a run that waited for a signal', () => {
  it('closes the parked entry once the run moves on, while the run is still going', async () => {
    const { engine, id } = await parkedRun();
    await engine.signal(id, 'advance', {});
    await waitUntil(async () => {
      const timeline = await engine.getTimeline(id);
      return timeline.length >= 4;
    });
    const timeline = await engine.getTimeline(id);
    const state = await engine.get(id);

    // The engine keeps the first wait as it was written: running, with later entries after it.
    expect(timeline[0]).toMatchObject({ step: 1, operationType: 'wait-signal', status: 'running' });
    expect(state?.status).toBe('running');

    const parkedNow = timeline.at(-1)?.step ?? -1;
    expect(openStepNumbers(timeline, state?.status)).toEqual(new Set([parkedNow]));

    const bars = stepWaterfall(timeline, {
      runStartedAt: state?.createdAt,
      runStatus: state?.status,
      now: Date.now() + 3_600_000,
    });
    // Only the step the run is in is open; the first wait is closed, and so is the settled step after it.
    expect(bars.get(1)).toMatchObject({ open: false });
    expect(bars.get(parkedNow)).toMatchObject({ open: true });
    expect([...bars.values()].filter((bar) => bar.open)).toHaveLength(1);
  });

  it('has no open step once the run has finished', async () => {
    const { engine, id } = await parkedRun();
    await engine.signal(id, 'advance', {});
    await waitUntil(async () => {
      const timeline = await engine.getTimeline(id);
      return timeline.length >= 4;
    });
    await engine.signal(id, 'advance', {});
    await waitUntil(async () => {
      const current = await engine.get(id);
      return current?.status === 'completed';
    });
    const timeline = await engine.getTimeline(id);
    const state = await engine.get(id);

    expect(timeline.some((entry) => entry.status === 'running')).toBe(true);
    expect(openStepNumbers(timeline, state?.status).size).toBe(0);
    const bars = stepWaterfall(timeline, {
      runStartedAt: state?.createdAt,
      runStatus: state?.status,
      now: Date.now() + 3_600_000,
    });
    expect([...bars.values()].some((bar) => bar.open)).toBe(false);
  });
});
