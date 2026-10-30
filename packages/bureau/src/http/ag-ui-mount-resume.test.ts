/**
 * COR-855 — resuming a run. A resume is a new authorized command recorded in the
 * command ledger, never an in-place change to a request in flight: it resolves
 * the reviews its entries answer and opens a new stream, on the same native run
 * for a human wait and on a fresh one for a tool approval.
 */
import type { TaskHandle } from '../types.ts';
import { type Event, EventType, type ResumeEntry } from '@ag-ui/core';
import { createDefaultRuntimeServices, createManualRuntimeServices } from '@lostgradient/lifecycle';
import { stopWhen, type Toolbox, waitForCondition } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import {
  as,
  attachThreadRequest,
  authentication,
  cancelRequest,
  type Handler,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { ReviewRoundChangedError } from '../create-bureau.ts';
import { DEFAULT_AG_UI_LEASE_MS } from './ag-ui-lease.ts';
import { RESUME_ROUND_CHANGED_MESSAGE } from './ag-ui-resume-messages.ts';
import { openRunStream } from './ag-ui-stream.ts';
import {
  bureauMetadata,
  FrameReader,
  readAgUiStream,
  typesOf,
} from './ag-ui-stream.test-support.ts';
import { listHeldTasks } from '../test';

const SECRET = 'ag-ui-resume-secret';

function chargeCardTool(charges: number[]) {
  return createTool({
    name: 'charge-card',
    version: '1.0.0',
    description: 'Charge a payment card',
    input: z.object({ cents: z.number() }),
    async execute({ cents }) {
      charges.push(cents);
      return { charged: cents };
    },
  });
}

const gate = (reason: string) => ({
  allow: false as const,
  status: 'needs_approval' as const,
  reason,
  action: { message: 'Approve charge' },
});

/** Every call needs approval, and an approved one runs. */
function approvalToolbox(charges: number[]): Toolbox {
  return createToolbox([chargeCardTool(charges)], {
    approvalSecret: SECRET,
    policy: { beforeExecute: () => gate('Operator approval required') },
  }) as unknown as Toolbox;
}

/** Only the proposed amount needs approval, so an approval that edits it runs the tool at once. */
function amountGatedToolbox(charges: number[]): Toolbox {
  return createToolbox([chargeCardTool(charges)], {
    approvalSecret: SECRET,
    policy: {
      beforeExecute: ({ params }) =>
        (params as { cents?: number }).cents === 500
          ? gate('Operator approval required')
          : { allow: true as const },
    },
  }) as unknown as Toolbox;
}

/** The policy changes its mind on each evaluation, so approving a call gates it again. */
function regatingToolbox(charges: number[]): Toolbox {
  let evaluations = 0;
  return createToolbox([chargeCardTool(charges)], {
    approvalSecret: SECRET,
    policy: {
      beforeExecute: () => gate(`Operator approval required (evaluation ${(evaluations += 1)})`),
    },
  }) as unknown as Toolbox;
}

const chargeOnce = {
  kind: 'respond' as const,
  response: {
    content: 'Charging.',
    toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
  },
};
const chargeTwice = {
  kind: 'respond' as const,
  response: {
    content: 'Charging both.',
    toolCalls: [
      { id: 'call-1', name: 'charge-card', arguments: { cents: 500 } },
      { id: 'call-2', name: 'charge-card', arguments: { cents: 700 } },
    ],
  },
};
const askHuman = {
  kind: 'respond' as const,
  response: {
    content: 'Asking.',
    toolCalls: [
      {
        id: 'call-1',
        name: 'requestHumanInput',
        arguments: { signalName: 'human-response', prompt: 'Approve this?' },
      },
    ],
  },
};
const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});

const approve: ResumeEntry['payload'] = { decision: 'approve' };

/** A promise that never settles: a process that died mid-call. */
const never = <T>(): Promise<T> => new Promise<T>(() => {});

function resolved(interruptId: string, payload: unknown = approve): ResumeEntry {
  return { interruptId, status: 'resolved', payload };
}

async function withHarness<T>(
  options: Parameters<typeof openHarness>[0],
  body: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await openHarness(options);
  try {
    return await body(harness);
  } finally {
    await harness.dispose();
  }
}

/** Starts a run and reads its stream, returning the interrupts it ended with. */
async function startUntilInterrupted(handler: Handler, headers: Record<string, string> = {}) {
  const frames = await readAgUiStream(await handler(startRequest(runAgentInput(), headers)));
  const finished = frames.at(-1)!.event as {
    outcome: { type: string; interrupts: Array<{ id: string }> };
  };
  return {
    frames,
    nativeRunId: String(bureauMetadata(frames[0]!.event)['runId']),
    interruptIds: finished.outcome.interrupts.map((interrupt) => interrupt.id),
  };
}

/** The ids of every user-role text a stream streams: an answer never travels that way. */
const userTextRows = (frames: ReadonlyArray<{ event: Event }>) =>
  frames
    .filter(
      (frame) =>
        frame.event.type === EventType.TEXT_MESSAGE_START &&
        (frame.event as unknown as { role?: string }).role === 'user',
    )
    .map((frame) => (frame.event as unknown as { messageId: string }).messageId);

/** The user rows the `MESSAGES_SNAPSHOT`s of a stream carry, only the answers among them (`:signal:`). */
const snapshotUserRows = (frames: ReadonlyArray<{ event: Event }>) =>
  frames.flatMap((frame) =>
    frame.event.type === EventType.MESSAGES_SNAPSHOT
      ? (
          frame.event as unknown as {
            messages: Array<{ id: string; role: string; content: string }>;
          }
        ).messages
          .filter((message) => message.role === 'user' && message.id.includes(':signal:'))
          .map(({ id, content }) => ({ id, content }))
      : [],
  );

function resumeRequest(
  entries: ResumeEntry[],
  headers: Record<string, string> = {},
  runId = 'client-run-2',
): Request {
  return startRequest(runAgentInput({ runId, messages: [], resume: entries }), headers);
}

describe('resuming a tool approval', () => {
  it('starts a new native run, replays the call, and carries the executed result under the pending row id', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('Charged.')], toolbox: approvalToolbox(charges) },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);

        const frames = await readAgUiStream(
          await handler(resumeRequest([resolved(first.interruptIds[0]!)])),
        );

        const events = frames.map((frame) => frame.event);
        const nativeRunId = String(bureauMetadata(events[0]!)['runId']);
        expect(nativeRunId).not.toBe(first.nativeRunId);
        expect(events[0]).toMatchObject({ type: EventType.RUN_STARTED, runId: 'client-run-2' });
        // The call comes back with its original ids, then its executed result, under the pending row's id.
        expect(events).toContainEqual(
          expect.objectContaining({ type: EventType.TOOL_CALL_START, toolCallId: 'call-1' }),
        );
        const replayedResult = events.find(
          (event) =>
            event.type === EventType.TOOL_CALL_RESULT &&
            (event as { toolCallId: string }).toolCallId === 'call-1',
        ) as { messageId: string; content: string };
        expect(replayedResult.messageId).toBe(`${first.nativeRunId}:step:0:result:call-1`);
        expect(replayedResult.content).toContain('charged');
        expect(events.at(-1)).toMatchObject({
          type: EventType.RUN_FINISHED,
          runId: 'client-run-2',
          outcome: { type: 'success' },
        });
        expect(charges).toEqual([500]);
        expect(listHeldTasks(bureau)).toHaveLength(2);
        // COR-1867: the continuation is the chat's own, not an anonymous API start, so a listing
        // filtered to chats finds it beside the run it continues.
        const continuation = await bureau.internals.taskRegistry.record(nativeRunId);
        expect(continuation?.origin).toMatchObject({ kind: 'chat', contextId: 'thread-1' });
        // The conversation the new run ended with answers the call once.
        const session = await bureau.contexts.get('thread-1');
        const history = session?.conversationHistory;
        const rows = history?.ids.map((id) => history.messages[id]!) ?? [];
        expect(rows.filter((row) => row.toolResult?.callId === 'call-1')).toHaveLength(1);
      },
    );
  });

  it('replays the arguments the approval ran the tool with, not the ones the model proposed', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('Charged.')], toolbox: amountGatedToolbox(charges) },
      async ({ handler }) => {
        const first = await startUntilInterrupted(handler);
        const entry = resolved(first.interruptIds[0]!, {
          decision: 'approve',
          arguments: { cents: 900 },
        });

        const frames = await readAgUiStream(await handler(resumeRequest([entry])));

        const shown = frames
          .map((frame) => frame.event)
          .filter((event) => event.type === EventType.TOOL_CALL_ARGS)
          .map((event) => (event as { toolCallId: string; delta: string }).delta);
        expect(charges).toEqual([900]);
        expect(shown).toEqual(['{"cents":900}']);
      },
    );
  });

  it('replays the proposed arguments when the approval left them as they were', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('Charged.')], toolbox: approvalToolbox(charges) },
      async ({ handler }) => {
        const first = await startUntilInterrupted(handler);

        const frames = await readAgUiStream(
          await handler(resumeRequest([resolved(first.interruptIds[0]!)])),
        );

        const shown = frames
          .map((frame) => frame.event)
          .filter((event) => event.type === EventType.TOOL_CALL_ARGS)
          .map((event) => (event as { delta: string }).delta);
        expect(charges).toEqual([500]);
        expect(shown).toEqual(['{"cents":500}']);
      },
    );
  });

  it('maps cancelled to deny: the tool does not run and the model is told it was refused', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('Understood.')], toolbox: approvalToolbox(charges) },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);

        const frames = await readAgUiStream(
          await handler(
            resumeRequest([{ interruptId: first.interruptIds[0]!, status: 'cancelled' }]),
          ),
        );

        expect(charges).toEqual([]);
        expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        const session = await bureau.contexts.get('thread-1');
        const history = session?.conversationHistory;
        const row = history?.ids
          .map((id) => history.messages[id]!)
          .find((candidate) => candidate.toolResult?.callId === 'call-1');
        expect(row?.toolResult?.outcome).toBe('error');
        expect(JSON.stringify(row?.toolResult)).toContain('cancelled by the client');
      },
    );
  });

  it('passes a reason to a deny and requires one to reject', async () => {
    await withHarness(
      { script: [chargeOnce, say('Ok.')], toolbox: approvalToolbox([]) },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const id = first.interruptIds[0]!;

        const blank = await readAgUiStream(
          await handler(resumeRequest([resolved(id, { decision: 'reject', reason: '  ' })])),
        );

        expect(blank).toHaveLength(1);
        expect(blank[0]!.event).toMatchObject({ code: 'INVALID_INPUT' });
        expect(bureau.reviews.list()).toHaveLength(1);
        const denied = await readAgUiStream(
          await handler(resumeRequest([resolved(id, { decision: 'deny', reason: 'Too much' })])),
        );
        expect(denied.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        const audit = JSON.stringify(await bureau.internals.auditTrail?.query({}));
        expect(audit).toContain('Too much');
      },
    );
  });
});

