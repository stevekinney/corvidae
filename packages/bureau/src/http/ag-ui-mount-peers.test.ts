/**
 * COR-1580 — the AG-UI routes served by a Bureau that does not hold the run they name. Two (or
 * three) Bureaus share one SQLite store and nothing else: A holds the run, and B answers the
 * request from durable state as A would. Every wait is on a condition or a frame, never a delay.
 */
import { EventType, type ResumeEntry } from '@ag-ui/core';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
} from '@lostgradient/memory';
import { type InputDetector, stopWhen, type Toolbox } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import {
  bufferedSignals,
  deferred,
  pollUntil,
  savesSessionAs,
  textOf,
} from '../test/session-input-fixtures.ts';
import {
  as,
  attachRunRequest,
  attachThreadRequest,
  authentication,
  cancelRequest,
  type Harness,
  type HarnessOptions,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import {
  PEER_PARK_RECHECK_INTERVAL_MS,
  PEER_SESSION_SETTLE_GRACE_MS,
} from './ag-ui-peer-stream.ts';
import {
  bureauMetadata,
  FrameReader,
  readAgUiStream,
  type ReceivedFrame,
  typesOf,
} from './ag-ui-stream.test-support.ts';

/** A renewal interval short enough that each Bureau hears the other's commits promptly. */
const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;

const THREAD = 't';
const SECRET = 'ag-ui-peers-secret';

const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});
const hold = (barrier: string) => ({ kind: 'block' as const, barrier });
const askHuman = {
  kind: 'respond' as const,
  response: {
    content: 'Asking.',
    toolCalls: [
      {
        id: 'call-1',
        name: 'requestHumanInput',
        arguments: { signalName: 'human-response', prompt: 'Which environment?' },
      },
    ],
  },
};
const chargeOnce = {
  kind: 'respond' as const,
  response: {
    content: 'Charging.',
    toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
  },
};

/** Every call of `charge-card` needs approval. */
function approvalToolbox(): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret: SECRET,
      policy: {
        beforeExecute: () => ({
          allow: false as const,
          status: 'needs_approval' as const,
          reason: 'Operator approval required',
          action: { message: 'Approve charge' },
        }),
      },
    },
  ) as unknown as Toolbox;
}

const humanWaits = {
  stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
} as const;

/**
 * Runs `body` over a harness on SQLite with a short claim renewal interval. A run cancelled or
 * timed out by another process makes its holder's engine lose its claim, which Weft reports as a
 * process warning: that is part of the scenario, so it is captured rather than let reach stderr,
 * and any other warning fails the test.
 */
async function withPeers<T>(
  options: Omit<HarnessOptions, 'storage'>,
  body: (harness: Harness, warnings: readonly unknown[]) => Promise<T>,
): Promise<T> {
  const warnings: unknown[] = [];
  const emitWarning = spyOn(process, 'emitWarning').mockImplementation((warning) => {
    warnings.push(warning);
  });
  let result: T;
  try {
    const harness = await openHarness({
      storage: 'sqlite',
      durableOwnership: OWNERSHIP,
      ...options,
    });
    try {
      result = await body(harness, warnings);
    } finally {
      await harness.dispose();
    }
  } finally {
    emitWarning.mockRestore();
  }
  // Checked only once the body has passed, so a body's own failure is the one reported.
  for (const warning of warnings) {
    expect((warning as Error).name).toBe('WeftWorkflowClaimLostWarning');
  }
  return result;
}

/** Opens a peer of `harness` and disposes it after `body`. */
async function withPeer<T>(
  harness: Harness,
  body: (peer: Harness) => Promise<T>,
  agUi?: Parameters<Harness['peer']>[1],
  script: Parameters<Harness['peer']>[0] = [],
): Promise<T> {
  const peer = await harness.peer(script, agUi);
  try {
    return await body(peer);
  } finally {
    await peer.dispose();
  }
}

/** Starts a run on `THREAD` through `handler`, and reads its stream to its first frame. */
async function startOn(
  handler: Harness['handler'],
  headers: Record<string, string> = {},
  runId = 'client-run-1',
  content = 'hello',
): Promise<{ readonly reader: FrameReader; readonly nativeRunId: string }> {
  const reader = new FrameReader(
    await handler(
      startRequest(
        runAgentInput({
          threadId: THREAD,
          runId,
          messages: [{ id: `user-${runId}`, role: 'user', content }],
        }),
        headers,
      ),
    ),
  );
  const first = await reader.next();
  return { reader, nativeRunId: String(bureauMetadata(first!.event)['runId']) };
}

