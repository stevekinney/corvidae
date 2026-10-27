/**
 * COR-1577 — a durable `bureau.run()` run that calls `requestHumanInput` parks, appears in
 * `reviews.list()` as a `human-wait` review addressed by its run id (it has no session),
 * and resumes after `reviews.resolve`. The engine's own state is the source of truth, so resolution
 * does not depend on the audit trail, and a review survives a restart with the id it had.
 */

import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';

import type { AgentDefinitions } from './agent-catalog';
import * as auditTrailModule from './audit-trail';
import { BureauError, createBureau } from './create-bureau';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import { humanWaitDeliveryId } from './run-human-waits';
import type { Bureau, BureauOptions, PendingReview } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];
const databasePaths: string[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const path of databasePaths.splice(0)) {
    removeTemporaryPath(path);
  }
});

async function pollUntil(check: () => boolean | Promise<boolean>, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('Condition was not met.');
}

type Seen = {
  readonly tools: string[][];
  /** The conversation as JSON at each step after the first, to read the delivered answer. */
  readonly resumed: string[];
  /** Holds the step after the park until released, so the run stays running. */
  gate: Promise<void>;
  release(): void;
};

function newSeen(held = false): Seen {
  let release!: () => void;
  const open = Promise.resolve();
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { tools: [], resumed: [], gate: held ? closed : open, release };
}

/** An agent that asks, parks, and thanks the operator once resumed. */
function askingAgent(seen: Seen, signalName = 'answer') {
  const generate: GenerateFunction = async (context: GenerateContext) => {
    seen.tools.push(context.toolbox.tools().map((tool) => tool.name));
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
    await seen.gate;
    seen.resumed.push(JSON.stringify(context.conversation.current));
    return { content: 'thanks', toolCalls: [] };
  };
  return createAgent({
    generate,
    toolbox: createToolbox([]),
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
  });
}

async function start(
  agents: AgentDefinitions,
  options: Partial<BureauOptions<AgentDefinitions>> = {},
): Promise<Bureau<AgentDefinitions>> {
  const bureau = await createBureau<AgentDefinitions>({
    agents: { ...agents },
    storage: { type: 'memory' },
    durable: true,
    ...options,
  });
  bureaus.push(bureau);
  return bureau;
}

async function nextReview(bureau: Bureau<AgentDefinitions>, runId: string): Promise<PendingReview> {
  await pollUntil(() => bureau.reviews.list().some((review) => review.runId === runId));
  const review = bureau.reviews.list().find((candidate) => candidate.runId === runId);
  if (review === undefined) throw new Error('Expected a review.');
  return review;
}

