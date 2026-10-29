/**
 * `bureau.tasks.respond` over a ledger shared by several attempts: a refusing attempt
 * leaves another attempt's claim alone, and a review someone else resolved is not this
 * caller's receipt. Each test drives the operation over a real command ledger and a host
 * that stands for a process which cannot see the run.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { Principal } from '@lostgradient/weft';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { BureauError, TaskRespondError } from '../../create-bureau.ts';
import {
  type CommandLedgerIdentity,
  createCommandLedger,
  digestCommandPayload,
} from '../../command-ledger.ts';
import { apiKeyOwner } from '../../owner-of-record.ts';
import {
  createTaskResponder,
  type TaskResponderDependencies,
  type TasksRespondClaim,
  TASKS_RESPOND_LEDGER_KEY_PREFIX,
  TASKS_RESPOND_OPERATION_VERSION,
} from '../../tasks/respond-to-task.ts';
import type { PendingReview, ReviewStatus, TaskRespondResult } from '../../types.ts';
import { mayAccessOwnedResource } from '../owner-predicate.ts';
import {
  type BureauTasksRespondOperationHost,
  tasksRespondOperation,
} from './tasks-respond-operation.ts';

type TasksRespondResult = TaskRespondResult;
type ReviewsOf = TaskResponderDependencies['reviews'];

const owner = apiKeyOwner('alice');
const reviewId = 'human-wait:run-1:human-response:0';
const principal = {
  method: 'api-key',
  subject: 'alice',
  scopes: new Set(),
  claims: undefined,
  hasScope: () => false,
} as unknown as Principal;
const input = { taskId: 'run-1', messageId: 'm1', answer: 'go' };
const identity: CommandLedgerIdentity = {
  callerId: owner,
  target: 'run-1',
  requestId: 'm1',
  operationVersion: TASKS_RESPOND_OPERATION_VERSION,
};
const digest = digestCommandPayload({ answer: 'go' });
const original: TasksRespondResult = {
  taskId: 'run-1',
  messageId: 'm1',
  reviewId,
  kind: 'human-wait',
  decision: 'approve',
  receipt: 'applied',
};

function newLedger() {
  const runtime = createDefaultRuntimeServices();
  return createCommandLedger<TasksRespondClaim, TasksRespondResult>({
    kv: textValueStore(new MemoryStorage()),
    keyPrefix: TASKS_RESPOND_LEDGER_KEY_PREFIX,
    clock: runtime.clock,
    nextConflictId: () => runtime.identifiers.next('respond-conflict'),
  });
}

const openWait = { kind: 'human-wait' as const, reviewId, signalName: 'human-response' };
const approvalReviewId = 'approval:run-1:call-1';
const approvalWait = {
  kind: 'tool-approval' as const,
  reviewId: approvalReviewId,
  callId: 'call-1',
};

function hostOver(
  ledger: ReturnType<typeof newLedger>,
  options: {
    openWaits: readonly (typeof openWait | typeof approvalWait)[];
    getReview: ReviewsOf['get'];
    resolveReview?: ReviewsOf['resolve'];
    /** The task has no record any more, as after task retention. */
    taskGone?: boolean;
  },
): BureauTasksRespondOperationHost {
  const task = {
    id: 'run-1',
    contextId: 'context-1',
    agentName: 'default',
    owner,
    status: 'input-required' as const,
    finishReason: null,
    statusMessage: null,
    createdAt: 'then',
    updatedAt: 'then',
    actor: null,
    kind: 'chat' as const,
    origin: null,
    cleanup: null,
    openWaits: options.openWaits,
  };
  const tasks = options.taskGone
    ? { get: async () => undefined, ownerOf: async () => undefined }
    : { get: async () => task, ownerOf: async () => owner };
  const responder = createTaskResponder({
    registry: tasks,
    reviews: {
      get: options.getReview,
      resolve:
        options.resolveReview ??
        (async () => {
          throw new Error('resolveReview must not be reached');
        }),
    },
    ledger,
    refusal: (refusal) => new TaskRespondError(refusal),
    isRefusal: (error): error is BureauError => error instanceof BureauError,
  });
  return {
    ownership: { runOwner: async () => owner, mayAccess: mayAccessOwnedResource },
    tasks,
    respond: responder.respond,
  };
}

async function faultOf(host: BureauTasksRespondOperationHost): Promise<unknown> {
  try {
    await tasksRespondOperation.invoke({ input, host, principal } as never);
  } catch (error) {
    return error;
  }
  throw new Error('expected the command to be refused');
}