/** Reads the opening of an attach: `RUN_STARTED`, `MESSAGES_SNAPSHOT`, `STATE_SNAPSHOT`. */
async function opening(reader: FrameReader): Promise<ReceivedFrame[]> {
  return [(await reader.next())!, (await reader.next())!, (await reader.next())!];
}

function snapshotOf(frame: ReceivedFrame): Record<string, unknown> {
  return (frame.event as unknown as { snapshot: Record<string, unknown> }).snapshot;
}

function messageTexts(frame: ReceivedFrame | undefined): string[] {
  const messages = (frame?.event as { messages?: Array<{ content?: unknown }> } | undefined)
    ?.messages;
  return (messages ?? []).map((message) =>
    typeof message.content === 'string' ? message.content : '',
  );
}

function resumeRequest(
  entries: ResumeEntry[],
  runId: string,
  headers: Record<string, string> = {},
): Request {
  return startRequest(
    runAgentInput({ threadId: THREAD, runId, messages: [], resume: entries }),
    headers,
  );
}

const answer = (interruptId: string, value: string): ResumeEntry => ({
  interruptId,
  status: 'resolved',
  payload: { decision: 'approve', answer: value },
});

/** How many human waits `bureau` reads the run as parked on. */
async function waitsOn(harness: Harness, runId: string): Promise<number> {
  const waits = await harness.bureau.reviews.pendingOf(runId);
  return waits.length;
}

async function durableStatus(harness: Harness, runId: string): Promise<string | undefined> {
  const state = await harness.bureau.tasks.workflow(runId);
  return state?.status;
}

async function sessionMetadata(harness: Harness) {
  const session = await harness.bureau.contexts.get(THREAD);
  return session?.metadata;
}

/** Every user-visible text the model was shown on its last call. */
function lastRequestText(harness: Harness): string {
  return JSON.stringify(harness.generate.calls.at(-1)?.context.conversation.getMessages() ?? []);
}