describe('a resume that is refused applies nothing', () => {
  it('names the interrupts a partial answer leaves unanswered', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeTwice, say('Done.')], toolbox: approvalToolbox(charges) },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        expect(first.interruptIds).toHaveLength(2);

        const frames = await readAgUiStream(
          await handler(resumeRequest([resolved(first.interruptIds[0]!)])),
        );

        expect(frames).toHaveLength(1);
        expect(frames[0]!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'INTERRUPTS_UNADDRESSED',
          message: expect.stringContaining(first.interruptIds[1]!),
        });
        expect(bureau.reviews.list()).toHaveLength(2);
        expect(charges).toEqual([]);
      },
    );
  });

  it('answers an unknown interrupt, and one on another thread, as INTERRUPT_NOT_FOUND', async () => {
    await withHarness(
      { script: [chargeOnce, say('Done.')], toolbox: approvalToolbox([]) },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);

        const unknown = await readAgUiStream(
          await handler(resumeRequest([resolved('approval:nope:call-9')])),
        );
        const otherThread = await readAgUiStream(
          await handler(
            startRequest(
              runAgentInput({
                threadId: 'another-thread',
                runId: 'client-run-9',
                messages: [],
                resume: [resolved(first.interruptIds[0]!)],
              }),
            ),
          ),
        );

        expect(unknown[0]!.event).toMatchObject({ code: 'INTERRUPT_NOT_FOUND' });
        expect(otherThread[0]!.event).toMatchObject({ code: 'INTERRUPT_NOT_FOUND' });
        expect(bureau.reviews.list()).toHaveLength(1);
      },
    );
  });

  it('gives a caller who does not own the interrupt the answer a missing id gets', async () => {
    await withHarness(
      { script: [chargeOnce, say('Done.')], toolbox: approvalToolbox([]), authentication },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler, as('alice-key'));

        const stranger = await readAgUiStream(
          await handler(resumeRequest([resolved(first.interruptIds[0]!)], as('bob-key'))),
        );
        const random = await readAgUiStream(
          await handler(resumeRequest([resolved('approval:nope:call-9')], as('bob-key'))),
        );

        expect(stranger[0]!.event).toMatchObject({ code: 'INTERRUPT_NOT_FOUND' });
        expect(random[0]!.event).toMatchObject({ code: 'INTERRUPT_NOT_FOUND' });
        expect(bureau.reviews.list()).toHaveLength(1);
      },
    );
  });
});

describe('a duplicate resume', () => {
  it('attaches to the run of the first without a second resolution or a second run', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const entries = [resolved(first.interruptIds[0]!)];
        const original = await readAgUiStream(await handler(resumeRequest(entries)));
        const resolve = spyOn(bureau.reviews, 'resolve');
        const runsBefore = listHeldTasks(bureau).length;

        // A client that mints a fresh runId for its retry is still a retry.
        const retry = await readAgUiStream(
          await handler(resumeRequest(entries, {}, 'client-run-3')),
        );

        expect(resolve).not.toHaveBeenCalled();
        expect(listHeldTasks(bureau)).toHaveLength(runsBefore);
        expect(charges).toEqual([500]);
        expect(retry[0]!.event).toMatchObject({
          type: EventType.RUN_STARTED,
          runId: 'client-run-3',
        });
        expect(bureauMetadata(retry[0]!.event)['runId']).toBe(
          bureauMetadata(original[0]!.event)['runId'],
        );
        expect(retry.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        expect(typesOf(retry)).toContain(EventType.MESSAGES_SNAPSHOT);
      },
    );
  });

  it('lets exactly one of two identical resumes in flight resolve anything', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const entries = [resolved(first.interruptIds[0]!)];
        const resolve = spyOn(bureau.reviews, 'resolve');

        const [left, right] = await Promise.all([
          handler(resumeRequest(entries)),
          handler(resumeRequest(entries, {}, 'client-run-3')),
        ]);
        const [leftFrames, rightFrames] = await Promise.all([
          readAgUiStream(left),
          readAgUiStream(right),
        ]);

        expect(resolve).toHaveBeenCalledTimes(1);
        expect(charges).toEqual([500]);
        expect(listHeldTasks(bureau)).toHaveLength(2);
        expect(leftFrames.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        expect(rightFrames.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        expect(bureauMetadata(leftFrames[0]!.event)['runId']).toBe(
          bureauMetadata(rightFrames[0]!.event)['runId'],
        );
      },
    );
  });

  it('refuses the same interrupts answered differently as RESUME_CONFLICT and leaves the first untouched', async () => {
    await withHarness(
      { script: [chargeOnce, say('Charged.')], toolbox: approvalToolbox([]), storage: 'sqlite' },
      async ({ handler }) => {
        const first = await startUntilInterrupted(handler);
        const id = first.interruptIds[0]!;
        await readAgUiStream(await handler(resumeRequest([resolved(id)])));

        const different = await readAgUiStream(
          await handler(resumeRequest([resolved(id, { decision: 'deny' })], {}, 'client-run-3')),
        );

        expect(different).toHaveLength(1);
        expect(different[0]!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'RESUME_CONFLICT',
        });
      },
    );
  });
});

describe('a resume after a supersession', () => {
  it('is a new command each round, ends with the interrupt under the same id, and starts no run', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('Never.')], toolbox: regatingToolbox(charges), storage: 'sqlite' },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const id = first.interruptIds[0]!;
        const runsBefore = listHeldTasks(bureau).length;

        const secondRound = await readAgUiStream(await handler(resumeRequest([resolved(id)])));
        const thirdRound = await readAgUiStream(
          await handler(resumeRequest([resolved(id)], {}, 'client-run-3')),
        );

        for (const [frames, round] of [
          [secondRound, 1],
          [thirdRound, 2],
        ] as const) {
          expect(frames.at(-1)!.event).toMatchObject({
            type: EventType.RUN_FINISHED,
            outcome: {
              type: 'interrupt',
              interrupts: [
                {
                  id,
                  metadata: { '@lostgradient/bureau': expect.objectContaining({ round }) },
                },
              ],
            },
          });
          // The old run, re-emitted: the snapshot, the replayed call, and its pending result.
          expect(bureauMetadata(frames[0]!.event)['runId']).toBe(first.nativeRunId);
          expect(typesOf(frames)).toContain(EventType.TOOL_CALL_RESULT);
        }
        expect(listHeldTasks(bureau)).toHaveLength(runsBefore);
        expect(charges).toEqual([]);
      },
    );
  });
});

/** An entry that names the round of the approval it was made on, as a client that read it sends it. */
function onRound(entry: ResumeEntry, round: unknown): ResumeEntry {
  return { ...entry, metadata: { '@lostgradient/bureau': { round } } };
}

const roundOf = (bureau: Harness['bureau'], id: string) => {
  const review = bureau.reviews.list().find((pending) => pending.id === id);
  return review?.kind === 'tool-approval' ? review.round : undefined;
};

