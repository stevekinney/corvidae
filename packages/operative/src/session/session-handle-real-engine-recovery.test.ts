import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, type WorkflowState } from '@lostgradient/weft';
import type { Toolbox } from 'armorer';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { createCheckpointStore } from '../durable/checkpoint-store';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import {
  createParkedRunEngine,
  FAR_FUTURE_EPOCH_MILLISECONDS,
  waitForEventLoop,
  waitForParkedSleep,
} from './session-handle-test-support';

/**
 * AB-348: split out of `session-handle.test.ts` (originally AB-330, then
 * re-owned to this issue per the coordinator note on 2026-09-04 — same root
 * cause as this file's `create-run-engine-poller-unarmed.test.ts` and
 * `create-run-engine-crash-and-adopt.test.ts` siblings). The original form
 * drove a REAL Weft engine's `startScheduler: true` background poller (a
 * real interval) to fire a durable `ctx.sleep`, then polled `engine.get()`
 * with a real per-iteration `setTimeout` delay until the recovered run
 * settled.
 *
 * Both engines come from `createParkedRunEngine`: `startScheduler: false`, so
 * no real background poller is ever armed, and a frozen `getNow`, so the
 * durable `ctx.sleep` deadline is never measured against the host clock
 * (COR-1610 — on the host clock a loaded run outlived its sleep before the
 * sleep was processed, completed inline, and never wrote the timer this test
 * waits for). `engine.scheduler.tick(FAR_FUTURE_EPOCH_MILLISECONDS)` drives the
 * sleep past its deadline directly. Every wait afterward is a condition polled
 * on event-loop turns (`waitForEventLoop`, bounded), not a real `setTimeout`
 * delay.
 */

const fixtureRuntime = createManualRuntimeServices();

function createTestRunOptions() {
  return {
    generate: async () => ({ content: 'hello', toolCalls: [] }),
    toolbox: createToolbox([]) as unknown as Toolbox,
    maximumSteps: 1,
  };
}

describe('D2 — Recovery-on-boot: session.recover() durable re-attach path — real engine', () => {
  it('reconciles the RunRef against a REAL Weft engine when the recovered run settles before recover() is called', async () => {
    // The reproduction from the issue (CHR-15): process A crashes mid-run,
    // process B resumes it on boot, and it settles to terminal BEFORE the
    // host calls session.recover(). The fake-engine tests in
    // `session-handle.test.ts` assume a particular shape for engine.get()'s
    // `.result` on a completed workflow — this test exercises the REAL Weft
    // engine to prove that assumption.
    const storage = new MemoryStorage();
    const sessionId = 'ab-28-real-engine-session';
    const runId = `${sessionId}:0`;

    const firstKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const firstStore = createSessionStore(firstKv);
    const { engine: engine1 } = await createParkedRunEngine(storage, { recover: false });

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: sessionId,
      runs: [
        {
          runId,
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    });
    await firstStore.save(session);

    const firstHandle = await engine1.start('agentRun', {}, { id: runId });
    // Wait for the durable sleep timer before simulating a process crash.
    // Event-loop turns alone do not prove that the timer commit has finished.
    await waitForParkedSleep(storage, runId);
    engine1[Symbol.dispose]();
    void firstHandle.result().catch(() => {});

    const secondKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const secondStore = createSessionStore(secondKv);
    const secondCheckpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    // Default recover:true resumes the parked workflow during creation; no
    // real background poller is ever armed — the durable ctx.sleep is driven
    // directly below instead.
    const { engine: engine2 } = await createParkedRunEngine(storage);

    try {
      // Drive the recovered ctx.sleep past its deadline directly — no real
      // timer, no host-clock read. `Scheduler#tick` scans persisted `wf-deadline:`
      // storage keys directly (it is not gated on `Scheduler#start` ever
      // having run — `#stopped` starts `false`), so it works whether or not
      // `startScheduler` armed the real-time poller. Poll engine.get() until
      // the recovered run settles to terminal BEFORE calling recover() — the
      // exact race the issue describes. Event-loop-turn driven, not a real
      // timer delay; re-ticks the scheduler each attempt in case recovery's
      // own checkpoint write for the resumed sleep settles asynchronously
      // after `createRunEngine` returns.
      const stateBox: { current: WorkflowState | null } = { current: null };
      await waitForEventLoop(async () => {
        await engine2.scheduler.tick(FAR_FUTURE_EPOCH_MILLISECONDS);
        stateBox.current = await engine2.get(runId);
        const current = stateBox.current;
        return current !== null && current.status !== 'running' && current.status !== 'pending';
      });
      const state = stateBox.current;

      expect(state?.status).toBe('completed');
      // The real shape engine.get() returns .result in — this is exactly
      // what readTerminalRunOutcome() reads to derive the RunRef status.
      const summary = state?.result as { finishReason?: string | undefined } | undefined;
      expect(summary?.finishReason).toBe('stop-condition');

      const h = createSessionHandle(sessionId, {
        store: secondStore,
        agentName: 'agent',
        engine: engine2,
        checkpointStore: secondCheckpointStore,
        runOptions: createTestRunOptions(),
      });

      // recover() must still return null for a terminal run — reconciliation
      // is a side effect, not a resurrection into a live AgentRun.
      const reattached = await h.recover();
      expect(reattached).toBeNull();

      const persisted = await secondStore.load(sessionId);
      expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('completed');
    } finally {
      engine2[Symbol.dispose]();
    }
  });
});