describe('attach and stream on a peer', () => {
  it('attaches a peer to a thread whose run another Bureau holds, and ends with its outcome', async () => {
    await withPeers({ script: [hold('a-generating'), say('A replied.')] }, async (harness) => {
      await withPeer(harness, async (peer) => {
        const started = await startOn(harness.handler);
        await harness.generate.reached('a-generating');

        const attached = new FrameReader(await peer.handler(attachThreadRequest(THREAD)));
        const opened = await opening(attached);
        harness.generate.release('a-generating');
        const rest = await attached.rest();
        await started.reader.rest();

        expect(typesOf(opened)).toEqual([
          EventType.RUN_STARTED,
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_SNAPSHOT,
        ]);
        expect(snapshotOf(opened[2]!)).toMatchObject({ status: 'running' });
        expect(typesOf(rest)).toEqual([EventType.MESSAGES_SNAPSHOT, EventType.RUN_FINISHED]);
        expect(messageTexts(rest[0])).toContain('A replied.');
        expect(rest[1]!.event).toMatchObject({ outcome: { type: 'success' } });
      });
    });
  });

  it('attaches a peer to a run by id', async () => {
    await withPeers({ script: [hold('a-generating'), say('A replied.')] }, async (harness) => {
      await withPeer(harness, async (peer) => {
        const started = await startOn(harness.handler);
        await harness.generate.reached('a-generating');

        const attached = new FrameReader(await peer.handler(attachRunRequest(started.nativeRunId)));
        const opened = await opening(attached);
        harness.generate.release('a-generating');
        const rest = await attached.rest();
        await started.reader.rest();

        expect(typesOf(opened)).toEqual([
          EventType.RUN_STARTED,
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_SNAPSHOT,
        ]);
        expect(opened[0]!.event).toMatchObject({ threadId: THREAD, runId: started.nativeRunId });
        expect(snapshotOf(opened[2]!)).toMatchObject({ status: 'running' });
        expect(typesOf(rest)).toEqual([EventType.MESSAGES_SNAPSHOT, EventType.RUN_FINISHED]);
        expect(messageTexts(rest[0])).toContain('A replied.');
        expect(rest[1]!.event).toMatchObject({ outcome: { type: 'success' } });
      });
    });
  });

  it('ends a peer’s stream with the tripwire label when the run tripped one', async () => {
    const reached = deferred();
    const trip = deferred();
    const detector: InputDetector = {
      name: 'trips-when-told',
      detect: async () => {
        reached.resolve();
        await trip.promise;
        return { triggered: true, category: 'prompt-injection', confidence: 0.99 };
      },
    };
    await withPeers(
      {
        script: [say('Never said.')],
        guardrails: { mode: 'tripwire', input: { detectors: [detector] } },
      },
      async (harness) => {
        await withPeer(harness, async (peer) => {
          const started = await startOn(harness.handler);
          await reached.promise;

          const attached = new FrameReader(await peer.handler(attachThreadRequest(THREAD)));
          await opening(attached);
          trip.resolve();
          const rest = await attached.rest();
          await started.reader.rest();

          expect(bureauMetadata(rest.at(-1)!.event)['tripwire']).toBe(true);
          expect(rest.at(-2)!.event.type).toBe(EventType.MESSAGES_SNAPSHOT);
        });
      },
    );
  });

  it('ends a peer’s stream on a parked run with its interrupt', async () => {
    await withPeers({ script: [askHuman], ...humanWaits }, async (harness) => {
      await withPeer(harness, async (peer) => {
        const started = await startOn(harness.handler);
        await started.reader.rest();
        const [parked] = harness.bureau.reviews.list();
        await pollUntil(async () => (await waitsOn(peer, started.nativeRunId)) > 0);

        const frames = await readAgUiStream(await peer.handler(attachThreadRequest(THREAD)));

        const state = frames.find((frame) => frame.event.type === EventType.STATE_SNAPSHOT)!;
        expect(snapshotOf(state)['pendingInterruptIds']).toEqual([parked!.id]);
        expect(frames.at(-1)!.event).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: 'interrupt', interrupts: [{ id: parked!.id }] },
        });
      });
    });
  });

  it('attaches a peer to a settled run with a pending approval it never restored', async () => {
    await withPeers({ script: [chargeOnce], toolbox: approvalToolbox() }, async (harness) => {
      await withPeer(harness, async (peer) => {
        const started = await startOn(harness.handler);
        await started.reader.rest();
        const [approval] = harness.bureau.reviews.list();
        expect(peer.bureau.reviews.list()).toEqual([]);

        const frames = await readAgUiStream(await peer.handler(attachThreadRequest(THREAD)));

        expect(typesOf(frames)).toEqual([
          EventType.RUN_STARTED,
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_SNAPSHOT,
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
          EventType.RUN_FINISHED,
        ]);
        expect(frames[3]!.event).toMatchObject({
          toolCallId: 'call-1',
          toolCallName: 'charge-card',
        });
        expect(frames.at(-1)!.event).toMatchObject({
          outcome: { type: 'interrupt', interrupts: [{ id: approval!.id }] },
        });
      });
    });
  });

  it('ends a peer’s attach to a run cancelled by another peer as cancelled', async () => {
    await withPeers({ script: [hold('a-generating'), say('Never kept.')] }, async (harness) => {
      await withPeer(harness, async (peer) => {
        await withPeer(harness, async (canceller) => {
          const started = await startOn(harness.handler);
          await harness.generate.reached('a-generating');
          const attached = new FrameReader(await peer.handler(attachThreadRequest(THREAD)));
          await opening(attached);

          const cancelled = await canceller.handler(cancelRequest(started.nativeRunId));
          const rest = await attached.rest();
          harness.generate.release('a-generating');
          await started.reader.cancel();

          expect(cancelled.status).toBe(200);
          expect(typesOf(rest)).toEqual([EventType.MESSAGES_SNAPSHOT, EventType.RUN_FINISHED]);
          expect(rest.at(-1)!.event).toMatchObject({ outcome: { type: 'cancelled' } });
        });
      });
    });
  });

  it('ends a peer’s stream on a timed-out run after the settle grace', async () => {
    const clock = createManualRuntimeServices();
    await withPeers({ script: [hold('a-generating'), say('Never kept.')] }, async (harness) => {
      await withPeer(
        harness,
        async (peer) => {
          const started = await startOn(harness.handler);
          await harness.generate.reached('a-generating');
          const attached = new FrameReader(await peer.handler(attachThreadRequest(THREAD)));
          await opening(attached);
          let more = false;
          const next = attached.next().then((frame) => {
            more = true;
            return frame;
          });

          await peer.bureau.durableEngine()!.timeout(started.nativeRunId);
          // The stream knows the outcome and waits out the grace on the mount's clock for a
          // terminal session save that never comes.
          const graceDue = clock.monotonic.now() + PEER_SESSION_SETTLE_GRACE_MS;
          await pollUntil(() => clock.pendingTimers().some((timer) => timer.dueAt === graceDue));
          const session = await peer.bureau.contexts.get(THREAD);
          expect(session?.metadata['lastRunStatus']).toBe('running');
          expect(more).toBe(false);

          await clock.advance(PEER_SESSION_SETTLE_GRACE_MS);
          const snapshot = await next;
          const rest = await attached.rest();
          harness.generate.release('a-generating');
          await started.reader.cancel();

          expect(snapshot?.event.type).toBe(EventType.MESSAGES_SNAPSHOT);
          expect(typesOf(rest)).toEqual([EventType.RUN_ERROR]);
          expect(rest[0]!.event).toMatchObject({ code: 'RUN_FAILED' });
        },
        { runtime: clock },
      );
    });
  });
});