describe('a bureau.run() park', () => {
  it('is listed by run id, resolves through resolveReview, and resumes the run', async () => {
    const seen = newSeen();
    const bureau = await start({ asker: askingAgent(seen) });

    const run = bureau.run('asker', 'deploy', { principal: 'alice' });
    const review = await nextReview(bureau, run.id);

    expect(review).toMatchObject({
      kind: 'human-wait',
      id: `human-wait:${run.id}:answer:0`,
      runId: run.id,
      agentName: 'asker',
      signalName: 'answer',
      prompt: 'Which environment?',
      status: 'pending',
    });
    // It has no session: the run id is what addresses it.
    expect(review.sessionId).toBeUndefined();
    expect(await bureau.reviews.get(review.id)).toMatchObject({ id: review.id, status: 'pending' });

    const resolved = await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'operator',
      payload: { environment: 'staging' },
    });
    const result = await run.result();

    expect(resolved).toMatchObject({ id: review.id, kind: 'human-wait', decision: 'approve' });
    expect(result.finishReason).not.toBe('error');
    expect(seen.resumed.join('')).toContain('staging');
    expect(bureau.reviews.list()).toEqual([]);
  });

  it('delivers the same denial and rejection sentinels a session park does', async () => {
    const bureau = await start({
      denier: askingAgent(newSeen(), 'deny-answer'),
      rejecter: askingAgent(newSeen(), 'reject-answer'),
    });
    const signal = spyOn(bureau.durableEngine()!, 'signal');

    const first = bureau.run('denier', 'deploy');
    const second = bureau.run('rejecter', 'deploy');
    const firstReview = await nextReview(bureau, first.id);
    const secondReview = await nextReview(bureau, second.id);
    await bureau.reviews.resolve({
      id: firstReview.id,
      decision: 'deny',
      principal: 'operator',
      reason: 'not now',
    });
    await bureau.reviews.resolve({
      id: secondReview.id,
      decision: 'reject',
      principal: 'operator',
      reason: 'wrong target',
    });
    await first.result();
    await second.result();

    expect(signal.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([
      [first.id, 'deny-answer', { __abDenied: true, reason: 'not now' }],
      [second.id, 'reject-answer', { __abRejected: true, reason: 'wrong target' }],
    ]);
  });

  it('refuses a rejection without a reason and leaves the review pending', async () => {
    const bureau = await start({ asker: askingAgent(newSeen()) });
    const run = bureau.run('asker', 'deploy');
    const review = await nextReview(bureau, run.id);

    const refusal = await rejectionOf(
      bureau.reviews.resolve({ id: review.id, decision: 'reject', principal: 'operator' }),
    );

    expect((refusal as BureauError).code).toBe('BAD_REQUEST');
    expect(bureau.reviews.list().map((pending) => pending.id)).toEqual([review.id]);
  });

  it('answers a second resolve with NOT_FOUND once the first has landed', async () => {
    const bureau = await start({ asker: askingAgent(newSeen()) });
    const run = bureau.run('asker', 'deploy');
    const review = await nextReview(bureau, run.id);
    await bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' });
    await run.result();

    const again = await rejectionOf(
      bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' }),
    );

    expect((again as BureauError).code).toBe('NOT_FOUND');
  });

  it('is CONFLICT when the run was signalled outside resolveReview and is still going', async () => {
    const seen = newSeen(true);
    const bureau = await start({ asker: askingAgent(seen) });
    const run = bureau.run('asker', 'deploy');
    const review = await nextReview(bureau, run.id);
    await bureau.durableEngine()!.signal(run.id, 'answer', { environment: 'prod' });
    // The run continues into its held step, so it is neither settled nor still parked.
    await yieldToPortableEventLoop();

    const stale = await rejectionOf(
      bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' }),
    );

    seen.release();
    await run.result();
    expect((stale as BureauError).code).toBe('CONFLICT');
  });

  // A parked run that ends before its review is decided has two ways to end, and they answer
  // differently because the review index and the engine learn of the end at different moments.
  // The design's error table and the session path say the same.
  it('answers NOT_FOUND to a resolve after the run was aborted and has settled', async () => {
    const bureau = await start({ asker: askingAgent(newSeen()) });
    const run = bureau.run('asker', 'deploy');
    const review = await nextReview(bureau, run.id);

    run.abort();
    await run.result();
    const refusal = await rejectionOf(
      bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' }),
    );

    // The settled run has left the index, so the review is gone rather than in conflict.
    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    expect(bureau.reviews.list()).toEqual([]);
  });

  it('answers CONFLICT to a resolve after the engine cancelled the run, before the index heard', async () => {
    const bureau = await start({ asker: askingAgent(newSeen()) });
    const run = bureau.run('asker', 'deploy');
    const review = await nextReview(bureau, run.id);

    await bureau.durableEngine()!.cancel(run.id);
    const refusal = await rejectionOf(
      bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' }),
    );
    await run.result().catch(() => undefined);

    // The engine, not the index, says the run has settled, so the review is closed.
    expect((refusal as BureauError).code).toBe('CONFLICT');
  });

  it('lets exactly one of two concurrent resolves through', async () => {
    const seen = newSeen(true);
    const bureau = await start({ asker: askingAgent(seen) });
    const run = bureau.run('asker', 'deploy');
    const review = await nextReview(bureau, run.id);

    const outcomes = await Promise.allSettled([
      bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'one' }),
      bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'two' }),
    ]);

    seen.release();
    await run.result();
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(['CONFLICT', 'NOT_FOUND']).toContain(
      ((failure as PromiseRejectedResult).reason as BureauError).code,
    );
  });

  it('delivers once when a failed delivery is retried', async () => {
    const seen = newSeen();
    const bureau = await start({ asker: askingAgent(seen) });
    const run = bureau.run('asker', 'deploy');
    const review = await nextReview(bureau, run.id);
    const engine = bureau.durableEngine()!;
    const signal = spyOn(engine, 'signal');
    signal.mockRejectedValueOnce(new Error('transport lost'));

    const failed = await rejectionOf(
      bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' }),
    );
    const retried = await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'operator',
    });
    await run.result();

    expect((failed as Error).message).toContain('transport lost');
    expect(retried).toMatchObject({ id: review.id, decision: 'approve' });
    expect(seen.resumed).toHaveLength(1);
    // Both attempts named the review as the delivery's id, which is what makes a retry safe.
    expect(signal.mock.calls.map((call) => call[3])).toEqual([
      { signalId: review.id },
      { signalId: review.id },
    ]);
  });

  it('settles without the audit trail recording anything', async () => {
    const realCreateAuditTrail = auditTrailModule.createAuditTrail;
    const auditSpy = spyOn(auditTrailModule, 'createAuditTrail').mockImplementation(((
      ...args: Parameters<typeof realCreateAuditTrail>
    ) => {
      const real = realCreateAuditTrail(...args);
      return new Proxy(real, {
        get(target, property, receiver) {
          if (property === 'record') return async () => undefined;
          if (property === 'query') return async () => [];
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    }) as typeof realCreateAuditTrail);
    try {
      const seen = newSeen(true);
      const bureau = await start({ asker: askingAgent(seen) });
      const run = bureau.run('asker', 'deploy');
      const review = await nextReview(bureau, run.id);

      await bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' });
      const again = await rejectionOf(
        bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' }),
      );

      seen.release();
      await run.result();
      // With nothing in the audit trail, the engine alone says the park is gone.
      expect(['CONFLICT', 'NOT_FOUND']).toContain((again as BureauError).code);
      expect(seen.resumed).toHaveLength(1);
    } finally {
      auditSpy.mockRestore();
    }
  });

  it('is owned by the principal that dispatched it', async () => {
    const bureau = await start({ asker: askingAgent(newSeen()) });
    const alice = bureau.run('asker', 'deploy', { principal: 'alice' });
    const anonymous = bureau.run('asker', 'deploy');
    const aliceReview = await nextReview(bureau, alice.id);
    const anonymousReview = await nextReview(bureau, anonymous.id);

    expect(await bureau.getOwner({ kind: 'review', id: aliceReview.id })).toBe('alice');
    expect(await bureau.getOwner({ kind: 'review', id: anonymousReview.id })).toBe(
      'anonymous:local',
    );
  });

  it('leaves a catalog run’s pending tool approval unlisted, as COR-1302 left it', async () => {
    const { createTool } = await import('armorer');
    const { z } = await import('zod');
    const refund = createTool({
      name: 'refund',
      description: 'refund',
      input: z.object({}),
      metadata: { mutates: true },
      execute: async () => 'refunded',
    });
    const agent = createAgent({
      generate: async ({ step }) =>
        step === 0
          ? { content: '', toolCalls: [{ id: 'call-1', name: 'refund', arguments: {} }] }
          : { content: 'done', toolCalls: [] },
      toolbox: createToolbox([refund], {
        approvalSecret: 'secret',
        approvalPolicy: { mode: 'on-mutation' },
      }),
      stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
    });
    const bureau = await start({ refunder: agent });

    const run = bureau.run('refunder', 'refund it', { principal: 'alice' });
    await run.result();

    expect(bureau.reviews.list()).toEqual([]);
  });
});

describe('a second park request in one catalog step is refused (COR-1578)', () => {
  it('lists exactly one review, for the honored request, and numbers the next park after it', async () => {
    const generate: GenerateFunction = async (context: GenerateContext) => {
      if (context.step === 0) {
        return {
          content: '',
          toolCalls: [
            { id: 'call-a', name: 'requestHumanInput', arguments: { signalName: 'a' } },
            { id: 'call-b', name: 'requestHumanInput', arguments: { signalName: 'b' } },
          ],
        };
      }
      return { content: 'thanks', toolCalls: [] };
    };
    const asker = createAgent({
      generate,
      toolbox: createToolbox([]),
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });
    const bureau = await start({ asker });

    const run = bureau.run('asker', 'deploy', { principal: 'alice' });
    const review = await nextReview(bureau, run.id);

    // Which of the two parallel calls arrived first is not asserted; only that one parked.
    if (review.kind !== 'human-wait') throw new Error('Expected a human-wait review.');
    expect(['a', 'b']).toContain(review.signalName);
    expect(review.id).toBe(`human-wait:${run.id}:${review.signalName}:0`);
    // Let any second review that would be listed arrive before counting.
    await yieldToPortableEventLoop();
    const reviews = bureau.reviews.list().filter((candidate) => candidate.runId === run.id);
    expect(reviews.map((candidate) => candidate.id)).toEqual([review.id]);

    await bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' });
    const result = await run.result();
    expect(result.finishReason).not.toBe('error');
    expect(bureau.reviews.list().filter((candidate) => candidate.runId === run.id)).toEqual([]);
  });
});

describe('requestHumanInput on a catalog run', () => {
  it('is offered on a durable Bureau with the option, and only then', async () => {
    const offered = newSeen();
    const withoutOption = newSeen();
    const nonDurable = newSeen();
    const withOption = await start({ asker: askingAgent(offered) });
    const noOption = await start({ asker: askingAgent(withoutOption) }, { humanInput: false });
    const memoryOnly = await createBureau<AgentDefinitions>({
      agents: {
        asker: askingAgent(nonDurable),
      },
    });
    bureaus.push(memoryOnly);

    const runs = [
      withOption.run('asker', 'go'),
      noOption.run('asker', 'go'),
      memoryOnly.run('asker', 'go'),
    ];
    await pollUntil(() => offered.tools.length > 0);
    await Promise.all(runs.slice(1).map((run) => run.result()));
    runs[0]!.abort();
    await runs[0]!.result();

    expect(offered.tools[0]).toContain('requestHumanInput');
    expect(withoutOption.tools.flat()).not.toContain('requestHumanInput');
    expect(nonDurable.tools.flat()).not.toContain('requestHumanInput');
  });

  it('is not offered to a child run', async () => {
    const parentSeen = newSeen();
    const childSeen = newSeen();
    const bureau = await start({
      parent: askingAgent(parentSeen),
      child: askingAgent(childSeen),
    });
    const parent = bureau.run('parent', 'go');
    await nextReview(bureau, parent.id);

    const dispatched = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'child',
      input: 'go',
    });
    expect(dispatched.outcome).toBe('started');
    await pollUntil(() => childSeen.tools.length > 0);

    expect(childSeen.tools[0]).not.toContain('requestHumanInput');
    // The child's own park, if any, never became a review: only the parent's is listed.
    expect(bureau.reviews.list().map((review) => review.runId)).toEqual([parent.id]);
  });
});

