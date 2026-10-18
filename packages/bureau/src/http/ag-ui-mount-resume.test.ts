/**
 * COR-855 — resuming a run. A resume is a new authorized command recorded in the
 * command ledger, never an in-place change to a request in flight: it resolves
 * the reviews its entries answer and opens a new stream, on the same native run
 * for a human wait and on a fresh one for a tool approval.
 */
import { EventType, type ResumeEntry } from '@ag-ui/core';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { stopWhen, type Toolbox, waitForCondition } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import {
  as,
  authentication,
  cancelRequest,
  type Handler,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { bureauMetadata, readAgUiStream, typesOf } from './ag-ui-stream.test-support.ts';

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
        expect(bureau.listRuns()).toHaveLength(2);
        // The conversation the new run ended with answers the call once.
        const session = await bureau.getSession('thread-1');
        const history = session?.conversationHistory;
        const rows = history?.ids.map((id) => history.messages[id]!) ?? [];
        expect(rows.filter((row) => row.toolResult?.callId === 'call-1')).toHaveLength(1);
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
        const session = await bureau.getSession('thread-1');
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
        expect(bureau.listPendingReviews()).toHaveLength(1);
        const denied = await readAgUiStream(
          await handler(resumeRequest([resolved(id, { decision: 'deny', reason: 'Too much' })])),
        );
        expect(denied.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        const audit = JSON.stringify(await bureau.auditTrail?.query({}));
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
        expect(bureau.listPendingReviews()).toHaveLength(2);
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
        expect(bureau.listPendingReviews()).toHaveLength(1);
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
        expect(bureau.listPendingReviews()).toHaveLength(1);
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
        const resolve = spyOn(bureau, 'resolveReview');
        const runsBefore = bureau.listRuns().length;

        // A client that mints a fresh runId for its retry is still a retry.
        const retry = await readAgUiStream(
          await handler(resumeRequest(entries, {}, 'client-run-3')),
        );

        expect(resolve).not.toHaveBeenCalled();
        expect(bureau.listRuns()).toHaveLength(runsBefore);
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
        const resolve = spyOn(bureau, 'resolveReview');

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
        expect(bureau.listRuns()).toHaveLength(2);
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
        const runsBefore = bureau.listRuns().length;

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
        expect(bureau.listRuns()).toHaveLength(runsBefore);
        expect(charges).toEqual([]);
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
        const createRun = spyOn(bureau, 'createRun').mockRejectedValueOnce(new Error('disk full'));

        const failed = await readAgUiStream(
          await handler(resumeRequest([resolved(first.interruptIds[0]!)])),
        );
        createRun.mockRestore();
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
  /** A promise that never settles: a process that died mid-call. */
  const never = <T>(): Promise<T> => new Promise<T>(() => {});

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
        const resolve = spyOn(bureau, 'resolveReview').mockRejectedValueOnce(
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

  it('is taken over by a retry after a restart, which applies it', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
      },
      async (harness) => {
        const first = await startUntilInterrupted(harness.handler);
        const entries = [resolved(first.interruptIds[0]!)];
        // The first process claims the resume and dies before it resolves anything.
        const resolve = spyOn(harness.bureau, 'resolveReview').mockImplementationOnce(() =>
          never(),
        );
        void harness.handler(resumeRequest(entries));
        await waitForCondition(() => resolve.mock.calls.length === 1, 'the resume never started');
        resolve.mockRestore();

        const retry = await readAgUiStream(
          await harness.remount()(resumeRequest(entries, {}, 'client-run-3')),
        );

        expect(retry.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(charges).toEqual([500]);
      },
    );
  });

  it('is finished by a retry after a restart when its approvals were applied but its run was not started', async () => {
    const charges: number[] = [];
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
      },
      async (harness) => {
        const first = await startUntilInterrupted(harness.handler);
        const entries = [resolved(first.interruptIds[0]!)];
        const createRun = spyOn(harness.bureau, 'createRun').mockImplementationOnce(() => never());
        void harness.handler(resumeRequest(entries));
        await waitForCondition(() => createRun.mock.calls.length === 1, 'the run never started');
        createRun.mockRestore();
        expect(harness.bureau.listPendingReviews()).toHaveLength(0);

        const retry = await readAgUiStream(
          await harness.remount()(resumeRequest(entries, {}, 'client-run-3')),
        );
        const again = await readAgUiStream(
          await harness.handler(resumeRequest(entries, {}, 'client-run-4')),
        );

        expect(retry.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(charges).toEqual([500]);
        expect(harness.bureau.listRuns()).toHaveLength(2);
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
        const store = bureau.sessionStore!;
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
        const runsBefore = bureau.listRuns().length;

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
        expect(bureau.listRuns()).toHaveLength(runsBefore);
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
        expect(bureau.listPendingReviews()).toEqual([]);
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
        const keys = () => bureau.kv!.list('command-ledger:ag-ui-resume:v1:entry:');
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

        const ran = await bureau.runDurableMaintenance();

        expect(ran).toBe(true);
        expect(diagnostics).toEqual([]);
        // The receipt for the run the first start created is still there.
        const located = await bureau.locateRunCreationReceipt({
          principal: 'anonymous:local',
          agentName: 'assistant',
          runCreationRequestId: 'client-run-1',
        });
        expect(located.status).toBe('recorded');
      },
    );
  });
});

describe('resuming a human wait', () => {
  it('streams the human’s answer as a user message under the id the conversation holds it by', async () => {
    await withHarness(
      {
        script: [askHuman, say('Thanks for the answer.')],
        humanInput: true,
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
        const events = frames.map((frame) => frame.event);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: EventType.TEXT_MESSAGE_START,
            messageId: id,
            role: 'user',
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: id,
            delta: '[signal:human-response] "yes"',
          }),
        );
        // The run's own conversation holds the answer under the id the stream gave it.
        expect(bureau.getRun(first.nativeRunId)!.transcript!.ids).toContain(id);
      },
    );
  });

  it('continues the same native run, delivering the answer, and ends the new stream when the run does', async () => {
    await withHarness(
      {
        script: [askHuman, say('Thanks for the answer.')],
        humanInput: true,
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
        expect(bureau.listRuns()).toHaveLength(1);
        // The model was given the human's answer on the continuation.
        const continuation = generate.calls.at(-1)!.context.conversation;
        expect(JSON.stringify(continuation.getMessages())).toContain('yes');
      },
    );
  });
});
