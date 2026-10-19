/**
 * COR-1596 — a schedule fire's human waits and tool approvals are pending reviews, so the inbox
 * can unblock an unattended run.
 *
 * A fire runs headless on the durable engine: it has no live run in Bureau's run store and no
 * caller to receive an `action_required` result. Before this, `bureau.reviews.list` named
 * neither its human wait nor its tool approval, and `bureau.tasks.respond` found nothing to
 * answer. These tests drive the fire the way the crash test does, with the engine's timers in
 * manual mode, so nothing waits on the clock.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  type StepResult,
  stopWhen,
  type Toolbox,
} from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import {
  createTool,
  createToolbox,
  type PendingToolApproval,
  type ToolExecutionResult,
} from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { createBureau, createScheduledFireApprovalHook } from './create-bureau';
import { createBureauHandler } from './http/create-bureau-handler.ts';
import { authentication, OWNER, rpc } from './http/management/management-fixtures.test-support.ts';
import { isScheduledFireAuthority, scheduledFireApprovalMetadata } from './runtime-composition';
import type { Bureau, BureauOptions, PendingReview } from './types';

const bureaus: Bureau[] = [];
const databasePaths: string[] = [];
let databaseCounter = 0;

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const path of databasePaths.splice(0)) {
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
  }
});

async function pollUntil<T>(
  check: () => T | undefined | Promise<T | undefined>,
  what: string,
  attempts = 600,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await check();
    if (value !== undefined) return value;
    await yieldToPortableEventLoop();
  }
  throw new Error(`Condition was not met: ${what}`);
}

function nextDatabasePath(): string {
  const path = join(
    tmpdir(),
    `bureau-schedule-fire-reviews-${process.pid}-${databaseCounter++}.sqlite`,
  );
  databasePaths.push(path);
  return path;
}

/** A model that asks for a human answer on step 0 and thanks the operator once resumed. */
function askingGenerate(signalName = 'answer', seen: string[] = []): GenerateFunction {
  return async (context: GenerateContext) => {
    if (context.step === 0) {
      return {
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'requestHumanInput',
            arguments: { signalName, prompt: 'Which environment?' },
          },
        ],
      };
    }
    seen.push(JSON.stringify(context.conversation.current));
    return { content: 'thanks', toolCalls: [] };
  };
}

/** A tool whose every call parks on operator approval, and which records each execution. */
function approvalToolbox(charges: number[]): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret: 'schedule-fire-reviews-secret',
      policy: {
        beforeExecute: () => ({
          allow: false,
          status: 'needs_approval',
          reason: 'Operator approval required',
          action: { message: 'Approve charge' },
        }),
      },
    },
  ) as unknown as Toolbox;
}

const chargesOnce: GenerateFunction = async (context) =>
  context.step === 0
    ? {
        content: '',
        toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 4242 } }],
      }
    : { content: 'charged', toolCalls: [] };

async function open(options: Partial<BureauOptions> = {}): Promise<Bureau> {
  const bureau = await createBureau({
    id: 'schedule-fire-reviews-bureau',
    agents: {},
    storage: { type: 'memory' },
    durableExecution: true,
    durableBackgroundTasks: 'manual',
    durableOwnership: { ownership: 'none' },
    toolbox: createToolbox([]),
    stopWhen: stopWhen.noToolCalls(),
    ...options,
  });
  bureaus.push(bureau);
  return bureau;
}