const resolved = (status: ReviewStatus, resolvedBy: string | undefined) =>
  ({
    kind: 'human-wait',
    id: reviewId,
    runId: 'run-1',
    sessionId: 'context-1',
    signalName: 'human-response',
    requestedAt: 1,
    ageMilliseconds: 0,
    status,
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
  }) as PendingReview & { status: ReviewStatus };

describe('bureau.tasks.respond leaves another attempt’s claim alone', () => {
  it('keeps the claim of an attempt that is resolving when a retry elsewhere refuses, so the original receipt survives', async () => {
    const ledger = newLedger();
    // Attempt A: claimed the identity and is resolving the review.
    const claimedByA = await ledger.claim(identity, digest, { reviewId });
    expect(claimedByA.outcome).toBe('claimed');

    // Attempt B: an exact retry served where the run's reviews are not visible.
    const refused = await faultOf(
      hostOver(ledger, { openWaits: [openWait], getReview: async () => undefined }),
    );

    expect(refused).toMatchObject({ code: 'NotFound' });
    expect(await ledger.read(identity)).toMatchObject({ state: 'pending' });
    // A records its receipt, and a later exact retry C gets it.
    await ledger.complete(claimedByA.entry as never, original);
    const retried = await tasksRespondOperation.invoke({
      input,
      host: hostOver(ledger, { openWaits: [], getReview: async () => undefined }),
      principal,
    } as never);
    expect(retried).toEqual(original);
  });

  it('keeps it when the Bureau answers not-found to the retry’s resolution', async () => {
    const ledger = newLedger();
    await ledger.claim(identity, digest, { reviewId });

    const refused = await faultOf(
      hostOver(ledger, {
        openWaits: [openWait],
        getReview: async () => resolved('pending', undefined),
        resolveReview: async () => {
          throw new BureauError('Run not found', 'NOT_FOUND');
        },
      }),
    );

    expect(refused).toMatchObject({ code: 'NotFound' });
    expect(await ledger.read(identity)).toMatchObject({ state: 'pending' });
  });

  it('still releases a claim the refusing attempt made itself, so its retry may claim afresh', async () => {
    const ledger = newLedger();

    const refused = await faultOf(
      hostOver(ledger, { openWaits: [openWait], getReview: async () => undefined }),
    );

    expect(refused).toMatchObject({ code: 'NotFound' });
    expect(await ledger.read(identity)).toBeUndefined();
  });
});

describe('bureau.tasks.respond and a review someone else resolved', () => {
  it('does not complete a pending claim as applied when another principal resolved the review', async () => {
    const ledger = newLedger();
    await ledger.claim(identity, digest, { reviewId });

    const refused = await faultOf(
      hostOver(ledger, {
        openWaits: [openWait],
        getReview: async () => resolved('approved', apiKeyOwner('operator')),
      }),
    );

    expect(refused).toMatchObject({ code: 'Conflict' });
    expect(await ledger.read(identity)).toMatchObject({ state: 'pending' });
  });

  it('completes it as applied when the same principal resolved the review before it could record its receipt', async () => {
    const ledger = newLedger();
    await ledger.claim(identity, digest, { reviewId });

    const result = await tasksRespondOperation.invoke({
      input,
      host: hostOver(ledger, {
        openWaits: [openWait],
        getReview: async () => resolved('approved', owner),
      }),
      principal,
    } as never);

    expect(result).toMatchObject({ reviewId, decision: 'approve', receipt: 'applied' });
  });
});

describe('bureau.tasks.respond when the approval was gated again', () => {
  it('returns the superseded receipt to an exact retry without resolving the replacement approval', async () => {
    const ledger = newLedger();
    let resolutions = 0;
    const host = hostOver(ledger, {
      openWaits: [openWait],
      getReview: async () => resolved('pending', undefined),
      resolveReview: async () => {
        resolutions += 1;
        return {
          id: reviewId,
          kind: 'human-wait' as const,
          decision: 'approve' as const,
          // The tool's policy gated the call again, so the review stays pending.
          result: { outcome: 'action_required' },
        };
      },
    });

    const first = await tasksRespondOperation.invoke({ input, host, principal } as never);
    const retry = await tasksRespondOperation.invoke({ input, host, principal } as never);

    expect(first).toMatchObject({ receipt: 'superseded' });
    expect(retry).toEqual(first);
    expect(resolutions).toBe(1);
  });
});

