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
import { createAgent, type StepResult, stopWhen } from '@lostgradient/operative';
import { type PendingToolApproval, type ToolExecutionResult } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createScheduledFireApprovalHook } from './create-bureau';
import { OWNER, rpc } from './http/management/management-fixtures.test-support.ts';
import { isScheduledFireAuthority, scheduledFireApprovalMetadata } from './runtime-composition';
import {
  approvalToolbox,
  askingGenerate,
  chargesOnce,
  createScheduleFireHarness,
  durableStatus,
  fireOnce,
  handlerOf,
  pollUntil,
  reviewOf,
} from './schedule-fire-fixtures.test-support';

const harness = createScheduleFireHarness();
const { open, nextDatabasePath } = harness;

afterEach(async () => {
  await harness.dispose();
});

describe('a schedule fire’s human wait', () => {
  it('is a pending review of the fire, answerable through bureau.tasks.respond', async () => {
    const seen: string[] = [];
    const bureau = await open({
      agents: {
        default: createAgent({
          generate: askingGenerate('answer', seen),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
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
    const task = await bureau.internals.taskRegistry.record(fireId);
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
    expect(bureau.reviews.list()).toEqual([]);
  });
});

describe('a schedule fire’s tool approval', () => {
  it('is a pending review of the fire, and approving it runs the tool and releases the task', async () => {
    const charges: number[] = [];
    const bureau = await open({
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
    });
    const { fireId } = await fireOnce(bureau);

    const review = await reviewOf(bureau, fireId);
    expect(review).toMatchObject({
      kind: 'tool-approval',
      id: `approval:${fireId}:charge-1`,
      runId: fireId,
      status: 'pending',
    });
    const task = await bureau.internals.taskRegistry.record(fireId);
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

    // The conversation shows the executed result, not the approval as pending.
    const session = await bureau.getSession(review.sessionId ?? '');
    const history = session?.conversationHistory;
    const row = history?.ids
      .map((id) => history.messages[id])
      .find((message) => message?.toolResult?.callId === 'charge-1');
    expect(row?.toolResult?.outcome).toBe('success');

    expect(bureau.reviews.list()).toEqual([]);
    const released = await rpc(handler, 'bureau.tasks.get', { taskId: fireId }, 'alice-key');
    expect(released.result?.['status']).not.toBe('input-required');
  });

  it('is denied without running the tool', async () => {
    const charges: number[] = [];
    const bureau = await open({
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
    });
    const { fireId } = await fireOnce(bureau);
    const review = await reviewOf(bureau, fireId);

    await bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: OWNER.alice });

    expect(charges).toEqual([]);
    expect(bureau.reviews.list()).toEqual([]);
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

    expect(bureau.reviews.list()).toEqual([]);
    expect(charges).toEqual([]);
  });
});

describe('a schedule fire’s human wait after a restart', () => {
  it('is listed at boot under the id it had, with the fire’s session, and answering it completes the run', async () => {
    const databasePath = nextDatabasePath();
    const storage = { type: 'sqlite' as const, path: databasePath };
    const humanInputOptions = {
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    };
    const crashed = await open({
      ...humanInputOptions,
      storage,
      agents: { default: createAgent({ generate: askingGenerate() }) },
    });
    const { fireId } = await fireOnce(crashed);
    const original = await reviewOf(crashed, fireId);
    // The first Bureau is not disposed: a graceful shutdown would cancel the parked fire and
    // leave nothing for the restart to recover.

    const seen: string[] = [];
    const restarted = await open({
      ...humanInputOptions,
      storage,
      agents: { default: createAgent({ generate: askingGenerate('answer', seen) }) },
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
    expect(restarted.reviews.list()).toEqual([]);
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
    expect(restarted.reviews.list()).toEqual([]);
    // Decided after the restart, the fire's authority and round leave its session as they do live.
    const session = await restarted.getSession(restored.sessionId ?? '');
    expect(Object.keys(session?.metadata['lastRequestAuthorities'] ?? {})).toEqual([]);
    expect(Object.keys(session?.metadata['pendingApprovalRounds'] ?? {})).toEqual([]);
  });
});

describe('a schedule fire’s reviews end with the fire', () => {
  it('drops a human wait once the fire is canceled', async () => {
    const bureau = await open({
      agents: {
        default: createAgent({
          generate: askingGenerate(),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
    });
    const { fireId } = await fireOnce(bureau);
    await reviewOf(bureau, fireId);

    await bureau.durableEngine()!.cancel(fireId);

    await pollUntil(
      () => (bureau.reviews.list().length === 0 ? true : undefined),
      'the canceled fire’s wait to leave the list',
    );
  });

  it('offers a fire no requestHumanInput under humanInput: false, so it cannot park', async () => {
    const bureau = await open({
      humanInput: false,
      agents: {
        default: createAgent({
          generate: askingGenerate(),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
    });
    const { fireId } = await fireOnce(bureau);

    await pollUntil(
      async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
      'the fire to end',
    );
    expect(bureau.reviews.list()).toEqual([]);
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