describe('a resume made on a round the approval has moved past (COR-1714)', () => {
  it('decides nothing and says the approval changed, and the current round is still answerable', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('Never.')], toolbox: regatingToolbox(charges), storage: 'sqlite' },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const id = first.interruptIds[0]!;
        // Approved on round 0, and gated again: the same id is at round 1.
        await readAgUiStream(await handler(resumeRequest([onRound(resolved(id), 0)])));
        expect(roundOf(bureau, id)).toBe(1);
        const ledgerBefore = await ledgerStates(bureau);
        const resolve = spyOn(bureau.reviews, 'resolve');

        const stale = await readAgUiStream(
          await handler(resumeRequest([onRound(resolved(id), 0)], {}, 'client-run-3')),
        );
        const cancelled = await readAgUiStream(
          await handler(
            resumeRequest(
              [onRound({ interruptId: id, status: 'cancelled' }, 0)],
              {},
              'client-run-4',
            ),
          ),
        );
        const staleCalls = resolve.mock.calls.length;
        resolve.mockRestore();
        // Refused before the ledger: neither left an entry of its own.
        const ledgerAfterStale = await ledgerStates(bureau);
        const current = await readAgUiStream(
          await handler(resumeRequest([onRound(resolved(id), 1)], {}, 'client-run-5')),
        );

        for (const refused of [stale, cancelled]) {
          expect(refused).toHaveLength(1);
          expect(refused[0]!.event).toMatchObject({
            type: EventType.RUN_ERROR,
            code: 'REVIEW_ROUND_CHANGED',
            message: RESUME_ROUND_CHANGED_MESSAGE,
          });
        }
        expect(staleCalls).toBe(0);
        expect(ledgerBefore).toEqual(['completed:superseded']);
        expect(ledgerAfterStale).toEqual(ledgerBefore);
        // The round the person read is the one decided: round 1 is answered and gated again.
        expect(current.at(-1)!.event).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: 'interrupt' },
        });
        expect(roundOf(bureau, id)).toBe(2);
        expect(charges).toEqual([]);
      },
    );
  });

  it('refuses a decision the fence turns away after the read the same way', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('Done.')], toolbox: approvalToolbox(charges), storage: 'sqlite' },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const id = first.interruptIds[0]!;
        // Gated again between the resume's read of the review and its decision.
        const resolve = spyOn(bureau.reviews, 'resolve').mockRejectedValueOnce(
          new ReviewRoundChangedError('now at round 1'),
        );

        const frames = await readAgUiStream(
          await handler(resumeRequest([onRound(resolved(id), 0)])),
        );

        expect(resolve.mock.calls[0]?.[0]).toMatchObject({ id, round: 0 });
        resolve.mockRestore();
        expect(frames).toHaveLength(1);
        expect(frames[0]!.event).toMatchObject({
          code: 'REVIEW_ROUND_CHANGED',
          message: RESUME_ROUND_CHANGED_MESSAGE,
        });
        expect(bureau.reviews.list()).toHaveLength(1);
        expect(charges).toEqual([]);
      },
    );
  });

  it('refuses an entry whose round is not a round as INVALID_INPUT', async () => {
    await withHarness(
      { script: [chargeOnce, say('Done.')], toolbox: approvalToolbox([]) },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const id = first.interruptIds[0]!;

        const frames = await readAgUiStream(
          await handler(resumeRequest([onRound(resolved(id), 'zero')])),
        );

        expect(frames[0]!.event).toMatchObject({ code: 'INVALID_INPUT' });
        expect(bureau.reviews.list()).toHaveLength(1);
      },
    );
  });

  it('gives a caller who may not answer the interrupt the answer a missing id gets, whatever its round', async () => {
    await withHarness(
      { script: [chargeOnce, say('Done.')], toolbox: approvalToolbox([]), authentication },
      async ({ handler }) => {
        const first = await startUntilInterrupted(handler, as('alice-key'));

        const stranger = await readAgUiStream(
          await handler(
            resumeRequest([onRound(resolved(first.interruptIds[0]!), 7)], as('bob-key')),
          ),
        );

        expect(stranger[0]!.event).toMatchObject({ code: 'INTERRUPT_NOT_FOUND' });
      },
    );
  });
});

describe('a resume whose run cannot start', () => {
  it('says the approvals were applied, and leaves the thread free for a new message', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('Charged, and carrying on.')], toolbox: approvalToolbox(charges) },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const startTask = spyOn(bureau.tasks, 'start').mockRejectedValueOnce(
          new Error('disk full'),
        );

        const failed = await readAgUiStream(
          await handler(resumeRequest([resolved(first.interruptIds[0]!)])),
        );
        startTask.mockRestore();
        const next = await readAgUiStream(
          await handler(
            startRequest(
              runAgentInput({
                runId: 'client-run-3',
                messages: [{ id: 'user-2', role: 'user', content: 'carry on' }],
              }),
            ),
          ),
        );

        expect(failed).toHaveLength(1);
        expect(failed[0]!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'RUN_FAILED',
          message: expect.stringContaining('approvals were applied'),
        });
        expect(charges).toEqual([500]);
        expect(next.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
      },
    );
  });
});

describe('a resume that did not finish', () => {
  it('can be answered again when its resolution failed without effect', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const resolve = spyOn(bureau.reviews, 'resolve').mockRejectedValueOnce(
          new Error('session store unavailable'),
        );

        const failed = await readAgUiStream(
          await handler(resumeRequest([resolved(first.interruptIds[0]!)])),
        );
        resolve.mockRestore();
        const retry = await readAgUiStream(
          await handler(resumeRequest([resolved(first.interruptIds[0]!)], {}, 'client-run-3')),
        );

        expect(failed).toHaveLength(1);
        expect(failed[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'RUN_FAILED' });
        expect(charges).toEqual([500]);
        expect(retry.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
      },
    );
  });

  it('is taken over by a retry once its claimant’s lease has expired, which applies it', async () => {
    const charges: number[] = [];
    const dead = createManualRuntimeServices();
    const living = createManualRuntimeServices();
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
        agUi: { runtime: dead },
      },
      async (harness) => {
        const first = await startUntilInterrupted(harness.handler);
        const entries = [resolved(first.interruptIds[0]!)];
        // The first process claims the resume and dies before it resolves anything.
        const resolve = spyOn(harness.bureau.reviews, 'resolve').mockImplementationOnce(() =>
          never(),
        );
        void harness.handler(resumeRequest(entries));
        await waitForCondition(() => resolve.mock.calls.length === 1, 'the resume never started');
        resolve.mockRestore();
        await living.advance(DEFAULT_AG_UI_LEASE_MS);

        const retry = await readAgUiStream(
          await harness.remount({ runtime: living })(resumeRequest(entries, {}, 'client-run-3')),
        );

        expect(retry.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(charges).toEqual([500]);
      },
    );
  });

  it('is finished by a retry after its claimant died when its approvals were applied but its run was not started', async () => {
    const charges: number[] = [];
    const dead = createManualRuntimeServices();
    const living = createManualRuntimeServices();
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
        agUi: { runtime: dead },
      },
      async (harness) => {
        const first = await startUntilInterrupted(harness.handler);
        const entries = [resolved(first.interruptIds[0]!)];
        const startTask = spyOn(harness.bureau.tasks, 'start').mockImplementationOnce(() =>
          never<TaskHandle>(),
        );
        void harness.handler(resumeRequest(entries));
        await waitForCondition(() => startTask.mock.calls.length === 1, 'the run never started');
        startTask.mockRestore();
        expect(harness.bureau.reviews.list()).toHaveLength(0);
        await living.advance(DEFAULT_AG_UI_LEASE_MS);

        const retry = await readAgUiStream(
          await harness.remount({ runtime: living })(resumeRequest(entries, {}, 'client-run-3')),
        );
        // Not through the claimant's own mount, which is still waiting on the call that never returned.
        const again = await readAgUiStream(
          await harness.remount({ runtime: living })(resumeRequest(entries, {}, 'client-run-4')),
        );

        expect(retry.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(charges).toEqual([500]);
        expect(listHeldTasks(harness.bureau)).toHaveLength(2);
        expect(bureauMetadata(again[0]!.event)['runId']).toBe(
          bureauMetadata(retry[0]!.event)['runId'],
        );
      },
    );
  });
});

describe('a resume that cannot write the approval’s outcome into the conversation', () => {
  it('answers RUN_FAILED and starts no run, because the conversation still shows the approval as pending', async () => {
    const charges: number[] = [];
    const diagnostics: string[] = [];
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const store = bureau.internals.sessionStore!;
        const update = store.update.bind(store);
        const failing = spyOn(store, 'update').mockImplementation((id, updater, options) =>
          update(
            id,
            async (session) => {
              const next = await updater(session);
              if (
                session !== undefined &&
                next !== undefined &&
                next.conversationHistory !== session.conversationHistory
              ) {
                throw new Error('disk full');
              }
              return next;
            },
            options,
          ),
        );
        const runsBefore = listHeldTasks(bureau).length;

        const frames = await readAgUiStream(
          await handler(resumeRequest([resolved(first.interruptIds[0]!)])),
        );
        failing.mockRestore();

        expect(frames).toHaveLength(1);
        expect(frames[0]!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'RUN_FAILED',
          message: expect.stringContaining('not written'),
        });
        expect(listHeldTasks(bureau)).toHaveLength(runsBefore);
        expect(charges).toEqual([500]);
        // The Bureau says why, through its own diagnostics, and not on the console.
        expect(diagnostics).toEqual([expect.stringContaining('into session "thread-1"')]);
      },
    );
  });
});