describe('a peer stream of a run that settled before it opened', () => {
  it('waits for the holder’s terminal session save still in flight, and ends once it lands', async () => {
    const clock = createManualRuntimeServices();
    await withPeers(
      { script: [hold('a-generating'), say('A replied.')], seamStorage: true },
      async (harness) => {
        await withPeer(
          harness,
          async (peer) => {
            const started = await startOn(harness.handler);
            await harness.generate.reached('a-generating');
            // The holder's terminal session save is held: its durable run settles first.
            const save = harness.seam!.holdWrite(savesSessionAs('completed'));
            harness.generate.release('a-generating');
            await save.reached;
            await pollUntil(
              async () => (await durableStatus(peer, started.nativeRunId)) === 'completed',
            );

            // The same start, retried on the peer, streams the settled run.
            const retried = new FrameReader(
              await peer.handler(
                startRequest(
                  runAgentInput({
                    threadId: THREAD,
                    runId: 'client-run-1',
                    messages: [{ id: 'user-client-run-1', role: 'user', content: 'hello' }],
                  }),
                ),
              ),
            );
            let ended = false;
            const rest = retried.rest().then((frames) => {
              ended = true;
              return frames;
            });
            const graceDue = clock.monotonic.now() + PEER_SESSION_SETTLE_GRACE_MS;
            await pollUntil(() => clock.pendingTimers().some((timer) => timer.dueAt === graceDue));
            expect(ended).toBe(false);

            save.release();
            const frames = await rest;
            await started.reader.rest();

            const snapshots = frames.filter(
              (frame) => frame.event.type === EventType.MESSAGES_SNAPSHOT,
            );
            expect(messageTexts(snapshots.at(-1))).toContain('A replied.');
            expect(frames.at(-1)!.event).toMatchObject({
              type: EventType.RUN_FINISHED,
              outcome: { type: 'success' },
            });
            // It ended on the save, not on the grace: the mount's clock never moved.
            expect(clock.monotonic.now()).toBe(graceDue - PEER_SESSION_SETTLE_GRACE_MS);
          },
          { runtime: clock },
        );
      },
    );
  });

  it('waits out the settle grace for a session a stopped process left saying running', async () => {
    const clock = createManualRuntimeServices();
    await withPeers(
      { script: [{ kind: 'fail', error: new Error('provider said no') }] },
      async (harness) => {
        const start = () => startRequest(runAgentInput({ threadId: THREAD }));
        await readAgUiStream(await harness.handler(start()));
        const restarted = await harness.restart([], { runtime: clock });
        try {
          // A process that crashed before its terminal save leaves the session saying `running`
          // for a run whose durable record has settled, and no durable state tells that apart
          // from a holder whose save is still on its way.
          await restarted.bureau.internals.sessionStore!.update(THREAD, (session) =>
            session === undefined
              ? undefined
              : { ...session, metadata: { ...session.metadata, lastRunStatus: 'running' } },
          );

          let replay: ReceivedFrame[] | undefined;
          void readAgUiStream(await restarted.handler(start())).then((frames) => {
            replay = frames;
          });
          const graceDue = clock.monotonic.now() + PEER_SESSION_SETTLE_GRACE_MS;
          await pollUntil(() => clock.pendingTimers().some((timer) => timer.dueAt === graceDue));
          expect(replay).toBeUndefined();

          await clock.advance(PEER_SESSION_SETTLE_GRACE_MS);
          await pollUntil(() => replay !== undefined);

          expect(replay!.at(-1)!.event).toMatchObject({
            type: EventType.RUN_ERROR,
            message: expect.stringContaining('provider said no'),
          });
        } finally {
          await restarted.dispose();
        }
      },
    );
  });
});