/** Registers a schedule owned by `principal` and ticks it once; the fire is its current run. */
async function fireOnce(
  bureau: Bureau,
  principal: string = OWNER.alice,
  sessionId?: string,
): Promise<{ readonly scheduleId: string; readonly fireId: string }> {
  const created = await bureau.createSchedule({
    agentName: 'researcher',
    input: 'check in',
    spec: '1m',
    principal,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  const occurrence = created?.nextFireAt;
  if (created === undefined || occurrence === null || occurrence === undefined) {
    throw new Error('The schedule has no first occurrence.');
  }
  await bureau.runDurableMaintenance(occurrence);
  const fireId = await pollUntil(async () => {
    const schedule = await bureau.getSchedule(created.id);
    return schedule?.currentWorkflowId;
  }, 'the tick to launch a fire');
  return { scheduleId: created.id, fireId };
}

const reviewsOf = (bureau: Bureau, runId: string): PendingReview[] =>
  bureau.listPendingReviews().filter((review) => review.runId === runId);

async function reviewOf(bureau: Bureau, runId: string): Promise<PendingReview> {
  return pollUntil(() => reviewsOf(bureau, runId)[0], `a pending review of run ${runId}`);
}

async function durableStatus(bureau: Bureau, runId: string): Promise<string | undefined> {
  const run = await bureau.getDurableRun(runId);
  return run?.status;
}

function handlerOf(bureau: Bureau) {
  return createBureauHandler(bureau, { authentication });
}

describe('a schedule fire’s human wait', () => {
  it('is a pending review of the fire, answerable through bureau.tasks.respond', async () => {
    const seen: string[] = [];
    const bureau = await open({
      generate: askingGenerate('answer', seen),
      humanInput: true,
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });
    const { fireId } = await fireOnce(bureau);

    const review = await reviewOf(bureau, fireId);
    expect(review).toMatchObject({
      kind: 'human-wait',
      runId: fireId,
      signalName: 'answer',
      prompt: 'Which environment?',
      status: 'pending',
    });
    // The session is the fire's own: the task names it as its context.
    const task = await bureau.tasks.record(fireId);
    expect(review.sessionId).toBe(task?.contextId);
    expect(review.sessionId).toBeTruthy();

    // The inbox sees it as the owner, with the session the fire ran in.
    const handler = handlerOf(bureau);
    const listed = await rpc(handler, 'bureau.reviews.list', {}, 'alice-key');
    expect(listed.result?.['reviews']).toEqual([
      expect.objectContaining({ id: review.id, runId: fireId, sessionId: review.sessionId }),
    ]);
    // Another owner's inbox does not.
    const bobsInbox = await rpc(handler, 'bureau.reviews.list', {}, 'bob-key');
    expect(bobsInbox.result?.['reviews']).toEqual([]);
    // The task is held open by it.
    const view = await rpc(handler, 'bureau.tasks.get', { taskId: fireId }, 'alice-key');
    expect(view.result).toMatchObject({
      id: fireId,
      status: 'input-required',
      openWaits: [{ kind: 'human-wait', reviewId: review.id, signalName: 'answer' }],
    });

    const answered = await rpc(
      handler,
      'bureau.tasks.respond',
      { taskId: fireId, messageId: 'm1', answer: 'staging' },
      'alice-key',
    );
    expect(answered.error).toBeUndefined();
    expect(answered.result).toMatchObject({
      taskId: fireId,
      kind: 'human-wait',
      receipt: 'applied',
    });

    await pollUntil(
      async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
      'the fire to complete',
    );
    expect(seen.join('')).toContain('staging');
    expect(bureau.listPendingReviews()).toEqual([]);
  });
});

describe('a schedule fire’s tool approval', () => {
  it('is a pending review of the fire, and approving it runs the tool and releases the task', async () => {
    const charges: number[] = [];
    const bureau = await open({
      generate: chargesOnce,
      toolbox: approvalToolbox(charges),
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
    });
    const { fireId } = await fireOnce(bureau);

    const review = await reviewOf(bureau, fireId);
    expect(review).toMatchObject({
      kind: 'tool-approval',
      id: `approval:${fireId}:charge-1`,
      runId: fireId,
      status: 'pending',
    });
    const task = await bureau.tasks.record(fireId);
    expect(review.sessionId).toBe(task?.contextId);
    expect(review.sessionId).toBeTruthy();

    const handler = handlerOf(bureau);
    const listed = await rpc(handler, 'bureau.reviews.list', {}, 'alice-key');
    expect(listed.result?.['reviews']).toEqual([
      expect.objectContaining({ id: review.id, runId: fireId, sessionId: review.sessionId }),
    ]);
    const held = await rpc(handler, 'bureau.tasks.get', { taskId: fireId }, 'alice-key');
    expect(held.result).toMatchObject({ id: fireId, status: 'input-required' });

    // The owner resolves a review of its own run with no operator scope.
    const approved = await rpc(
      handler,
      'bureau.reviews.resolve',
      { id: review.id, decision: 'approve' },
      'alice-key',
    );
    expect(approved.error).toBeUndefined();
    expect(approved.result).toMatchObject({
      id: review.id,
      kind: 'tool-approval',
      receipt: 'applied',
    });
    expect(charges).toEqual([4242]);

    expect(bureau.listPendingReviews()).toEqual([]);
    const released = await rpc(handler, 'bureau.tasks.get', { taskId: fireId }, 'alice-key');
    expect(released.result?.['status']).not.toBe('input-required');
  });

  it('is denied without running the tool', async () => {
    const charges: number[] = [];
    const bureau = await open({
      generate: chargesOnce,
      toolbox: approvalToolbox(charges),
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
    });
    const { fireId } = await fireOnce(bureau);
    const review = await reviewOf(bureau, fireId);

    await bureau.resolveReview({ id: review.id, decision: 'deny', principal: OWNER.alice });

    expect(charges).toEqual([]);
    expect(bureau.listPendingReviews()).toEqual([]);
  });

  it('leaves a bureau.run() approval unlisted, as COR-1302 requires', async () => {
    const charges: number[] = [];
    const bureau = await open({
      agents: {
        payer: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
    });

    const run = bureau.run('payer', 'charge it', { principal: OWNER.alice });
    await run.result();

    expect(bureau.listPendingReviews()).toEqual([]);
    expect(charges).toEqual([]);
  });
});

describe('a schedule fire’s human wait after a restart', () => {
  it('is listed at boot under the id it had, with the fire’s session, and answering it completes the run', async () => {
    const databasePath = nextDatabasePath();
    const storage = { type: 'sqlite' as const, path: databasePath };
    const humanInputOptions = {
      humanInput: true,
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    };
    const crashed = await open({ ...humanInputOptions, generate: askingGenerate(), storage });
    const { fireId } = await fireOnce(crashed);
    const original = await reviewOf(crashed, fireId);
    // The first Bureau is not disposed: a graceful shutdown would cancel the parked fire and
    // leave nothing for the restart to recover.

    const seen: string[] = [];
    const restarted = await open({
      ...humanInputOptions,
      generate: askingGenerate('answer', seen),
      storage,
    });
    const restored = await reviewOf(restarted, fireId);

    expect(restored).toMatchObject({
      kind: 'human-wait',
      id: original.id,
      runId: fireId,
      signalName: 'answer',
      prompt: 'Which environment?',
      sessionId: original.sessionId,
    });
    expect(await restarted.getOwner({ kind: 'review', id: restored.id })).toBe(OWNER.alice);
    const inbox = await rpc(handlerOf(restarted), 'bureau.reviews.list', {}, 'alice-key');
    expect(inbox.result?.['reviews']).toEqual([
      expect.objectContaining({ id: original.id, runId: fireId, sessionId: original.sessionId }),
    ]);

    const answered = await rpc(
      handlerOf(restarted),
      'bureau.tasks.respond',
      { taskId: fireId, messageId: 'm1', answer: 'prod' },
      'alice-key',
    );
    expect(answered.error).toBeUndefined();
    await pollUntil(
      async () => ((await durableStatus(restarted, fireId)) === 'completed' ? true : undefined),
      'the recovered fire to complete',
    );
    expect(seen.join('')).toContain('prod');
    expect(restarted.listPendingReviews()).toEqual([]);
  });
});

describe('a schedule fire’s tool approval after a restart', () => {
  it('is listed at boot with the fire’s session, and approving it runs the tool in the new process', async () => {
    const databasePath = nextDatabasePath();
    const storage = { type: 'sqlite' as const, path: databasePath };
    const approvalOptions = (charges: number[]) => ({
      generate: chargesOnce,
      toolbox: approvalToolbox(charges),
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
      storage,
    });
    const before: number[] = [];
    const first = await open(approvalOptions(before));
    const { fireId } = await fireOnce(first);
    const original = await reviewOf(first, fireId);
    // Let the fire end, so the approval is all that is left of it.
    await pollUntil(
      async () => ((await durableStatus(first, fireId)) === 'completed' ? true : undefined),
      'the fire to end at its approval',
    );

    const after: number[] = [];
    const restarted = await open(approvalOptions(after));
    const restored = await reviewOf(restarted, fireId);

    expect(restored).toMatchObject({
      kind: 'tool-approval',
      id: original.id,
      runId: fireId,
      sessionId: original.sessionId,
      status: 'pending',
    });
    expect(await restarted.getOwner({ kind: 'review', id: restored.id })).toBe(OWNER.alice);
    const approved = await rpc(
      handlerOf(restarted),
      'bureau.reviews.resolve',
      { id: restored.id, decision: 'approve' },
      'alice-key',
    );
    expect(approved.error).toBeUndefined();
    expect(after).toEqual([4242]);
    expect(before).toEqual([]);
    expect(restarted.listPendingReviews()).toEqual([]);
  });
});

describe('a schedule fire’s reviews end with the fire', () => {
  it('drops a human wait once the fire is canceled', async () => {
    const bureau = await open({
      generate: askingGenerate(),
      humanInput: true,
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });
    const { fireId } = await fireOnce(bureau);
    await reviewOf(bureau, fireId);

    await bureau.durableEngine()!.cancel(fireId);

    await pollUntil(
      () => (bureau.listPendingReviews().length === 0 ? true : undefined),
      'the canceled fire’s wait to leave the list',
    );
  });

  it('offers a fire no requestHumanInput without the option, so it cannot park', async () => {
    const bureau = await open({
      generate: askingGenerate(),
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });
    const { fireId } = await fireOnce(bureau);

    await pollUntil(
      async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
      'the fire to end',
    );
    expect(bureau.listPendingReviews()).toEqual([]);
  });
});

describe('the records a fire’s tool approval leaves', () => {
  const approval = (callId: string): PendingToolApproval => ({
    callId,
    toolName: 'charge-card',
    arguments: { cents: 425 },
    action: { type: 'input' },
  });
  const paused = (pendingApproval: PendingToolApproval): ToolExecutionResult => ({
    callId: pendingApproval.callId,
    toolCallId: pendingApproval.callId,
    toolName: pendingApproval.toolName,
    outcome: 'action_required',
    content: null,
    result: null,
    pendingApproval,
  });
  const stepWith = (...pending: PendingToolApproval[]): StepResult => ({
    parts: [],
    messageId: undefined,
    step: 0,
    conversation: new Conversation(),
    content: '',
    toolCalls: [],
    results: pending.map(paused),
    final: false,
  });
  const requestContext = {
    authority: {
      principalId: 'system:scheduler',
      tenantId: 'bureau',
      ownerId: 'researcher',
      capabilities: ['tools:execute'],
      authorizationRevision: 'scheduler:1',
    },
    audience: 'operator' as const,
    agentId: 'researcher',
  };

  it('registers one review when the same step replays, and one per distinct call', async () => {
    const registered: string[] = [];
    const hook = createScheduledFireApprovalHook('fire-1', (reviewId) => {
      registered.push(reviewId);
    });

    await hook(stepWith(approval('charge-call')));
    await hook(stepWith(approval('charge-call')));
    expect(new Set(registered)).toEqual(new Set(['approval:fire-1:charge-call']));

    // The control: the key collapses a replay, not two different tool calls.
    registered.length = 0;
    await hook(stepWith(approval('charge-call'), approval('refund-call')));
    expect(registered).toEqual(['approval:fire-1:charge-call', 'approval:fire-1:refund-call']);
  });

  it('records the approval, its round, and a fire’s authority, the same on a replay', () => {
    const first = scheduledFireApprovalMetadata(
      {},
      'fire-1',
      stepWith(approval('charge-call')).results,
      requestContext,
    );
    const replayed = scheduledFireApprovalMetadata(
      first,
      'fire-1',
      stepWith(approval('charge-call')).results,
      requestContext,
    );

    expect(replayed).toEqual(first);
    expect(Object.keys(first['pendingApprovalOverrides'] as object)).toEqual([
      'approval:fire-1:charge-call',
    ]);
    expect(first['pendingApprovalRounds']).toEqual({ 'approval:fire-1:charge-call': 0 });
    expect(isScheduledFireAuthority(first as never, 'fire-1')).toBe(true);
    // A session run's authority record carries no such marker, so its restore is unchanged.
    expect(isScheduledFireAuthority(first as never, 'another-run')).toBe(false);
  });

  it('keeps a round a re-gate has already counted, and writes nothing for a step with no approval', () => {
    const counted = scheduledFireApprovalMetadata(
      { pendingApprovalRounds: { 'approval:fire-1:charge-call': 2 } },
      'fire-1',
      stepWith(approval('charge-call')).results,
      requestContext,
    );

    expect(counted['pendingApprovalRounds']).toEqual({ 'approval:fire-1:charge-call': 2 });
    expect(scheduledFireApprovalMetadata({}, 'fire-1', stepWith().results, requestContext)).toEqual(
      {},
    );
  });
});