describe('cancelling a run that is settled with an approval pending', () => {
  it('leaves the thread busy until the approval is answered, and answering it as cancelled frees the thread', async () => {
    await withHarness(
      {
        script: [chargeOnce, say('Understood, not charging.'), say('A fresh message.')],
        toolbox: approvalToolbox([]),
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const next = (runId: string) =>
          startRequest(
            runAgentInput({ runId, messages: [{ id: 'user-2', role: 'user', content: 'again' }] }),
          );

        const cancelled = await handler(cancelRequest(first.nativeRunId));
        const busy = await readAgUiStream(await handler(next('client-run-3')));
        const answered = await readAgUiStream(
          await handler(
            resumeRequest([{ interruptId: first.interruptIds[0]!, status: 'cancelled' }]),
          ),
        );
        const freed = await readAgUiStream(await handler(next('client-run-4')));

        expect(cancelled.status).toBe(200);
        expect(busy[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'THREAD_BUSY' });
        expect(answered.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(bureau.reviews.list()).toEqual([]);
        expect(freed.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
      },
    );
  });
});

describe('the resume ledger’s retention', () => {
  it('drops entries past their window when a later resume comes', async () => {
    const runtime = createManualRuntimeServices();
    await withHarness(
      {
        script: [chargeOnce, say('Charged.'), chargeOnce, say('Again.')],
        toolbox: approvalToolbox([]),
        storage: 'sqlite',
        agUi: { runtime },
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        await readAgUiStream(await handler(resumeRequest([resolved(first.interruptIds[0]!)])));
        const keys = () => bureau.internals.kv!.list('command-ledger:ag-ui-resume:v1:entry:');
        expect(await keys()).toHaveLength(1);

        await runtime.advance(25 * 60 * 60 * 1000);
        const secondFrames = await readAgUiStream(
          await handler(
            startRequest(
              runAgentInput({
                threadId: 'thread-2',
                runId: 'second-start',
                messages: [{ id: 'user-2', role: 'user', content: 'again' }],
              }),
            ),
          ),
        );
        const secondId = (
          secondFrames.at(-1)!.event as { outcome: { interrupts: Array<{ id: string }> } }
        ).outcome.interrupts[0]!.id;
        await readAgUiStream(
          await handler(
            startRequest(
              runAgentInput({
                threadId: 'thread-2',
                runId: 'second-resume',
                messages: [],
                resume: [resolved(secondId)],
              }),
            ),
          ),
        );

        // The first command's entry expired and went; only the second's remains.
        expect(await keys()).toHaveLength(1);
      },
    );
  });
});

describe('the resume command ledger', () => {
  it('leaves the Bureau’s own maintenance of run-creation receipts alone', async () => {
    const diagnostics: string[] = [];
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox([]),
        storage: 'sqlite',
        onDiagnostic: (diagnostic) =>
          diagnostics.push(`${diagnostic.scope}: ${diagnostic.message}`),
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        await readAgUiStream(await handler(resumeRequest([resolved(first.interruptIds[0]!)])));

        const ran = await bureau.maintain();

        expect(ran).toBe(true);
        expect(diagnostics).toEqual([]);
        // The receipt for the run the first start created is still there.
        const located = await bureau.tasks.receipt({
          principal: 'anonymous:local',
          commandId: 'client-run-1',
          agentName: 'assistant',
        });
        expect(located.status).toBe('recorded');
      },
    );
  });
});

describe('resuming a human wait', () => {
  it('carries the human’s answer as a row of a snapshot, under the id the conversation holds it by', async () => {
    await withHarness(
      {
        script: [askHuman, say('Thanks for the answer.')],
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);

        const frames = await readAgUiStream(
          await handler(
            resumeRequest([
              resolved(first.interruptIds[0]!, { decision: 'approve', answer: 'yes' }),
            ]),
          ),
        );

        const id = `${first.nativeRunId}:signal:human-response:0`;
        // The row rides in a snapshot, and no user-role text event is streamed for it.
        expect(userTextRows(frames)).toEqual([]);
        expect(snapshotUserRows(frames)).toContainEqual({
          id,
          content: '[signal:human-response] "yes"',
        });
        // The run's own conversation holds the answer under the id the stream gave it.
        expect(bureau.tasks.detail(first.nativeRunId)!.transcript!.ids).toContain(id);
      },
    );
  });

  it('carries the answer in the opening snapshot when the stream opens before the run has appended it', async () => {
    await withHarness(
      {
        script: [askHuman, say('Thanks.')],
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      },
      async ({ handler, bureau }) => {
        // The run is parked and has not been answered, so the conversation a stream opens on does
        // not hold the answer: the order a fast history read gives a real resume (COR-1632).
        const first = await startUntilInterrupted(handler);
        const threadId = String((first.frames[0]!.event as { threadId?: unknown }).threadId);
        const id = `${first.nativeRunId}:signal:human-response:0`;
        expect(bureau.tasks.detail(first.nativeRunId)?.transcript?.ids ?? []).not.toContain(id);

        const frames = await readAgUiStream(
          openRunStream(
            {
              bureau,
              runtime: createDefaultRuntimeServices(),
              maxStreamDurationMs: 5000,
              liveBufferSize: 100,
              keepAliveMs: 1000,
            },
            {
              threadId,
              runId: 'client-run-2',
              nativeRunId: first.nativeRunId,
              owner: 'anonymous:local',
              replay: 'open-step',
              messagesSnapshot: true,
              answerRows: [{ id, content: '[signal:human-response] "staging"' }],
            },
          ),
        );

        expect(userTextRows(frames)).toEqual([]);
        expect(snapshotUserRows(frames)).toEqual([
          { id, content: '[signal:human-response] "staging"' },
        ]);
      },
    );
  });

  it('continues the same native run, delivering the answer, and ends the new stream when the run does', async () => {
    await withHarness(
      {
        script: [askHuman, say('Thanks for the answer.')],
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      },
      async ({ handler, bureau, generate }) => {
        const first = await startUntilInterrupted(handler);

        const frames = await readAgUiStream(
          await handler(
            resumeRequest([
              resolved(first.interruptIds[0]!, { decision: 'approve', answer: 'yes' }),
            ]),
          ),
        );

        expect(typesOf(frames).slice(0, 3)).toEqual([
          EventType.RUN_STARTED,
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_SNAPSHOT,
        ]);
        expect(frames[0]!.event).toMatchObject({ runId: 'client-run-2' });
        expect(bureauMetadata(frames[0]!.event)['runId']).toBe(first.nativeRunId);
        expect(frames.at(-1)!.event).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: 'success' },
        });
        expect(listHeldTasks(bureau)).toHaveLength(1);
        // The model was given the human's answer on the continuation.
        const continuation = generate.calls.at(-1)!.context.conversation;
        expect(JSON.stringify(continuation.getMessages())).toContain('yes');
      },
    );
  });
});

describe('a human wait answered by a caller who may write but not read', () => {
  const options = {
    script: [askHuman, say('Thanks for the answer.')],
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    authentication,
  };
  const answer = { decision: 'approve', answer: 'the secret answer' } as const;
  const READ_TYPES = new Set<string>([
    EventType.MESSAGES_SNAPSHOT,
    EventType.STATE_SNAPSHOT,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
    EventType.TOOL_CALL_RESULT,
    EventType.STEP_STARTED,
    EventType.STEP_FINISHED,
  ]);

  it('delivers the answer and is told only that it was applied, with nothing of the thread in the stream', async () => {
    await withHarness(options, async ({ handler, bureau, generate }) => {
      const first = await startUntilInterrupted(handler, as('alice-key'));

      const response = await handler(
        resumeRequest([resolved(first.interruptIds[0]!, answer)], as('writer-key')),
      );
      const bytes = await response.clone().text();
      const frames = await readAgUiStream(response);

      expect(typesOf(frames)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
      expect(frames.some((frame) => READ_TYPES.has(frame.event.type))).toBe(false);
      expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
      for (const text of ['hello', 'Asking.', 'Thanks for the answer.', 'the secret answer']) {
        expect(bytes).not.toContain(text);
      }
      // The answer was delivered: the run went on with it.
      await waitForCondition(
        () => bureau.tasks.detail(first.nativeRunId)?.status === 'completed',
        'the run did not continue',
      );
      const continuation = generate.calls.at(-1)!.context.conversation;
      expect(JSON.stringify(continuation.getMessages())).toContain('the secret answer');
    });
  });

  it('is told the same on a retry of the same answer', async () => {
    await withHarness(options, async ({ handler }) => {
      const first = await startUntilInterrupted(handler, as('alice-key'));
      const entries = [resolved(first.interruptIds[0]!, answer)];
      await readAgUiStream(await handler(resumeRequest(entries, as('writer-key'))));

      const retry = await readAgUiStream(
        await handler(resumeRequest(entries, as('writer-key'), 'client-run-3')),
      );

      expect(typesOf(retry)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
    });
  });

  it('gets the full stream once it may read as well', async () => {
    await withHarness(options, async ({ handler }) => {
      const first = await startUntilInterrupted(handler, as('alice-key'));

      const frames = await readAgUiStream(
        await handler(
          resumeRequest([resolved(first.interruptIds[0]!, answer)], as('writer-reader-key')),
        ),
      );

      expect(typesOf(frames).slice(0, 3)).toEqual([
        EventType.RUN_STARTED,
        EventType.MESSAGES_SNAPSHOT,
        EventType.STATE_SNAPSHOT,
      ]);
      expect(frames.some((frame) => frame.event.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(
        true,
      );
      expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
    });
  });
});

/** A promise a test settles by hand, so a call can be held at a named point. */
function barrier() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { release, released, reach, reached };
}

describe('a resume that another process is applying', () => {
  it('is not taken over while its claimant’s lease holds, and the tool runs once', async () => {
    const charges: number[] = [];
    const claimantClock = createManualRuntimeServices();
    const otherClock = createManualRuntimeServices();
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
        agUi: { runtime: claimantClock },
      },
      async (harness) => {
        const first = await startUntilInterrupted(harness.handler);
        const entries = [resolved(first.interruptIds[0]!)];
        const held = barrier();
        const real = harness.bureau.reviews.resolve.bind(harness.bureau);
        const resolve = spyOn(harness.bureau.reviews, 'resolve');
        resolve.mockImplementationOnce(async (input) => {
          held.reach();
          await held.released;
          return real(input);
        });
        const claimant = harness.handler(resumeRequest(entries));
        await held.reached;
        // Part of the lease has gone, not all of it.
        await otherClock.advance(DEFAULT_AG_UI_LEASE_MS - 1);

        const refused = await readAgUiStream(
          await harness.remount({ runtime: otherClock })(
            resumeRequest(entries, {}, 'client-run-3'),
          ),
        );
        held.release();
        const finished = await readAgUiStream(await claimant);

        expect(refused).toHaveLength(1);
        expect(refused[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'RUN_FAILED' });
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(finished.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(charges).toEqual([500]);
      },
    );
  });

  it('is taken over by another process once the lease has expired, and the tool runs once', async () => {
    const charges: number[] = [];
    const claimantClock = createManualRuntimeServices();
    const otherClock = createManualRuntimeServices();
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
        agUi: { runtime: claimantClock },
      },
      async (harness) => {
        const first = await startUntilInterrupted(harness.handler);
        const entries = [resolved(first.interruptIds[0]!)];
        const held = barrier();
        const real = harness.bureau.reviews.resolve.bind(harness.bureau);
        spyOn(harness.bureau.reviews, 'resolve').mockImplementationOnce(async (input) => {
          held.reach();
          await held.released;
          return real(input);
        });
        const claimant = harness.handler(resumeRequest(entries));
        await held.reached;
        // The claimant never renews: its clock does not move, as a dead process's does not.
        await otherClock.advance(DEFAULT_AG_UI_LEASE_MS);

        const takenOver = await readAgUiStream(
          await harness.remount({ runtime: otherClock })(
            resumeRequest(entries, {}, 'client-run-3'),
          ),
        );
        held.release();
        const late = await readAgUiStream(await claimant);

        expect(takenOver.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(charges).toEqual([500]);
        // What the claimant comes back to is the answer that the work was done.
        expect(late[0]!.event.type).toBe(EventType.RUN_ERROR);
      },
    );
  });
});

describe('a resume applied by another Bureau over the same store', () => {
  it('takes the command over only after its lease has expired, and the tool runs once', async () => {
    const charges: number[] = [];
    const claimantClock = createManualRuntimeServices();
    const otherClock = createManualRuntimeServices();
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
        agUi: { runtime: claimantClock },
      },
      async (harness) => {
        const first = await startUntilInterrupted(harness.handler);
        const entries = [resolved(first.interruptIds[0]!)];
        // The second Bureau starts after the approval is pending, and restores it from the store.
        const peer = await harness.peer([say('Charged by the peer.')], { runtime: otherClock });
        try {
          const held = barrier();
          const reached = barrier();
          const real = harness.bureau.reviews.resolve.bind(harness.bureau);
          spyOn(harness.bureau.reviews, 'resolve').mockImplementationOnce(async (input) => {
            reached.reach();
            await held.released;
            return real(input);
          });
          const claimant = harness.handler(resumeRequest(entries));
          await reached.reached;

          await otherClock.advance(DEFAULT_AG_UI_LEASE_MS - 1);
          const early = await readAgUiStream(
            await peer.handler(resumeRequest(entries, {}, 'client-run-3')),
          );
          await otherClock.advance(1);
          const takenOver = await readAgUiStream(
            await peer.handler(resumeRequest(entries, {}, 'client-run-4')),
          );

          expect(early).toHaveLength(1);
          expect(early[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'RUN_FAILED' });
          expect(charges).toEqual([500]);
          expect(takenOver.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
          expect(listHeldTasks(peer.bureau)).toHaveLength(1);
          expect(listHeldTasks(harness.bureau)).toHaveLength(1);
          // The claimant is let go only to clean up. A call that outlives its lease, as
          // this one does, is the residual the leases cannot fence (see ag-ui-lease.ts).
          held.release();
          await claimant;
        } finally {
          await peer.dispose();
        }
      },
    );
  });
});