describe('the owner of record on a peer', () => {
  it('names the owner of a session run another Bureau created', async () => {
    await withPeers(
      { script: [hold('a-generating'), say('A replied.')], authentication },
      async (harness) => {
        await withPeer(harness, async (peer) => {
          const started = await startOn(harness.handler, as('alice-key'));
          await harness.generate.reached('a-generating');

          const owner = await peer.bureau.getOwner({ kind: 'run', id: started.nativeRunId });
          harness.generate.release('a-generating');
          await started.reader.rest();

          expect(owner).toBe('api-key:alice');
        });
      },
    );
  });

  it('refuses a stranger on a peer exactly as a missing run', async () => {
    await withPeers(
      { script: [hold('a-generating'), say('A replied.')], authentication },
      async (harness) => {
        await withPeer(harness, async (peer) => {
          const started = await startOn(harness.handler, as('alice-key'));
          await harness.generate.reached('a-generating');

          const attached = await readAgUiStream(
            await peer.handler(attachRunRequest(started.nativeRunId, as('bob-key'))),
          );
          const cancelled = await peer.handler(cancelRequest(started.nativeRunId, as('bob-key')));
          harness.generate.release('a-generating');
          await started.reader.rest();

          expect(attached).toHaveLength(1);
          expect(attached[0]!.event).toMatchObject({
            type: EventType.RUN_ERROR,
            code: 'RUN_NOT_FOUND',
          });
          expect(cancelled.status).toBe(404);
          expect(await cancelled.json()).toMatchObject({ code: 'NotFound' });
        });
      },
    );
  });
});