describe('requestHumanInput on a goal attempt', () => {
  it('is not offered, so the attempt cannot park with no reviewer', async () => {
    const seen = newSeen();
    const bureau = await start(
      { asker: askingAgent(seen) },
      {
        validators: [
          {
            identity: { name: 'accepts-any-answer', version: '1' },
            determinism: 'deterministic',
            validate: async (input) => ({
              kind: 'pass',
              evidence: [{ source: 'test', detail: { content: input.result.content } }],
            }),
          },
        ],
      },
    );

    await bureau.goals.create({
      goalRunId: 'goal-1',
      agentName: 'asker',
      prompt: 'go',
      identity: { name: 'goal', version: '1' },
      validator: { name: 'accepts-any-answer', version: '1' },
      bounds: { maximumAttempts: 1, maximumTotalSteps: 5 },
    });
    await pollUntil(() => seen.tools.length > 0);

    expect(seen.tools[0]).not.toContain('requestHumanInput');
    expect(bureau.reviews.list()).toEqual([]);
  });
});

describe('a bureau.run() park after a restart', () => {
  function nextDatabasePath(): string {
    const path = createTemporaryPath('bureau-run-human-wait', '.sqlite');
    databasePaths.push(path);
    return path;
  }

  async function over(databasePath: string, seen: Seen) {
    return start(
      { asker: askingAgent(seen) },
      {
        storage: { type: 'sqlite', path: databasePath },
        durableOwnership: { ownership: 'none' },
      },
    );
  }

  it('lists the park a recovered run makes next, numbered after the ones before it', async () => {
    const databasePath = nextDatabasePath();
    const twoParks = (seen: Seen) => {
      const generate: GenerateFunction = async (context: GenerateContext) => {
        seen.tools.push(context.toolbox.tools().map((tool) => tool.name));
        const park = (signalName: string) => ({
          content: '',
          toolCalls: [
            { id: `call-${signalName}`, name: 'requestHumanInput', arguments: { signalName } },
          ],
        });
        if (context.step === 0) return park('first');
        if (context.step === 1) return park('second');
        return { content: 'done', toolCalls: [] };
      };
      return createAgent({
        generate,
        toolbox: createToolbox([]),
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      });
    };
    const options = {
      storage: { type: 'sqlite' as const, path: databasePath },
      durableOwnership: { ownership: 'none' as const },
    };
    const crashed = await start({ asker: twoParks(newSeen()) }, options);
    const run = crashed.run('asker', 'go');
    const first = await nextReview(crashed, run.id);

    const restarted = await start({ asker: twoParks(newSeen()) }, options);
    const restored = await nextReview(restarted, run.id);
    expect(restored.id).toBe(first.id);
    await restarted.reviews.resolve({
      id: restored.id,
      decision: 'approve',
      principal: 'operator',
    });
    await pollUntil(() =>
      restarted.reviews.list().some((review) => review.id === `human-wait:${run.id}:second:1`),
    );
    const second = restarted.reviews.list().find((review) => review.runId === run.id);

    expect(second).toMatchObject({ kind: 'human-wait', signalName: 'second' });
    await restarted.reviews.resolve({ id: second!.id, decision: 'approve', principal: 'operator' });
    const finished = await restarted.tasks.wait(run.id);
    expect(finished?.status).toBe('completed');
  });

  it('is listed under the id it had, resolves, and the recovered run continues', async () => {
    const databasePath = nextDatabasePath();
    const before = newSeen();
    const crashed = await over(databasePath, before);
    const run = crashed.run('asker', 'deploy', { principal: 'alice' });
    const original = await nextReview(crashed, run.id);
    // The first Bureau is not disposed: a graceful shutdown would cancel the parked run and
    // leave nothing for the restart to recover.

    const after = newSeen();
    const restarted = await over(databasePath, after);
    const restored = await nextReview(restarted, run.id);

    expect(restored.id).toBe(original.id);
    expect(restored).toMatchObject({
      kind: 'human-wait',
      signalName: 'answer',
      prompt: 'Which environment?',
    });
    expect(restored.sessionId).toBeUndefined();
    expect(await restarted.getOwner({ kind: 'review', id: restored.id })).toBe('alice');

    await restarted.reviews.resolve({
      id: restored.id,
      decision: 'approve',
      principal: 'operator',
      payload: { environment: 'production' },
    });
    const finished = await restarted.tasks.wait(run.id);

    expect(finished?.status).toBe('completed');
    expect(after.resumed.join('')).toContain('production');
    expect(restarted.reviews.list()).toEqual([]);
  });
});

