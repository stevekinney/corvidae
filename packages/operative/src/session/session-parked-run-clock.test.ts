import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import {
  createParkedRunEngine,
  parkedSleepTimerKey,
  settleParkedRun,
  waitForEventLoop,
} from './session-handle-test-support';

const ONE_HOUR_MILLISECONDS = 3_600_000;

let restoreHostClock: (() => void) | undefined;

afterEach(() => {
  restoreHostClock?.();
  restoreHostClock = undefined;
});

/**
 * Make every host-clock read jump an hour, standing in for a host so loaded that
 * any amount of wall time passes between two steps of a run. Reads the real clock
 * once, as the base, and never again.
 */
function advanceHostClockAnHourPerRead(): void {
  const base = Date.now();
  let reads = 0;
  const spy = spyOn(Date, 'now').mockImplementation(() => {
    reads += 1;
    return base + reads * ONE_HOUR_MILLISECONDS;
  });
  restoreHostClock = () => spy.mockRestore();
}

describe('createParkedRunEngine — parked runs ignore the host clock (COR-1610)', () => {
  it('keeps the run parked on its durable sleep however far the host clock moves', async () => {
    // Installed before the engine is created: Weft captures `Date.now` when the engine is constructed.
    advanceHostClockAnHourPerRead();
    const storage = new MemoryStorage();
    const runId = 'parked-run-clock:0';
    const { engine } = await createParkedRunEngine(storage, { recover: false });

    try {
      const handle = await engine.start('agentRun', {}, { id: runId });
      void handle.result().catch(() => {});

      // On the host clock the sleep's deadline has passed before Weft processes
      // it, so the run completes inline and never writes its timer. Wait for
      // either outcome, then require the parked one.
      await waitForEventLoop(async () => {
        if (await storage.has(parkedSleepTimerKey(runId))) return true;
        const state = await engine.get(runId);
        return state !== null && state.status !== 'running' && state.status !== 'pending';
      });
      const parkedState = await engine.get(runId);
      expect(parkedState?.status).toBe('running');
      expect(await storage.has(parkedSleepTimerKey(runId))).toBe(true);

      // Only an explicit scheduler tick fires the parked sleep.
      await settleParkedRun(engine, runId);
      const firedState = await engine.get(runId);
      expect(firedState?.status).toBe('completed');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
