/**
 * `bureau.tasks.respond` over a ledger shared by several attempts: a refusing attempt
 * leaves another attempt's claim alone, and a review someone else resolved is not this
 * caller's receipt. Each test drives the operation over a real command ledger and a host
 * that stands for a process which cannot see the run.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { Principal } from '@lostgradient/weft';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { BureauError } from '../../create-bureau.ts';
import {
  type CommandLedgerIdentity,
  createCommandLedger,
  digestCommandPayload,
} from '../../command-ledger.ts';
import { apiKeyOwner } from '../../owner-of-record.ts';
import type { PendingReview, ReviewStatus } from '../../types.ts';
import { mayAccessOwnedResource } from '../owner-predicate.ts';
import {
  type BureauTasksRespondOperationHost,
  TASKS_RESPOND_LEDGER_KEY_PREFIX,
  TASKS_RESPOND_OPERATION_VERSION,
  type TasksRespondResult,
  tasksRespondOperation,
} from './tasks-respond-operation.ts';

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
  return createCommandLedger<{ reviewId: string }, TasksRespondResult>({
    kv: textValueStore(new MemoryStorage()),
    keyPrefix: TASKS_RESPOND_LEDGER_KEY_PREFIX,
    clock: runtime.clock,
    nextConflictId: () => runtime.identifiers.next('respond-conflict'),
  });
}

const openWait = { kind: 'human-wait' as const, reviewId, signalName: 'human-response' };

function hostOver(
  ledger: ReturnType<typeof newLedger>,
  options: {
    openWaits: readonly (typeof openWait)[];
    getReview: BureauTasksRespondOperationHost['reviews']['getReview'];
    resolveReview?: BureauTasksRespondOperationHost['reviews']['resolveReview'];
  },
): BureauTasksRespondOperationHost {
  const task = {
    id: 'run-1',
    contextId: 'context-1',
    agentName: 'bureau',
    owner,
    status: 'input-required' as const,
    finishReason: null,
    statusMessage: null,
    createdAt: 'then',
    updatedAt: 'then',
    cleanup: null,
    openWaits: options.openWaits,
  };
  return {
    ownership: { runOwner: async () => owner, mayAccess: mayAccessOwnedResource },
    tasks: { get: async () => task, ownerOf: async () => owner },
    reviews: {
      getReview: options.getReview,
      resolveReview:
        options.resolveReview ??
        (async () => {
          throw new Error('resolveReview must not be reached');
        }),
    },
    respondLedger: ledger,
    respondInFlight: new Map(),
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