describe('a long signalName on a bureau.run() park (COR-1577)', () => {
  const MAXIMUM_DELIVERY_ID_BYTES = 128;
  const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;
  const signalIdOf = (call: readonly unknown[] | undefined): string => {
    if (call === undefined) throw new Error('Expected a delivery.');
    return (call[3] as { signalId: string }).signalId;
  };
  // A catalog run id is about 62 bytes, so each name pushes the review id past 128 bytes.
  const names = {
    ascii: 'x'.repeat(70),
    multibyte: 'é'.repeat(40),
  } as const;

  for (const [label, signalName] of Object.entries(names)) {
    it(`parks, lists, resolves, and resumes under a ${label} name, keeping the review id whole`, async () => {
      const seen = newSeen();
      const bureau = await start({ asker: askingAgent(seen, signalName) });
      const signal = spyOn(bureau.durableEngine()!, 'signal');

      const run = bureau.run('asker', 'deploy');
      const review = await nextReview(bureau, run.id);
      expect(review.id).toBe(`human-wait:${run.id}:${signalName}:0`);
      expect(bytesOf(review.id)).toBeGreaterThan(MAXIMUM_DELIVERY_ID_BYTES);

      const resolved = await bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: 'operator',
        payload: { environment: 'staging' },
      });
      const result = await run.result();

      expect(resolved).toMatchObject({ id: review.id, kind: 'human-wait', decision: 'approve' });
      expect(result.finishReason).not.toBe('error');
      expect(seen.resumed.join('')).toContain('staging');
      const delivered = signalIdOf(signal.mock.calls[0]);
      expect(bytesOf(delivered)).toBeLessThanOrEqual(MAXIMUM_DELIVERY_ID_BYTES);
      expect(delivered).toBe(humanWaitDeliveryId(review.id));
      expect(bureau.reviews.list()).toEqual([]);
    });

    it(`denies a ${label}-named park too`, async () => {
      const bureau = await start({ asker: askingAgent(newSeen(), signalName) });
      const run = bureau.run('asker', 'deploy');
      const review = await nextReview(bureau, run.id);

      await bureau.reviews.resolve({
        id: review.id,
        decision: 'deny',
        principal: 'operator',
        reason: 'not now',
      });
      const result = await run.result();

      expect(result.finishReason).not.toBe('error');
      expect(bureau.reviews.list()).toEqual([]);
    });
  }

  it('delivers once under the same derived id when a failed delivery is retried', async () => {
    const seen = newSeen();
    const bureau = await start({ asker: askingAgent(seen, names.ascii) });
    const run = bureau.run('asker', 'deploy');
    const review = await nextReview(bureau, run.id);
    const signal = spyOn(bureau.durableEngine()!, 'signal');
    signal.mockRejectedValueOnce(new Error('transport lost'));

    const failed = await rejectionOf(
      bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' }),
    );
    await bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' });
    await run.result();

    expect((failed as Error).message).toContain('transport lost');
    expect(seen.resumed).toHaveLength(1);
    const ids = signal.mock.calls.map((call) => signalIdOf(call));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(ids.every((id) => bytesOf(id) <= MAXIMUM_DELIVERY_ID_BYTES)).toBe(true);
  });

  it('deduplicates an exact redelivery under the derived id while the run is parked again on the same signal', async () => {
    const seen = newSeen();
    const generate: GenerateFunction = async (context: GenerateContext) => {
      if (context.step > 0) seen.resumed.push(JSON.stringify(context.conversation.current));
      if (context.step < 2) {
        return {
          content: '',
          toolCalls: [
            {
              id: `call-${context.step}`,
              name: 'requestHumanInput',
              arguments: { signalName: names.ascii },
            },
          ],
        };
      }
      return { content: 'thanks', toolCalls: [] };
    };
    const twice = createAgent({
      generate,
      toolbox: createToolbox([]),
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });
    const bureau = await start({ asker: twice });
    const run = bureau.run('asker', 'deploy');
    const first = await nextReview(bureau, run.id);
    await bureau.reviews.resolve({
      id: first.id,
      decision: 'approve',
      principal: 'operator',
      payload: { environment: 'first' },
    });
    await pollUntil(() => bureau.reviews.list().some((review) => review.id.endsWith(':1')));

    // The same delivery again, now that the run is parked on the same signal a second time.
    await bureau
      .durableEngine()!
      .signal(
        run.id,
        names.ascii,
        { environment: 'duplicate' },
        { signalId: humanWaitDeliveryId(first.id) },
      );
    for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();

    expect(bureau.reviews.list().map((review) => review.id)).toEqual([
      `human-wait:${run.id}:${names.ascii}:1`,
    ]);
    expect(seen.resumed.join('')).not.toContain('duplicate');
    const second = bureau.reviews.list()[0]!;
    await bureau.reviews.resolve({ id: second.id, decision: 'approve', principal: 'operator' });
    await run.result();
    expect(seen.resumed.join('')).not.toContain('duplicate');
  });

  it('derives the same delivery id after a restart, and resumes the recovered run', async () => {
    const databasePath = createTemporaryPath('bureau-run-human-wait-long', '.sqlite');
    databasePaths.push(databasePath);
    const options = {
      storage: { type: 'sqlite' as const, path: databasePath },
      durableOwnership: { ownership: 'none' as const },
    };
    const crashed = await start({ asker: askingAgent(newSeen(), names.ascii) }, options);
    const run = crashed.run('asker', 'deploy');
    const original = await nextReview(crashed, run.id);
    const before = spyOn(crashed.durableEngine()!, 'signal');
    before.mockRejectedValueOnce(new Error('transport lost'));
    // COR-1579: the failed attempt keeps its durable claim, so the retry after the restart makes
    // the same decision, payload included, to re-drive it; a different one would be refused.
    await rejectionOf(
      crashed.reviews.resolve({
        id: original.id,
        decision: 'approve',
        principal: 'operator',
        payload: { environment: 'production' },
      }),
    );

    const after = newSeen();
    const restarted = await start({ asker: askingAgent(after, names.ascii) }, options);
    const restored = await nextReview(restarted, run.id);
    const again = spyOn(restarted.durableEngine()!, 'signal');
    await restarted.reviews.resolve({
      id: restored.id,
      decision: 'approve',
      principal: 'operator',
      payload: { environment: 'production' },
    });
    const finished = await restarted.tasks.wait(run.id);

    expect(restored.id).toBe(original.id);
    const sentBefore = signalIdOf(before.mock.calls[0]);
    const sentAfter = signalIdOf(again.mock.calls[0]);
    expect(sentAfter).toBe(sentBefore);
    expect(bytesOf(sentAfter)).toBeLessThanOrEqual(MAXIMUM_DELIVERY_ID_BYTES);
    expect(finished?.status).toBe('completed');
    expect(after.resumed.join('')).toContain('production');
  });
});