describe('cancel on a peer', () => {
  it('cancels a run another Bureau holds, and publishes it once', async () => {
    await withPeers(
      {
        script: [hold('a-generating'), say('Never kept.'), say('From the holder.')],
        seamStorage: true,
      },
      async (harness, warnings) => {
        await withPeer(
          harness,
          async (peer) => {
            const started = await startOn(harness.handler);
            await harness.generate.reached('a-generating');
            const holding = await harness.bureau.contexts.get(THREAD);
            const before = holding!.conversationHistory.ids;
            let holderWroteAborted = false;
            const abortsThisRun = savesSessionAs('aborted');
            void harness
              .seam!.awaitWrite(
                (operations) =>
                  abortsThisRun(operations) &&
                  operations.some((operation) => textOf(operation).includes(started.nativeRunId)),
              )
              .then(() => {
                holderWroteAborted = true;
              });

            const response = await peer.handler(cancelRequest(started.nativeRunId));
            const body = await response.json();
            harness.generate.release('a-generating');
            // The holder sees another engine's terminal commit and writes nothing, its own stream
            // included, so its client is let go.
            await started.reader.cancel();
            // The holder has seen the foreign terminal commit: its engine let the run go.
            await pollUntil(() =>
              warnings.some((warning) => (warning as Error).message.includes(started.nativeRunId)),
            );
            expect(holderWroteAborted).toBe(false);

            expect(response.status).toBe(200);
            expect(body).toEqual({ runId: started.nativeRunId, status: 'aborting' });
            expect(await durableStatus(harness, started.nativeRunId)).toBe('cancelled');
            expect(await durableStatus(peer, started.nativeRunId)).toBe('cancelled');
            const session = await peer.bureau.contexts.get(THREAD);
            expect(session?.metadata).toMatchObject({
              lastRunId: started.nativeRunId,
              lastRunStatus: 'aborted',
              lastFinishReason: 'aborted',
            });
            expect(session?.conversationHistory.ids).toEqual(before);

            // The thread is free: a start from the peer is admitted, and then one from the holder.
            const fromPeer = await startOn(peer.handler, {}, 'client-run-2', 'again');
            const peerFrames = await fromPeer.reader.rest();
            const fromHolder = await startOn(harness.handler, {}, 'client-run-3', 'once more');
            const holderFrames = await fromHolder.reader.rest();
            expect(peerFrames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
            expect(holderFrames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
          },
          undefined,
          [say('From the peer.')],
        );
      },
    );
  });

  it('answers an already-terminal run’s status from a peer', async () => {
    await withPeers(
      {
        script: [
          say('Done.'),
          { kind: 'fail', error: new Error('model down') },
          hold('third'),
          say('Never kept.'),
        ],
      },
      async (harness) => {
        await withPeer(harness, async (peer) => {
          const run = async (threadId: string) => {
            const reader = new FrameReader(
              await harness.handler(
                startRequest(
                  runAgentInput({
                    threadId,
                    runId: `client-${threadId}`,
                    messages: [{ id: `user-${threadId}`, role: 'user', content: 'go' }],
                  }),
                ),
              ),
            );
            const first = await reader.next();
            return { reader, nativeRunId: String(bureauMetadata(first!.event)['runId']) };
          };
          const completed = await run('t-completed');
          await completed.reader.rest();
          const failed = await run('t-failed');
          await failed.reader.rest();
          const cancelled = await run('t-cancelled');
          await harness.generate.reached('third');
          const cancelling = await peer.handler(cancelRequest(cancelled.nativeRunId));
          expect(cancelling.status).toBe(200);
          harness.generate.release('third');
          await cancelled.reader.cancel();
          for (const id of [completed.nativeRunId, failed.nativeRunId]) {
            await pollUntil(async () => (await durableStatus(peer, id)) !== 'running');
          }

          const statusOf = async (runId: string) => {
            const response = await peer.handler(cancelRequest(runId));
            return (await response.json()) as { runId: string; status: string };
          };
          expect(await statusOf(completed.nativeRunId)).toEqual({
            runId: completed.nativeRunId,
            status: 'completed',
          });
          expect(await statusOf(cancelled.nativeRunId)).toEqual({
            runId: cancelled.nativeRunId,
            status: 'aborted',
          });
          expect(await statusOf(failed.nativeRunId)).toEqual({
            runId: failed.nativeRunId,
            status: 'error',
          });
        });
      },
    );
  });

  it('answers cancel of an unknown run on a peer with NotFound', async () => {
    await withPeers({ script: [] }, async (harness) => {
      await withPeer(harness, async (peer) => {
        const response = await peer.handler(cancelRequest('run-that-never-was'));

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'NotFound' });
      });
    });
  });

  it('does not overwrite a newer run’s status when publishing a cancel', async () => {
    await withPeers(
      { script: [hold('a-generating'), say('Never kept.'), say('Newer.')], seamStorage: true },
      async (harness) => {
        await withPeer(harness, async (peer) => {
          const started = await startOn(harness.handler);
          await harness.generate.reached('a-generating');
          const publication = peer.seam!.holdWrite(savesSessionAs('aborted'));

          const cancelling = peer.handler(cancelRequest(started.nativeRunId));
          await publication.reached;
          harness.generate.release('a-generating');
          await started.reader.cancel();
          const newer = await startOn(harness.handler, {}, 'client-run-2', 'again');
          await newer.reader.rest();
          await pollUntil(async () => {
            const metadata = await sessionMetadata(peer);
            return (
              metadata?.['lastRunId'] === newer.nativeRunId &&
              metadata['lastRunStatus'] !== 'running'
            );
          });
          const newerSettled = await sessionMetadata(peer);
          const settled = newerSettled?.['lastRunStatus'];
          publication.release();
          const response = await cancelling;

          expect(response.status).toBe(200);
          const session = await peer.bureau.contexts.get(THREAD);
          expect(session?.metadata['lastRunId']).toBe(newer.nativeRunId);
          expect(session?.metadata['lastRunStatus']).toBe(settled);
          expect(settled).not.toBe('aborted');
        });
      },
    );
  });
});

