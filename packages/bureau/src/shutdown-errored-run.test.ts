/**
 * COR-1580 follow-up — a graceful dispose that lands between a failed run's `run.error` and the
 * durable commit of its workflow. Operative reports the error first and dispatches the
 * `run.completed` that saves the session's terminal status only once the workflow's result
 * settles, so a dispose that disposed the engine in that gap rejected the result, took the crash
 * path, and left the session saying `running` over a durable run that completed.
 */
import { EventType } from '@ag-ui/core';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type BatchOperation, yieldToPortableEventLoop } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS } from './create-bureau.ts';
import { openHarness, runAgentInput, startRequest } from './http/ag-ui-fixtures.test-support.ts';
import { readAgUiStream } from './http/ag-ui-stream.test-support.ts';
import { pollUntil } from './test/session-input-fixtures.ts';

/** The durable engine's commit of a completed workflow: the write that moves it into the status index. */
function commitsCompletion(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) => operation.type === 'put' && operation.key.startsWith('wf-idx-status:completed:'),
  );
}

/** A write that releases a workflow claim, as disposing the engine does for each claim it holds. */
function releasesClaim(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) => operation.type === 'delete' && operation.key.startsWith('wf-owner-holder:'),
  );
}

describe('a graceful dispose between a run’s error and its durable commit', () => {
  it('still saves the session’s terminal status, which a restart then reads', async () => {
    const clock = createManualRuntimeServices({ origin: new Date().toISOString() });
    const harness = await openHarness({
      script: [{ kind: 'fail', error: new Error('provider said no') }],
      storage: 'sqlite',
      seamStorage: true,
      bureauRuntime: clock,
    });
    // The run reports its error, and the engine's commit of the workflow is held.
    const commit = harness.seam!.holdWrite(commitsCompletion);
    const failed = await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
    await commit.reached;

    let claimReleased = false;
    void harness.seam!.awaitWrite(releasesClaim).then(() => {
      claimReleased = true;
    });
    const disposing = harness.bureau.dispose();
    // Either the dispose waits for the run (its bounded grace is armed on the Bureau's clock), or
    // it has disposed the engine, which releases the run's claim, in the gap.
    const graceDue = clock.monotonic.now() + ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS;
    await pollUntil(
      () => claimReleased || clock.pendingTimers().some((timer) => timer.dueAt === graceDue),
    );
    const engineDisposedInTheGap = claimReleased;
    commit.release();
    await disposing;

    const restarted = await harness.restart([]);
    try {
      const session = await restarted.bureau.contexts.get('thread-1');
      expect(failed.at(-1)!.event.type).toBe(EventType.RUN_ERROR);
      expect(session?.metadata['lastRunStatus']).toBe('error');
      expect(engineDisposedInTheGap).toBe(false);
    } finally {
      await restarted.dispose();
    }
  });

  it('detach waits for an errored run to commit before disposing its durable engine', async () => {
    const clock = createManualRuntimeServices({ origin: new Date().toISOString() });
    const harness = await openHarness({
      script: [{ kind: 'fail', error: new Error('provider said no') }],
      storage: 'sqlite',
      seamStorage: true,
      bureauRuntime: clock,
    });
    const commit = harness.seam!.holdWrite(commitsCompletion);
    const failed = await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
    await commit.reached;

    let claimReleased = false;
    void harness.seam!.awaitWrite(releasesClaim).then(() => {
      claimReleased = true;
    });
    const shuttingDown = harness.bureau.shutdown({ policy: 'detach' });
    for (let tick = 0; tick < 20; tick += 1) await yieldToPortableEventLoop();
    expect(claimReleased).toBe(false);
    commit.release();
    const report = await shuttingDown;
    expect(report.detached).toBe(0);
    expect(report.owners).toContainEqual({ kind: 'durable-engine', outcome: 'completed' });

    const restarted = await harness.restart([]);
    try {
      const session = await restarted.bureau.contexts.get('thread-1');
      expect(failed.at(-1)!.event.type).toBe(EventType.RUN_ERROR);
      expect(session?.metadata['lastRunStatus']).toBe('error');
    } finally {
      await restarted.dispose();
    }
  });
});