describe('two requests that answer the same interrupts differently at once', () => {
  it('lets one proceed and answers the other RESUME_CONFLICT, executing nothing for it', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('Charged.')], toolbox: approvalToolbox(charges) },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const id = first.interruptIds[0]!;
        const approve = resumeRequest([resolved(id)], {}, 'client-run-2');
        const deny = resumeRequest(
          [resolved(id, { decision: 'deny', reason: 'no' })],
          {},
          'client-run-3',
        );

        // Both are in the handler before either has settled.
        const [approved, denied] = await Promise.all([handler(approve), handler(deny)]);
        const approvedFrames = await readAgUiStream(approved);
        const deniedFrames = await readAgUiStream(denied);

        expect(approvedFrames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(deniedFrames).toHaveLength(1);
        expect(deniedFrames[0]!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'RESUME_CONFLICT',
        });
        expect(charges).toEqual([500]);
        expect(listHeldTasks(bureau)).toHaveLength(2);
      },
    );
  });
});

describe('a resume through the route of another agent', () => {
  const throughOther = (entries: ResumeEntry[], runId: string) =>
    startRequest(runAgentInput({ runId, messages: [], resume: entries }), {}, 'other');

  it('is refused as an interrupt that does not exist there, and nothing runs', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        otherAgents: ['other'],
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const entries = [resolved(first.interruptIds[0]!)];
        const unknown = [resolved('approval:nope:call-9')];

        const refused = await readAgUiStream(await handler(throughOther(entries, 'client-run-2')));
        const missing = await readAgUiStream(await handler(throughOther(unknown, 'client-run-3')));
        const own = await readAgUiStream(await handler(resumeRequest(entries, {}, 'client-run-4')));

        expect(refused).toHaveLength(1);
        expect(refused[0]!.event).toMatchObject({ code: 'INTERRUPT_NOT_FOUND' });
        expect(missing[0]!.event).toMatchObject({ code: 'INTERRUPT_NOT_FOUND' });
        // Byte for byte the answer an interrupt that never was gets, once each id is masked.
        const masked = (frames: typeof refused, id: string) =>
          JSON.stringify(frames.map((frame) => frame.event))
            .replaceAll(id, '<id>')
            .replace(/"timestamp":\d+/g, '"timestamp":0');
        expect(masked(refused, first.interruptIds[0]!)).toBe(
          masked(missing, 'approval:nope:call-9'),
        );
        // The agent that raised the interrupt still answers it, once.
        expect(own.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(charges).toEqual([500]);
        expect(listHeldTasks(bureau).map((run) => run.agentName)).toEqual([
          'assistant',
          'assistant',
        ]);
      },
    );
  });

  it('is refused too when the review carries no agent, which is then the session’s', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        otherAgents: ['other'],
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const entries = [resolved(first.interruptIds[0]!)];
        const getReview = bureau.reviews.get.bind(bureau.reviews);
        // A review read back without its agent, as one rebuilt from an older record is.
        spyOn(bureau.reviews, 'get').mockImplementation(async (id) => {
          const review = await getReview(id);
          return review === undefined ? undefined : { ...review, agentName: undefined };
        });

        const refused = await readAgUiStream(await handler(throughOther(entries, 'client-run-2')));
        const own = await readAgUiStream(await handler(resumeRequest(entries, {}, 'client-run-3')));

        expect(refused[0]!.event).toMatchObject({ code: 'INTERRUPT_NOT_FOUND' });
        expect(own.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(charges).toEqual([500]);
      },
    );
  });

  it('is refused as an interrupt that does not exist when the session that names the agent cannot be read', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        otherAgents: ['other'],
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const entries = [resolved(first.interruptIds[0]!)];
        const getReview = bureau.reviews.get.bind(bureau.reviews);
        spyOn(bureau.reviews, 'get').mockImplementation(async (id) => {
          const review = await getReview(id);
          return review === undefined ? undefined : { ...review, agentName: undefined };
        });
        const getSession = bureau.contexts.get.bind(bureau);
        let failed = 0;
        spyOn(bureau.contexts, 'get').mockImplementation(async (...args) => {
          if (failed === 0 && (new Error().stack ?? '').includes('sessionAgent')) {
            failed += 1;
            throw new Error('store unavailable');
          }
          return getSession(...args);
        });

        const refused = await readAgUiStream(
          await handler(resumeRequest(entries, {}, 'client-run-2')),
        );

        expect(failed).toBe(1);
        expect(refused[0]!.event).toMatchObject({ code: 'INTERRUPT_NOT_FOUND' });
        expect(bureau.reviews.list()).toHaveLength(1);
        expect(charges).toEqual([]);
      },
    );
  });

  it('creates no run for that agent when it retries a resume whose first attempt died', async () => {
    const charges: number[] = [];
    const dead = createManualRuntimeServices();
    const living = createManualRuntimeServices();
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        otherAgents: ['other'],
        storage: 'sqlite',
        agUi: { runtime: dead },
      },
      async (harness) => {
        const first = await startUntilInterrupted(harness.handler);
        const entries = [resolved(first.interruptIds[0]!)];
        const startTask = spyOn(harness.bureau.tasks, 'start').mockImplementationOnce(
          () => new Promise<TaskHandle>(() => {}),
        );
        void harness.handler(resumeRequest(entries));
        await waitForCondition(() => startTask.mock.calls.length === 1, 'the run never started');
        startTask.mockRestore();
        await living.advance(DEFAULT_AG_UI_LEASE_MS);

        const retried = await readAgUiStream(
          await harness.remount({ runtime: living })(throughOther(entries, 'client-run-3')),
        );

        expect(retried[0]!.event).toMatchObject({ code: 'INTERRUPT_NOT_FOUND' });
        expect(listHeldTasks(harness.bureau).map((run) => run.agentName)).toEqual(['assistant']);
        expect(charges).toEqual([500]);
      },
    );
  });
});

describe('a resume whose lease was taken over before it resolved anything', () => {
  it('resolves nothing, because it no longer holds the command', async () => {
    const charges: number[] = [];
    const claimantClock = createManualRuntimeServices();
    const otherClock = createManualRuntimeServices();
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
        agUi: { runtime: claimantClock },
      },
      async (harness) => {
        const first = await startUntilInterrupted(harness.handler);
        const entries = [resolved(first.interruptIds[0]!)];
        const resolve = spyOn(harness.bureau.reviews, 'resolve');
        // The claimant is held where it renews its leases before it resolves: the
        // first read of the command's lease is its claim, the second is that renewal.
        const kv = harness.bureau.internals.kv!;
        const get = kv.get.bind(kv);
        const reached = barrier();
        const held = barrier();
        let reads = 0;
        spyOn(kv, 'get').mockImplementation(async (key) => {
          if (key.startsWith('ag-ui-lease:v1:resume') && (reads += 1) === 2) {
            reached.reach();
            await held.released;
          }
          return get(key);
        });
        const claimant = harness.handler(resumeRequest(entries));
        const where = await Promise.race([
          reached.reached.then(() => 'renewing' as const),
          claimant.then(() => 'finished' as const),
        ]);
        expect(where).toBe('renewing');
        // Held before it has resolved anything: the renewal is what stands between it and the tool.
        expect(resolve).not.toHaveBeenCalled();
        expect(charges).toEqual([]);
        await otherClock.advance(DEFAULT_AG_UI_LEASE_MS);
        const takenOver = await readAgUiStream(
          await harness.remount({ runtime: otherClock })(
            resumeRequest(entries, {}, 'client-run-3'),
          ),
        );
        held.release();
        const late = await readAgUiStream(await claimant);

        expect(takenOver.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(late[0]!.event.type).toBe(EventType.RUN_ERROR);
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(charges).toEqual([500]);
      },
    );
  });
});