describe('resume on a peer', () => {
  /** A's run on `THREAD`, parked on a human wait, with its review as A lists it. */
  async function parkedInA(harness: Harness, peer: Harness) {
    const started = await startOn(harness.handler);
    await started.reader.rest();
    const [review] = harness.bureau.reviews.list();
    await pollUntil(async () => (await waitsOn(peer, started.nativeRunId)) > 0);
    return { nativeRunId: started.nativeRunId, reviewId: review!.id };
  }

  it('delivers a resume on a peer to a human wait another Bureau holds, and streams the run onward', async () => {
    await withPeers(
      { script: [askHuman, say('Deploying to staging.')], seamStorage: true, ...humanWaits },
      async (harness) => {
        await withPeer(harness, async (peer) => {
          const parked = await parkedInA(harness, peer);

          const frames = await readAgUiStream(
            await peer.handler(resumeRequest([answer(parked.reviewId, 'staging')], 'client-run-2')),
          );

          // The answer is a row of the opening snapshot, and no user-role text is streamed for it.
          expect(typesOf(frames)).toEqual([
            EventType.RUN_STARTED,
            EventType.MESSAGES_SNAPSHOT,
            EventType.STATE_SNAPSHOT,
            EventType.MESSAGES_SNAPSHOT,
            EventType.RUN_FINISHED,
          ]);
          const answerRow = (
            frames[1]!.event as { messages: Array<{ id: string; role: string; content: string }> }
          ).messages.find(
            (message) => message.id === `${parked.nativeRunId}:signal:human-response:0`,
          );
          expect(answerRow).toMatchObject({ role: 'user' });
          expect(String(answerRow?.content)).toContain('staging');
          expect(messageTexts(frames[3])).toContain('Deploying to staging.');
          expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
          expect(harness.generate.calls).toHaveLength(2);
          expect(lastRequestText(harness)).toContain('staging');
          expect(harness.bureau.reviews.list()).toEqual([]);
          // One answer was delivered, and the run took it: nothing is left buffered.
          expect(await bufferedSignals(harness.seam!.storage, parked.nativeRunId)).toEqual([]);
        });
      },
    );
  });

  it('answers a different resume RUN_FAILED while the first holds the command lease', async () => {
    await withPeers({ script: [askHuman, say('Deploying.')], ...humanWaits }, async (harness) => {
      await withPeer(harness, async (peer) => {
        const parked = await parkedInA(harness, peer);
        const reached = deferred();
        const held = deferred();
        const real = harness.bureau.reviews.resolve.bind(harness.bureau);
        spyOn(harness.bureau.reviews, 'resolve').mockImplementationOnce(async (input) => {
          reached.resolve();
          await held.promise;
          return real(input);
        });

        const first = harness.handler(
          resumeRequest([answer(parked.reviewId, 'staging')], 'client-run-2'),
        );
        await reached.promise;
        const second = await readAgUiStream(
          await peer.handler(
            resumeRequest([answer(parked.reviewId, 'production')], 'client-run-3'),
          ),
        );
        held.resolve();
        await readAgUiStream(await first);

        expect(second).toHaveLength(1);
        expect(second[0]!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'RUN_FAILED',
          message: 'An earlier attempt at this resume is still being applied; try again shortly',
        });
        expect(harness.generate.calls).toHaveLength(2);
        expect(lastRequestText(harness)).toContain('staging');
        expect(lastRequestText(harness)).not.toContain('production');
      });
    });
  });

  it('answers a different resume RESUME_CONFLICT after the first completed', async () => {
    await withPeers({ script: [askHuman, say('Deploying.')], ...humanWaits }, async (harness) => {
      await withPeer(harness, async (peer) => {
        const parked = await parkedInA(harness, peer);

        const first = await readAgUiStream(
          await peer.handler(resumeRequest([answer(parked.reviewId, 'staging')], 'client-run-2')),
        );
        const second = await readAgUiStream(
          await peer.handler(
            resumeRequest([answer(parked.reviewId, 'production')], 'client-run-3'),
          ),
        );

        expect(first.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(second).toHaveLength(1);
        expect(second[0]!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'RESUME_CONFLICT',
        });
        expect(harness.generate.calls).toHaveLength(2);
        expect(lastRequestText(harness)).not.toContain('production');
      });
    });
  });
});