describe('humanWaitDeliveryId', () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;

  it('is the review id itself when it fits in 128 bytes', () => {
    const exactly128 = `human-wait:${'r'.repeat(100)}:a:0`.padEnd(128, '0');
    expect(bytesOf(exactly128)).toBe(128);
    expect(humanWaitDeliveryId(exactly128)).toBe(exactly128);
    expect(humanWaitDeliveryId('human-wait:run-1:answer:0')).toBe('human-wait:run-1:answer:0');
  });

  it('is a fixed-length, deterministic, prefixed hash otherwise, distinct per review id', () => {
    const long = `human-wait:run-1:${'x'.repeat(200)}:0`;
    const other = `human-wait:run-1:${'x'.repeat(200)}:1`;

    expect(humanWaitDeliveryId(long)).toBe(humanWaitDeliveryId(long));
    expect(humanWaitDeliveryId(long)).toStartWith('human-wait:sha256:');
    expect(bytesOf(humanWaitDeliveryId(long))).toBeLessThanOrEqual(128);
    expect(humanWaitDeliveryId(long)).not.toBe(humanWaitDeliveryId(other));
    // Measured in bytes, not characters: 70 two-byte characters are 140 bytes.
    const multibyte = 'é'.repeat(70);
    expect(multibyte.length).toBeLessThan(128);
    expect(humanWaitDeliveryId(multibyte)).toStartWith('human-wait:sha256:');
  });
});