describe('a resume whose approvals are only partly applied', () => {
  it('applies the missing decision when it is retried, and starts exactly one run', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        script: [chargeTwice, say('Both charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const entries = first.interruptIds.map((id) => resolved(id));
        const resolve = spyOn(bureau.reviews, 'resolve').mockRejectedValueOnce(
          new Error('session store unavailable'),
        );

        const partial = await readAgUiStream(await handler(resumeRequest(entries)));
        resolve.mockRestore();
        const pendingAfterPartial = bureau.reviews.list().length;
        const runsAfterPartial = listHeldTasks(bureau).length;
        const retry = await readAgUiStream(
          await handler(resumeRequest(entries, {}, 'client-run-3')),
        );

        expect(partial).toHaveLength(1);
        expect(partial[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'RUN_FAILED' });
        // One decision landed and no run began from a half-answered set.
        expect(pendingAfterPartial).toBe(1);
        expect(runsAfterPartial).toBe(1);
        expect(retry.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(charges.toSorted((left, right) => left - right)).toEqual([500, 700]);
        expect(listHeldTasks(bureau)).toHaveLength(2);
      },
    );
  });
});

describe('a resume that loses its ledger claim after it took effect', () => {
  it('streams the run it created, not an error', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
      },
      async ({ handler, bureau }) => {
        const first = await startUntilInterrupted(handler);
        const kv = bureau.internals.kv!;
        const batch = kv.conditionalBatch.bind(kv);
        // The completion of the resume's ledger entry finds the entry changed.
        const lost = spyOn(kv, 'conditionalBatch').mockImplementation((conditions, operations) =>
          operations.some(
            (operation) =>
              operation.type === 'set' &&
              operation.key.startsWith('command-ledger:ag-ui-resume:v1') &&
              operation.value.includes('"state":"completed"'),
          )
            ? Promise.resolve(false)
            : batch(conditions, operations),
        );

        const frames = await readAgUiStream(
          await handler(resumeRequest([resolved(first.interruptIds[0]!)])),
        );
        lost.mockRestore();

        expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(charges).toEqual([500]);
        expect(listHeldTasks(bureau)).toHaveLength(2);
      },
    );
  });
});

describe('a resume retried after an attempt whose outcome was not written', () => {
  /** The first attempt resolves the approval, cannot write its outcome, and never gets to release its claim. */
  async function deadAttempt(harness: Harness, entries: ResumeEntry[]) {
    const store = harness.bureau.internals.sessionStore!;
    const update = store.update.bind(store);
    const failingWrite = spyOn(store, 'update').mockImplementation((id, updater, options) =>
      update(
        id,
        async (session) => {
          const next = await updater(session);
          if (
            session !== undefined &&
            next !== undefined &&
            next.conversationHistory !== session.conversationHistory
          ) {
            throw new Error('disk full');
          }
          return next;
        },
        options,
      ),
    );
    const kv = harness.bureau.internals.kv!;
    const batch = kv.conditionalBatch.bind(kv);
    const reached = barrier();
    const dying = spyOn(kv, 'conditionalBatch').mockImplementation((conditions, operations) => {
      const releasesResume = operations.some(
        (operation) =>
          operation.type === 'delete' && operation.key.startsWith('command-ledger:ag-ui-resume:v1'),
      );
      if (!releasesResume) return batch(conditions, operations);
      reached.reach();
      return new Promise<boolean>(() => {});
    });
    void harness.handler(resumeRequest(entries));
    await reached.reached;
    dying.mockRestore();
    failingWrite.mockRestore();
  }

  it.each(['remount', 'restart'] as const)(
    'answers RUN_FAILED and starts no run, across a %s',
    async (how) => {
      const charges: number[] = [];
      const dead = createManualRuntimeServices();
      const living = createManualRuntimeServices();
      await withHarness(
        {
          script: [chargeOnce, say('Asked again.')],
          toolbox: approvalToolbox(charges),
          storage: 'sqlite',
          agUi: { runtime: dead },
          // The outcome write fails on purpose; the Bureau says so through its diagnostics.
          onDiagnostic: () => undefined,
        },
        async (harness) => {
          const first = await startUntilInterrupted(harness.handler);
          const entries = [resolved(first.interruptIds[0]!)];
          await deadAttempt(harness, entries);
          const stored = (await harness.bureau.contexts.get('thread-1'))!.conversationHistory;
          const row = stored.ids
            .map((id) => stored.messages[id]!)
            .find((message) => message.toolResult?.callId === 'call-1');
          expect(row?.toolResult?.outcome).toBe('action_required');
          const runsBefore = listHeldTasks(harness.bureau).length;
          await living.advance(DEFAULT_AG_UI_LEASE_MS);

          const survivor =
            how === 'restart'
              ? await harness.restart([say('Unused.')], { runtime: living })
              : harness;
          try {
            const retry = await readAgUiStream(
              await (how === 'restart' ? survivor.handler : survivor.remount({ runtime: living }))(
                resumeRequest(entries, {}, 'client-run-3'),
              ),
            );

            expect(retry[0]!.event).toMatchObject({
              type: EventType.RUN_ERROR,
              code: 'RUN_FAILED',
            });
            if (how === 'remount') expect(listHeldTasks(harness.bureau)).toHaveLength(runsBefore);
            else expect(listHeldTasks(survivor.bureau)).toHaveLength(0);
            expect(charges).toEqual([500]);
          } finally {
            if (how === 'restart') await survivor.dispose();
          }
        },
      );
    },
  );
});

describe('a tool approval of a run that is still going', () => {
  const chargeThenWait = [
    chargeOnce,
    { kind: 'block' as const, barrier: 'next-step' },
    say('Done.'),
  ];

  it('is not advertised, and a resume of it is refused before anything runs', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        script: chargeThenWait,
        toolbox: approvalToolbox(charges),
        stopWhen: stopWhen.noToolCalls(),
      },
      async ({ handler, bureau, generate }) => {
        const start = new FrameReader(await handler(startRequest(runAgentInput())));
        await start.until(EventType.STEP_STARTED);
        await generate.reached('next-step');
        await waitForCondition(() => bureau.reviews.list().length === 1, 'no review listed');
        const pendingId = bureau.reviews.list()[0]!.id;

        const attach = new FrameReader(await handler(attachThreadRequest('thread-1')));
        const opening = await attach.until(EventType.STATE_SNAPSHOT);
        await attach.cancel();
        const state = opening.at(-1)!.event as unknown as {
          snapshot: { pendingInterruptIds: string[] };
        };
        const resume = new FrameReader(await handler(resumeRequest([resolved(pendingId)])));
        const answer = await resume.next();
        await resume.cancel();
        generate.release('next-step');
        await start.rest();

        expect(state.snapshot.pendingInterruptIds).toEqual([]);
        expect(answer!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'INTERRUPT_NOT_FOUND',
        });
        expect(charges).toEqual([]);
        expect(listHeldTasks(bureau)).toHaveLength(1);
      },
    );
  });
});

/** The states of the resume ledger's entries, with the mode a completed one answered in. */
async function ledgerStates(bureau: Harness['bureau']): Promise<string[]> {
  const kv = bureau.internals.kv!;
  const states: string[] = [];
  for (const key of await kv.list('command-ledger:ag-ui-resume:v1:entry:')) {
    const raw = await kv.get(key);
    const value = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      state?: string;
      result?: { mode?: string };
    };
    states.push(
      value.result?.mode === undefined
        ? String(value.state)
        : `${value.state}:${value.result.mode}`,
    );
  }
  return states;
}