describe('bureau.tasks.respond and a fresh claim', () => {
  it('never inherits a decision another command made, even when the same principal made it', async () => {
    const ledger = newLedger();

    const refused = await faultOf(
      hostOver(ledger, {
        openWaits: [openWait],
        getReview: async () => resolved('approved', owner),
      }),
    );

    expect(refused).toMatchObject({ code: 'Conflict' });
    expect(await ledger.read(identity)).toBeUndefined();
  });
});

describe('bureau.tasks.respond after task retention removed the task', () => {
  it('returns the original receipt to an exact retry while the ledger still retains it', async () => {
    const ledger = newLedger();
    const claimed = await ledger.claim(identity, digest, { reviewId });
    await ledger.complete(claimed.entry as never, original);

    const retried = await tasksRespondOperation.invoke({
      input,
      host: hostOver(ledger, {
        openWaits: [],
        getReview: async () => undefined,
        taskGone: true,
      }),
      principal,
    } as never);

    expect(retried).toEqual(original);
  });

  it('still refuses a fresh command as a missing task', async () => {
    const refused = await faultOf(
      hostOver(newLedger(), { openWaits: [], getReview: async () => undefined, taskGone: true }),
    );

    expect(refused).toMatchObject({ code: 'NotFound' });
  });

  it('does not hand the receipt to a command with another payload, or to another caller', async () => {
    const ledger = newLedger();
    const claimed = await ledger.claim(identity, digest, { reviewId });
    await ledger.complete(claimed.entry as never, original);
    const gone = hostOver(ledger, {
      openWaits: [],
      getReview: async () => undefined,
      taskGone: true,
    });

    const otherPayload = await tasksRespondOperation
      .invoke({ input: { ...input, answer: 'something else' }, host: gone, principal } as never)
      .catch((error: unknown) => error);
    const otherCaller = await tasksRespondOperation
      .invoke({
        input,
        host: gone,
        principal: { ...principal, subject: 'mallory' } as unknown as Principal,
      } as never)
      .catch((error: unknown) => error);

    expect(otherPayload).toMatchObject({ code: 'NotFound' });
    expect(otherCaller).toMatchObject({ code: 'NotFound' });
  });
});

describe('bureau.tasks.respond and a retry after the approval was gated again', () => {
  const decisionInput = { taskId: 'run-1', messageId: 'm1', decision: 'approve' as const };
  const decisionIdentity = { ...identity };
  const decisionDigest = digestCommandPayload({ decision: 'approve' });

  const approval = (round: number) =>
    ({
      kind: 'tool-approval',
      id: approvalReviewId,
      runId: 'run-1',
      sessionId: 'context-1',
      agentName: 'default',
      approval: { callId: 'call-1' },
      requestedAt: 1,
      ageMilliseconds: 0,
      status: 'pending',
      round,
    }) as unknown as PendingReview & { status: ReviewStatus };

  it('returns the superseded receipt, and resolves nothing, when the original command was cut short after round 1 was raised', async () => {
    const ledger = newLedger();
    // The original command read round 0 and claimed it. It resolved round 0, which the policy
    // gated again, and the process died before the ledger entry completed.
    await ledger.claim(decisionIdentity, decisionDigest, { reviewId: approvalReviewId, round: 0 });
    let resolutions = 0;
    const host = hostOver(ledger, {
      openWaits: [approvalWait],
      getReview: async () => approval(1),
      resolveReview: async () => {
        resolutions += 1;
        throw new Error('the replacement round must not be resolved by a retry');
      },
    });

    const retry = await tasksRespondOperation.invoke({
      input: decisionInput,
      host,
      principal,
    } as never);

    expect(retry).toMatchObject({
      reviewId: approvalReviewId,
      kind: 'tool-approval',
      decision: 'approve',
      receipt: 'superseded',
    });
    expect(resolutions).toBe(0);
    expect(await ledger.read(decisionIdentity)).toMatchObject({ state: 'completed' });
  });

  it('still resolves the round it claimed when the retry finds it unchanged', async () => {
    const ledger = newLedger();
    await ledger.claim(decisionIdentity, decisionDigest, { reviewId: approvalReviewId, round: 0 });
    let resolutions = 0;
    const host = hostOver(ledger, {
      openWaits: [approvalWait],
      getReview: async () => approval(0),
      resolveReview: async () => {
        resolutions += 1;
        return {
          id: approvalReviewId,
          kind: 'tool-approval' as const,
          decision: 'approve' as const,
          result: { outcome: 'completed' },
        };
      },
    });

    const retry = await tasksRespondOperation.invoke({
      input: decisionInput,
      host,
      principal,
    } as never);

    expect(retry).toMatchObject({ receipt: 'applied' });
    expect(resolutions).toBe(1);
  });

  it('records the round it read with its claim', async () => {
    const ledger = newLedger();
    const host = hostOver(ledger, {
      openWaits: [approvalWait],
      getReview: async () => approval(2),
      resolveReview: async () => ({
        id: approvalReviewId,
        kind: 'tool-approval' as const,
        decision: 'approve' as const,
        result: { outcome: 'completed' },
      }),
    });

    await tasksRespondOperation.invoke({ input: decisionInput, host, principal } as never);

    expect(await ledger.read(decisionIdentity)).toMatchObject({ claim: { round: 2 } });
  });
});

