/**
 * COR-1614 — the holder's own AG-UI stream when another Bureau ends its run. Two Bureaus share one
 * SQLite store: A holds a run, and B cancels it or times it out. A's engine sees B's terminal
 * commit, and A settles its own run with that outcome, so the stream A's client opened ends with
 * the matching terminal. B published the session's status (a cancel) or nobody does (a timeout),
 * so A writes none. Every wait is on a condition or a frame, never a delay.
 */
import { EventType } from '@ag-ui/core';
import { describe, expect, it, spyOn } from 'bun:test';

import { savesSessionAs, textOf } from '../test/session-input-fixtures.ts';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  cancelRequest,
  type Harness,
  type HarnessOptions,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { bureauMetadata, FrameReader, typesOf } from './ag-ui-stream.test-support.ts';

/** A renewal interval short enough that each Bureau hears the other's commits promptly. */
const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;

const THREAD = 't';

const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});
const hold = (barrier: string) => ({ kind: 'block' as const, barrier });

/**
 * Runs `body` over a holder on SQLite with its own storage seam, and one peer of it. The holder's
 * engine losing its claim to the peer's terminal commit is reported as a process warning, which is
 * part of the scenario: it is captured, and any other warning, or any error either Bureau
 * diagnoses, fails the test.
 */
async function withHolderAndPeer(
  options: Omit<HarnessOptions, 'storage'>,
  body: (holder: Harness, peer: Harness) => Promise<void>,
): Promise<void> {
  const warnings: unknown[] = [];
  const errors: string[] = [];
  const emitWarning = spyOn(process, 'emitWarning').mockImplementation((warning) => {
    warnings.push(warning);
  });
  try {
    const holder = await openHarness({
      storage: 'sqlite',
      durableOwnership: OWNERSHIP,
      seamStorage: true,
      onDiagnostic: (diagnostic) => {
        if (diagnostic.level === 'error') errors.push(diagnostic.message);
      },
      ...options,
    });
    try {
      const peer = await holder.peer([]);
      try {
        await body(holder, peer);
      } finally {
        await peer.dispose();
      }
    } finally {
      await holder.dispose();
    }
  } finally {
    emitWarning.mockRestore();
  }
  for (const warning of warnings) {
    expect((warning as Error).name).toBe('WeftWorkflowClaimLostWarning');
  }
  // Settling the run is not allowed to cost either Bureau a failed write.
  expect(errors).toEqual([]);
}

/** Starts a run on `THREAD` through `handler`, and reads its stream to its first frame. */
async function startOn(
  handler: Harness['handler'],
): Promise<{ readonly reader: FrameReader; readonly nativeRunId: string }> {
  const reader = new FrameReader(
    await handler(
      startRequest(
        runAgentInput({
          threadId: THREAD,
          runId: 'client-run-1',
          messages: [{ id: 'user-1', role: 'user', content: 'hello' }],
        }),
      ),
    ),
  );
  const first = await reader.next();
  return { reader, nativeRunId: String(bureauMetadata(first!.event)['runId']) };
}

/** Records whether the holder ever records a terminal event of `runId` in the durable history. */
function watchTerminalHistoryWrite(holder: Harness, runId: string): () => boolean {
  let wrote = false;
  void holder
    .seam!.awaitWrite((operations) =>
      operations.some(
        (operation) =>
          operation.key.startsWith('fleet-event:') &&
          textOf(operation).includes(runId) &&
          ['run.aborted', 'run.error', 'run.completed'].some((kind) =>
            textOf(operation).includes(kind),
          ),
      ),
    )
    .then(() => {
      wrote = true;
    });
  return () => wrote;
}

/** Records whether the holder ever writes the session with `status` for `runId`. */
function watchSessionWrite(holder: Harness, status: string, runId: string): () => boolean {
  let wrote = false;
  const writes = savesSessionAs(status);
  void holder
    .seam!.awaitWrite(
      (operations) =>
        writes(operations) && operations.some((operation) => textOf(operation).includes(runId)),
    )
    .then(() => {
      wrote = true;
    });
  return () => wrote;
}

/**
 * The holder's wait for its terminal session save of `runId`, taken before the run ends: it
 * resolves once a save finishes, and rejects when the run ends without one starting.
 */
function recordOf(holder: Harness, runId: string): Promise<void> {
  const recorded = holder.bureau.internals.whenTaskRecorded(runId);
  recorded.catch(() => undefined);
  return recorded;
}

describe('the holder’s stream when another Bureau ends its run', () => {
  it('ends RUN_FINISHED cancelled when a peer cancels the run, and the holder records nothing of it', async () => {
    await withHolderAndPeer(
      { script: [hold('a-generating'), say('Never kept.')] },
      async (holder, peer) => {
        const started = await startOn(holder.handler);
        await holder.generate.reached('a-generating');
        const holderWroteAborted = watchSessionWrite(holder, 'aborted', started.nativeRunId);
        const recorded = recordOf(holder, started.nativeRunId);
        const holderRecordedEnd = watchTerminalHistoryWrite(holder, started.nativeRunId);

        const cancelled = await peer.handler(cancelRequest(started.nativeRunId));
        expect(cancelled.status).toBe(200);
        // The model call is still held: the stream ends on the peer's commit, not on the run moving.
        const rest = await started.reader.rest();

        expect(rest.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        expect(rest.at(-1)!.event).toMatchObject({ outcome: { type: 'cancelled' } });
        expect(typesOf(rest)).not.toContain(EventType.RUN_ERROR);
        expect(holder.bureau.tasks.detail(started.nativeRunId)?.status).toBe('aborted');
        // The holder never starts a terminal save: its record of the run is abandoned, not written.
        expect(await throwingRejectionOf(recorded)).toThrow('without its end being recorded');
        expect(holderWroteAborted()).toBe(false);
        expect(holderRecordedEnd()).toBe(false);
        const session = await peer.bureau.contexts.get(THREAD);
        expect(session?.metadata).toMatchObject({
          lastRunId: started.nativeRunId,
          lastRunStatus: 'aborted',
        });

        holder.generate.release('a-generating');
      },
    );
  });

  it('ends RUN_ERROR when a peer times the run out, and the holder records nothing of it', async () => {
    await withHolderAndPeer(
      { script: [hold('a-generating'), say('Never kept.')] },
      async (holder, peer) => {
        const started = await startOn(holder.handler);
        await holder.generate.reached('a-generating');
        const holderWroteError = watchSessionWrite(holder, 'error', started.nativeRunId);
        const recorded = recordOf(holder, started.nativeRunId);
        const holderRecordedEnd = watchTerminalHistoryWrite(holder, started.nativeRunId);

        await peer.bureau.durableEngine()!.timeout(started.nativeRunId);
        const rest = await started.reader.rest();

        expect(rest.at(-1)!.event.type).toBe(EventType.RUN_ERROR);
        expect(rest.at(-1)!.event).toMatchObject({ code: 'RUN_FAILED' });
        expect(holder.bureau.tasks.detail(started.nativeRunId)?.status).toBe('error');
        expect(await throwingRejectionOf(recorded)).toThrow('without its end being recorded');
        expect(holderWroteError()).toBe(false);
        expect(holderRecordedEnd()).toBe(false);
        // Nobody publishes a timeout's session status, the holder included.
        const session = await peer.bureau.contexts.get(THREAD);
        expect(session?.metadata['lastRunStatus']).toBe('running');

        holder.generate.release('a-generating');
      },
    );
  });
});