describe('an approval no run can continue from', () => {
  // The agent goes on past the gated call, so its conversation ends in an assistant row.
  const settledWithApproval = async (charges: number[]) => ({
    script: [chargeOnce, say('Waiting for the approval.'), say('A fresh message.')],
    toolbox: approvalToolbox(charges),
    stopWhen: stopWhen.noToolCalls(),
    storage: 'sqlite' as const,
  });
  const decisions: Array<[string, unknown]> = [
    ['cancelled', undefined],
    ['deny', { decision: 'deny', reason: 'no' }],
    ['reject', { decision: 'reject', reason: 'not this card' }],
  ];

  it.each(decisions)(
    'is freed by a %s, which resolves it, runs nothing, and leaves the thread open',
    async (_name, payload) => {
      const charges: number[] = [];
      await withHarness(await settledWithApproval(charges), async ({ handler, bureau }) => {
        await readAgUiStream(await handler(startRequest(runAgentInput())));
        await waitForCondition(
          () => bureau.tasks.detail(listHeldTasks(bureau)[0]!.id)?.status === 'completed',
          'run did not settle',
        );
        const id = bureau.reviews.list()[0]!.id;
        const entry: ResumeEntry =
          payload === undefined ? { interruptId: id, status: 'cancelled' } : resolved(id, payload);

        const busy = await readAgUiStream(
          await handler(
            startRequest(
              runAgentInput({
                runId: 'client-run-2',
                messages: [{ id: 'user-2', role: 'user', content: 'a new message' }],
              }),
            ),
          ),
        );
        const freed = await readAgUiStream(
          await handler(resumeRequest([entry], {}, 'client-run-3')),
        );
        const next = await readAgUiStream(
          await handler(
            startRequest(
              runAgentInput({
                runId: 'client-run-4',
                messages: [{ id: 'user-3', role: 'user', content: 'a new message' }],
              }),
            ),
          ),
        );

        expect(busy[0]!.event).toMatchObject({ code: 'THREAD_BUSY' });
        expect(freed.at(-1)!.event).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: 'success' },
        });
        expect(bureau.reviews.list()).toEqual([]);
        expect(next.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(charges).toEqual([]);
      });
    },
  );

  it('is finished by a retry after its claimant died having refused it, which starts no run', async () => {
    const charges: number[] = [];
    const dead = createManualRuntimeServices();
    const living = createManualRuntimeServices();
    await withHarness(
      { ...(await settledWithApproval(charges)), agUi: { runtime: dead } },
      async (harness) => {
        const { handler, bureau } = harness;
        await readAgUiStream(await handler(startRequest(runAgentInput())));
        await waitForCondition(
          () => bureau.tasks.detail(listHeldTasks(bureau)[0]!.id)?.status === 'completed',
          'run did not settle',
        );
        const entries = [
          { interruptId: bureau.reviews.list()[0]!.id, status: 'cancelled' as const },
        ];
        // The claimant refuses the approval and dies before it says so.
        const resolve = bureau.reviews.resolve.bind(bureau.reviews);
        spyOn(bureau.reviews, 'resolve').mockImplementationOnce(async (input) => {
          await resolve(input);
          return never();
        });
        void handler(resumeRequest(entries));
        await waitForCondition(() => bureau.reviews.list().length === 0, 'never refused');
        await living.advance(DEFAULT_AG_UI_LEASE_MS);

        const retry = await readAgUiStream(
          await harness.remount({ runtime: living })(resumeRequest(entries, {}, 'client-run-3')),
        );

        expect(retry.at(-1)!.event).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: 'success' },
        });
        expect(listHeldTasks(bureau)).toHaveLength(1);
        expect(charges).toEqual([]);
        // The retry completed the command: its entry is done, and asking again resolves
        // and starts nothing more.
        expect(await ledgerStates(bureau)).toEqual(['completed:superseded']);
        const resolveCalls = (bureau.reviews.resolve as unknown as { mock: { calls: unknown[] } })
          .mock.calls.length;
        const again = await readAgUiStream(
          await harness.remount({ runtime: living })(resumeRequest(entries, {}, 'client-run-4')),
        );
        expect(again.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(
          (bureau.reviews.resolve as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
        ).toBe(resolveCalls);
        expect(listHeldTasks(bureau)).toHaveLength(1);
      },
    );
  });

  it('refuses an approve a retry takes over from a claimant that died before it checked, and runs nothing', async () => {
    const charges: number[] = [];
    const dead = createManualRuntimeServices();
    const living = createManualRuntimeServices();
    await withHarness(
      { ...(await settledWithApproval(charges)), agUi: { runtime: dead } },
      async (harness) => {
        const { handler, bureau } = harness;
        await readAgUiStream(await handler(startRequest(runAgentInput())));
        await waitForCondition(
          () => bureau.tasks.detail(listHeldTasks(bureau)[0]!.id)?.status === 'completed',
          'run did not settle',
        );
        const id = bureau.reviews.list()[0]!.id;
        // The claimant holds the command and dies inside the check that decides whether
        // a run can continue, before it has refused or resolved anything.
        const getSession = bureau.contexts.get.bind(bureau);
        let hung = 0;
        spyOn(bureau.contexts, 'get').mockImplementation(async (...args) => {
          if (hung === 0 && (new Error().stack ?? '').includes('conversationAnswerable')) {
            hung += 1;
            return never();
          }
          return getSession(...args);
        });
        void handler(resumeRequest([resolved(id)]));
        await waitForCondition(() => hung === 1, 'the claimant never reached the check');
        await living.advance(DEFAULT_AG_UI_LEASE_MS);

        const retry = await readAgUiStream(
          await harness.remount({ runtime: living })(
            resumeRequest([resolved(id)], {}, 'client-run-3'),
          ),
        );

        expect(retry[0]!.event).toMatchObject({ code: 'CONTINUATION_UNAVAILABLE' });
        expect(charges).toEqual([]);
        expect(bureau.reviews.list().map((review) => review.id)).toEqual([id]);
        expect(listHeldTasks(bureau)).toHaveLength(1);
        // The refusal released the command, so the way out is still open.
        const cancelled = await readAgUiStream(
          await harness.remount({ runtime: living })(
            resumeRequest([{ interruptId: id, status: 'cancelled' }], {}, 'client-run-4'),
          ),
        );
        expect(cancelled.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(bureau.reviews.list()).toEqual([]);
      },
    );
  });

  it('tells a client that cannot approve it to deny or cancel it, not to send a message', async () => {
    const charges: number[] = [];
    await withHarness(await settledWithApproval(charges), async ({ handler, bureau }) => {
      await readAgUiStream(await handler(startRequest(runAgentInput())));
      await waitForCondition(
        () => bureau.tasks.detail(listHeldTasks(bureau)[0]!.id)?.status === 'completed',
        'run did not settle',
      );
      const id = bureau.reviews.list()[0]!.id;

      const refused = await readAgUiStream(await handler(resumeRequest([resolved(id)])));

      expect(refused[0]!.event).toMatchObject({ code: 'CONTINUATION_UNAVAILABLE' });
      expect((refused[0]!.event as { message: string }).message).toContain('Deny or cancel');
      expect((refused[0]!.event as { message: string }).message).not.toContain(
        'send a new message',
      );
      expect(charges).toEqual([]);
    });
  });
});

describe('a step that asks a human and calls a gated tool', () => {
  const both = {
    kind: 'respond' as const,
    response: {
      content: 'Asking, and charging.',
      toolCalls: [
        {
          id: 'call-1',
          name: 'requestHumanInput',
          arguments: { signalName: 'human-response', prompt: 'Approve this?' },
        },
        { id: 'call-2', name: 'charge-card', arguments: { cents: 500 } },
      ],
    },
  };
  const gateOnlyCharges = (charges: number[]): Toolbox =>
    createToolbox([chargeCardTool(charges)], {
      approvalSecret: SECRET,
      policy: {
        beforeExecute: ({ toolName }) =>
          toolName === 'charge-card' ? gate('Operator approval required') : { allow: true },
      },
    }) as unknown as Toolbox;

  type Interrupts = {
    outcome: { type: string; interrupts?: Array<{ id: string; reason: string }> };
  };
  const interruptsOf = (frames: ReadonlyArray<{ event: unknown }>) =>
    (frames.at(-1)!.event as Interrupts).outcome.interrupts ?? [];

  const stops = {
    'the fixture’s stop': undefined,
    'a stop that also fires on the park': stopWhen.some(
      stopWhen.toolCalled('requestHumanInput'),
      stopWhen.pendingApproval(),
      stopWhen.noToolCalls(),
    ),
  };

  it.each(Object.entries(stops))(
    'offers the human wait, then the approval, and the approval completes (%s)',
    async (_name, stop) => {
      const charges: number[] = [];
      await withHarness(
        {
          script: [both, say('Waiting for the approval.'), say('Charged.')],
          toolbox: gateOnlyCharges(charges),
          storage: 'sqlite',
          ...(stop === undefined ? {} : { stopWhen: stop }),
        },
        async ({ handler, bureau, generate }) => {
          const first = await startUntilInterrupted(handler);
          const parked = await readAgUiStream(await handler(attachThreadRequest('thread-1')));
          const wait = interruptsOf(first.frames).find((i) => i.reason === 'human-wait')!;

          const answered = await readAgUiStream(
            await handler(
              resumeRequest([resolved(wait.id, { decision: 'approve', answer: 'visa' })]),
            ),
          );
          const pending = await readAgUiStream(await handler(attachThreadRequest('thread-1')));
          const approval = interruptsOf(answered).find((i) => i.reason === 'tool-approval')!;
          const approved = await readAgUiStream(
            await handler(resumeRequest([resolved(approval.id)], {}, 'client-run-3')),
          );

          // (c) while the run is parked only the human wait is offered, and the approval after it settles.
          expect(interruptsOf(first.frames).map((i) => i.reason)).toEqual(['human-wait']);
          expect(interruptsOf(parked).map((i) => i.reason)).toEqual(['human-wait']);
          expect(interruptsOf(pending).map((i) => i.reason)).toEqual(['tool-approval']);
          // (a) after the answer the run settles on the approval, and nothing has been charged.
          expect(interruptsOf(answered).map((i) => i.reason)).toEqual(['tool-approval']);
          expect(listHeldTasks(bureau)[0]!.status).toBe('completed');
          // (b) approving runs the tool once and continues from the answer.
          expect(approved.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
          expect(charges).toEqual([500]);
          expect(listHeldTasks(bureau)).toHaveLength(2);
          expect(bureau.reviews.list()).toEqual([]);
          const seen = JSON.stringify(generate.calls.at(-1)!.context.conversation.getMessages());
          expect(seen).toContain('visa');
          expect(seen).toContain('charged');
        },
      );
    },
  );

  it('refuses to resolve an approval no run can continue from, and runs nothing', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        // The run goes on past the gated call, so its conversation ends in an assistant row.
        script: [chargeOnce, say('Waiting for the approval.'), say('Charged.')],
        toolbox: approvalToolbox(charges),
        stopWhen: stopWhen.noToolCalls(),
        storage: 'sqlite',
      },
      async ({ handler, bureau }) => {
        const start = await readAgUiStream(await handler(startRequest(runAgentInput())));
        await waitForCondition(
          () => bureau.tasks.detail(listHeldTasks(bureau)[0]!.id)?.status === 'completed',
          'run did not settle',
        );
        const id = bureau.reviews.list()[0]!.id;
        const entries = [resolved(id)];

        const refused = await readAgUiStream(await handler(resumeRequest(entries)));
        const again = await readAgUiStream(
          await handler(resumeRequest(entries, {}, 'client-run-3')),
        );

        expect(start.length).toBeGreaterThan(0);
        expect(refused).toHaveLength(1);
        expect(refused[0]!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'CONTINUATION_UNAVAILABLE',
        });
        // The entry was released, so a retry gets the same answer rather than "in progress".
        expect(again[0]!.event).toMatchObject({ code: 'CONTINUATION_UNAVAILABLE' });
        expect(charges).toEqual([]);
        expect(bureau.reviews.list().map((review) => review.id)).toEqual([id]);
        expect(listHeldTasks(bureau)).toHaveLength(1);
      },
    );
  });
});