describe('bureau.tasks.respond completes a form submission from its claim', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  };
  const otherReviewId = 'human-wait:run-1:other:1';
  const otherWait = { kind: 'human-wait' as const, reviewId: otherReviewId, signalName: 'other' };
  const submit = { taskId: 'run-1', messageId: 'm1', data: { name: 'x' } };
  const submitDigest = digestCommandPayload({ data: JSON.stringify({ name: 'x' }) });
  const claimWithSubmission = (ledger: ReturnType<typeof newLedger>) =>
    ledger.claim(identity, submitDigest, { reviewId, submission: { value: { name: 'x' } } });
  const applied = {
    id: reviewId,
    kind: 'human-wait' as const,
    decision: 'approve' as const,
    result: { outcome: 'completed' },
  };

  it('delivers the recorded payload when the retry now sees two waits and no signal name', async () => {
    const ledger = newLedger();
    await claimWithSubmission(ledger);
    const delivered: unknown[] = [];

    const result = await tasksRespondOperation.invoke({
      input: submit,
      host: hostOver(ledger, {
        openWaits: [openWait, otherWait],
        getReview: async (id: string) => ({ ...resolved('pending', undefined), id }),
        resolveReview: async (request) => {
          delivered.push(request);
          return applied;
        },
      }),
      principal,
    } as never);

    expect(result).toMatchObject({ reviewId, receipt: 'applied' });
    expect(delivered).toEqual([expect.objectContaining({ id: reviewId, payload: { name: 'x' } })]);
  });

  it('returns the applied receipt when the signal was delivered and the review no longer has its schema', async () => {
    const ledger = newLedger();
    await claimWithSubmission(ledger);

    // The audit record of a resolved review omits the schema, so a retry must not judge the data
    // against what it now finds.
    const result = await tasksRespondOperation.invoke({
      input: submit,
      host: hostOver(ledger, {
        openWaits: [],
        getReview: async () => resolved('approved', owner),
      }),
      principal,
    } as never);

    expect(result).toMatchObject({ reviewId, receipt: 'applied' });
    expect(await ledger.read(identity)).toMatchObject({ state: 'completed' });
  });

  it('delivers the recorded payload even when the review now carries a different schema', async () => {
    const ledger = newLedger();
    await claimWithSubmission(ledger);
    const delivered: unknown[] = [];

    await tasksRespondOperation.invoke({
      input: submit,
      host: hostOver(ledger, {
        openWaits: [openWait],
        getReview: async () =>
          ({
            ...resolved('pending', undefined),
            inputSchema: { type: 'object', properties: { age: { type: 'integer' } } },
          }) as never,
        resolveReview: async (request) => {
          delivered.push(request);
          return applied;
        },
      }),
      principal,
    } as never);

    expect(delivered).toEqual([expect.objectContaining({ payload: { name: 'x' } })]);
  });

  it('records the validated payload in the claim it makes', async () => {
    const ledger = newLedger();
    await tasksRespondOperation.invoke({
      input: { ...submit, data: { name: ' x' } },
      host: hostOver(ledger, {
        openWaits: [openWait],
        getReview: async () =>
          ({ ...resolved('pending', undefined), inputSchema: schema }) as never,
        resolveReview: async () => applied,
      }),
      principal,
    } as never);

    expect(await ledger.read({ ...identity })).toMatchObject({
      claim: { reviewId, submission: { value: { name: ' x' } } },
    });
  });
});