describe('recalled memory in a peer’s snapshots (COR-1546)', () => {
  /** A governed memory holding one fact for the local caller's `assistant`, the memory a run will recall. */
  async function memoryWithAFact() {
    const memory = createGovernedMemory({
      storage: createInMemoryMemoryRecordStorage(),
      ledger: createMemoryGovernanceLedger(new MemoryStorage()),
      embedder: createMockEmbedder(64),
      policy: createMemoryGovernancePolicy({ revision: 'governance:peer-snapshots' }),
    });
    await memory.init();
    const owner = createMemoryAuthority({
      principal: { kind: 'user', id: 'anonymous:local' },
      tenantId: 'ag-ui-fixture',
      ownerId: 'anonymous:local',
      purpose: 'test',
      capabilities: ['memory:write'],
      policyRevision: 'test:1',
      projection: 'bureau',
    });
    await memory.write(owner, 'The user prefers aisle seats.', {
      collection: 'assistant',
      source: 'conversation',
    });
    return memory;
  }

  const showsEvidence = (frame: ReceivedFrame | undefined) =>
    messageTexts(frame).some((text) => text.includes('memory-evidence'));

  it('leaves the recall row out of the snapshot a peer opens with and the one it ends with', async () => {
    const memory = await memoryWithAFact();
    await withPeers(
      { script: [say('First.'), hold('second-generating'), say('Second.')], memory },
      async (harness) => {
        await withPeer(harness, async (peer) => {
          // The first turn recalls and finishes, so the thread holds its recall row when the second starts.
          const first = await startOn(harness.handler, {}, 'client-run-1', 'hello');
          await first.reader.rest();
          const session = await harness.bureau.contexts.get(THREAD);
          const stored = session?.conversationHistory;
          expect(
            Object.values(stored?.messages ?? {}).some(
              (message) => message.metadata?.['memoryEvidence'] !== undefined,
            ),
          ).toBe(true);

          const second = await startOn(harness.handler, {}, 'client-run-2', 'again');
          await harness.generate.reached('second-generating');
          const attached = new FrameReader(await peer.handler(attachThreadRequest(THREAD)));
          const opened = await opening(attached);
          harness.generate.release('second-generating');
          const rest = await attached.rest();
          await second.reader.rest();

          // The snapshot the peer opens with, and the one that ends its stream.
          expect(typesOf(opened)[1]).toBe(EventType.MESSAGES_SNAPSHOT);
          expect(messageTexts(opened[1])).toContain('First.');
          expect(showsEvidence(opened[1])).toBe(false);
          expect(typesOf(rest)[0]).toBe(EventType.MESSAGES_SNAPSHOT);
          expect(messageTexts(rest[0])).toContain('Second.');
          expect(showsEvidence(rest[0])).toBe(false);
        });
      },
    );
  });
});

describe('a peer stream of a run that parks after it opened (COR-1615)', () => {
  it('ends with the interrupt of a human wait the holder parks on while the peer follows', async () => {
    const clock = createManualRuntimeServices();
    await withPeers(
      { script: [hold('a-generating'), askHuman], ...humanWaits },
      async (harness) => {
        await withPeer(
          harness,
          async (peer) => {
            const started = await startOn(harness.handler);
            await harness.generate.reached('a-generating');

            const attached = new FrameReader(await peer.handler(attachThreadRequest(THREAD)));
            const opened = await opening(attached);
            expect(snapshotOf(opened[2]!)['pendingInterruptIds']).toEqual([]);
            let more = false;
            const next = attached.next().then((frame) => {
              more = true;
              return frame;
            });

            harness.generate.release('a-generating');
            await started.reader.rest();
            const [parked] = harness.bureau.reviews.list();
            await pollUntil(async () => (await waitsOn(peer, started.nativeRunId)) > 0);
            // The park saved no session and recorded nothing in the run's history, so the stream is
            // still open, waiting on its next re-check of the run on the mount's clock.
            const recheckDue = clock.monotonic.now() + PEER_PARK_RECHECK_INTERVAL_MS;
            await pollUntil(() =>
              clock.pendingTimers().some((timer) => timer.dueAt === recheckDue),
            );
            const session = await peer.bureau.contexts.get(THREAD);
            expect(session?.metadata['lastRunStatus']).toBe('running');
            expect(more).toBe(false);

            await clock.advance(PEER_PARK_RECHECK_INTERVAL_MS);
            const state = await next;
            const rest = await attached.rest();

            expect(parked?.kind).toBe('human-wait');
            expect(state?.event.type).toBe(EventType.STATE_SNAPSHOT);
            expect(snapshotOf(state!)['pendingInterruptIds']).toEqual([parked!.id]);
            expect(typesOf(rest)).toEqual([EventType.RUN_FINISHED]);
            expect(rest[0]!.event).toMatchObject({
              outcome: { type: 'interrupt', interrupts: [{ id: parked!.id }] },
            });
          },
          { runtime: clock },
        );
      },
    );
  });
});