describe('the human’s answer, streamed under the id the run commits it by', () => {
  const askAs = (id: string) => ({
    kind: 'respond' as const,
    response: {
      content: `Asking ${id}.`,
      toolCalls: [
        {
          id,
          name: 'requestHumanInput',
          arguments: { signalName: 'human-response', prompt: `Question ${id}?` },
        },
      ],
    },
  });
  const humanWait = {
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
  };
  const answerOf = (interruptId: string, text: string) =>
    resolved(interruptId, { decision: 'approve', answer: text });
  /**
   * The answer rows a stream shows the client: the `:signal:` user rows its snapshots hold,
   * whether the run had already committed its answer before the stream opened or the resume
   * says what the run will append. A stream that sends one as user-role text instead fails.
   */
  const shownUserRows = (frames: ReadonlyArray<{ event: Event }>) =>
    snapshotUserRows(frames)
      .map((row) => row.id)
      .filter((id) => id.includes(':signal:'));
  const interruptOf = (frames: ReadonlyArray<{ event: unknown }>) =>
    (frames.at(-1)!.event as { outcome: { interrupts: Array<{ id: string }> } }).outcome
      .interrupts[0]!.id;

  it('numbers a second answer to one signal by its park, not by the rows the session holds', async () => {
    await withHarness(
      {
        script: [
          askAs('call-1'),
          askAs('call-2'),
          { kind: 'block', barrier: 'after-second' },
          say('Done.'),
        ],
        storage: 'sqlite',
        ...humanWait,
      },
      async ({ handler, generate }) => {
        const first = await startUntilInterrupted(handler);
        const second = await readAgUiStream(
          await handler(resumeRequest([answerOf(first.interruptIds[0]!, 'first-answer')])),
        );

        const third = new FrameReader(
          await handler(
            resumeRequest([answerOf(interruptOf(second), 'second-answer')], {}, 'client-run-3'),
          ),
        );
        await generate.reached('after-second');
        const opening = await third.until(EventType.STEP_STARTED);
        generate.release('after-second');
        await third.rest();

        expect(userTextRows(second)).toEqual([]);
        expect(userTextRows(opening)).toEqual([]);
        expect(shownUserRows(second)).toEqual([`${first.nativeRunId}:signal:human-response:0`]);
        expect(shownUserRows(opening)).toEqual([
          `${first.nativeRunId}:signal:human-response:0`,
          `${first.nativeRunId}:signal:human-response:1`,
        ]);
      },
    );
  });

  it('is streamed by a retry that finds the answer delivered and the claim unfinished', async () => {
    const dead = createManualRuntimeServices();
    const living = createManualRuntimeServices();
    await withHarness(
      {
        script: [askAs('call-1'), { kind: 'block', barrier: 'next-step' }, say('Done.')],
        storage: 'sqlite',
        agUi: { runtime: dead },
        ...humanWait,
      },
      async (harness) => {
        const first = await startUntilInterrupted(harness.handler);
        const entries = [answerOf(first.interruptIds[0]!, 'yes')];
        // The first attempt delivers the answer and dies before it completes its claim.
        const kv = harness.bureau.internals.kv!;
        const batch = kv.conditionalBatch.bind(kv);
        const completing = barrier();
        const dying = spyOn(kv, 'conditionalBatch').mockImplementation((conditions, operations) => {
          const completes = operations.some(
            (operation) =>
              operation.type === 'set' &&
              operation.key.startsWith('command-ledger:ag-ui-resume:v1') &&
              operation.value.includes('"state":"completed"'),
          );
          if (!completes) return batch(conditions, operations);
          completing.reach();
          return new Promise<boolean>(() => {});
        });
        void harness.handler(resumeRequest(entries));
        await completing.reached;
        dying.mockRestore();
        await harness.generate.reached('next-step');
        await living.advance(DEFAULT_AG_UI_LEASE_MS);

        const retry = new FrameReader(
          await harness.remount({ runtime: living })(resumeRequest(entries, {}, 'client-run-3')),
        );
        const opening = await retry.until(EventType.STEP_STARTED);
        harness.generate.release('next-step');
        await retry.rest();

        expect(userTextRows(opening)).toEqual([]);
        expect(shownUserRows(opening)).toEqual([`${first.nativeRunId}:signal:human-response:0`]);
      },
    );
  });

  /**
   * A stream opens on the conversation as it stands, and a run appends its answer row only once it
   * wakes. Hiding the live run's transcript puts every stream on the side of that race where the
   * row is not there yet, so the answer can reach the client only through the resume that says what
   * it was (COR-1632).
   */
  const withTranscriptHidden = (bureau: Harness['bureau']) => {
    const getRun = bureau.tasks.detail.bind(bureau.tasks);
    return spyOn(bureau.tasks, 'detail').mockImplementation((runId) => {
      const detail = getRun(runId);
      return detail === undefined ? detail : { ...detail, transcript: undefined };
    });
  };

  it('shows the answer in the opening snapshot of a retry that joins the attempt still applying it', async () => {
    await withHarness(
      {
        script: [askAs('call-1'), { kind: 'block', barrier: 'after-answer' }, say('Done.')],
        storage: 'sqlite',
        ...humanWait,
      },
      async ({ handler, bureau, generate }) => {
        const first = await startUntilInterrupted(handler);
        const entries = [answerOf(first.interruptIds[0]!, 'yes')];
        const resolve = spyOn(bureau.reviews, 'resolve');
        withTranscriptHidden(bureau);

        const applying = handler(resumeRequest(entries));
        const joining = handler(resumeRequest(entries, {}, 'client-run-3'));
        const left = new FrameReader(await applying);
        const right = new FrameReader(await joining);
        const leftOpening = await left.until(EventType.STATE_SNAPSHOT);
        const rightOpening = await right.until(EventType.STATE_SNAPSHOT);
        generate.release('after-answer');
        await left.rest();
        await right.rest();

        // One attempt applied the answer, and the other joined it.
        expect(resolve).toHaveBeenCalledTimes(1);
        const id = `${first.nativeRunId}:signal:human-response:0`;
        expect(userTextRows(rightOpening)).toEqual([]);
        expect(shownUserRows(leftOpening)).toEqual([id]);
        expect(shownUserRows(rightOpening)).toEqual([id]);
      },
    );
  });

  it('shows the answer in the opening snapshot of a retry that finds the command already completed', async () => {
    await withHarness(
      {
        script: [askAs('call-1'), { kind: 'block', barrier: 'after-answer' }, say('Done.')],
        storage: 'sqlite',
        ...humanWait,
      },
      async ({ handler, bureau, generate }) => {
        const first = await startUntilInterrupted(handler);
        const entries = [answerOf(first.interruptIds[0]!, 'yes')];
        withTranscriptHidden(bureau);

        const applying = new FrameReader(await handler(resumeRequest(entries)));
        await applying.until(EventType.STATE_SNAPSHOT);
        // The ledger now says the command completed, while the run is still going.
        const retry = new FrameReader(await handler(resumeRequest(entries, {}, 'client-run-3')));
        const opening = await retry.until(EventType.STATE_SNAPSHOT);
        generate.release('after-answer');
        await applying.rest();
        await retry.rest();

        expect(userTextRows(opening)).toEqual([]);
        expect(shownUserRows(opening)).toEqual([`${first.nativeRunId}:signal:human-response:0`]);
      },
    );
  });

  it('names the answer to a step that asks under two signals by the park the review names', async () => {
    const askBoth = {
      kind: 'respond' as const,
      response: {
        content: 'Asking twice.',
        toolCalls: ['first-question', 'second-question'].map((signalName, index) => ({
          id: `call-${index + 1}`,
          name: 'requestHumanInput',
          arguments: { signalName, prompt: `Question on ${signalName}?` },
        })),
      },
    };
    await withHarness(
      {
        script: [askBoth, { kind: 'block', barrier: 'after-answer' }, say('Done.')],
        ...humanWait,
      },
      async ({ handler, bureau, generate }) => {
        const first = await startUntilInterrupted(handler);
        const answering = new FrameReader(
          await handler(resumeRequest([answerOf(first.interruptIds.at(-1)!, 'an answer')])),
        );
        await generate.reached('after-answer');
        const opening = await answering.until(EventType.STEP_STARTED);
        generate.release('after-answer');
        await answering.rest();

        const committed = bureau.tasks
          .detail(first.nativeRunId)!
          .transcript!.ids.filter((id) => id.includes(':signal:'));
        expect(committed).toHaveLength(1);
        expect(userTextRows(opening)).toEqual([]);
        expect(shownUserRows(opening)).toEqual(committed);
      },
    );
  });
});
