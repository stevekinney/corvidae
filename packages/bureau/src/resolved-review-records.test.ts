/**
 * COR-1828 — a review a person decided is kept: who decided it, what, and when, readable by id and
 * listed as resolved, with an approved answer only as a digest and the references of its secret
 * fields, and retired by `retention.audit`.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { createToolbox, type Tool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createMemoryAssetStorage } from './assets/storage';
import { createBureau } from './create-bureau';
import { digestReviewDelivery } from './review-decision-record';
import { RESOLVED_REVIEW_KEY_PREFIX } from './resolved-review-record';
import { waitForCondition } from './test';
import type { BureauOptions } from './types';

const ORIGIN = '2026-10-13T00:00:00.000Z';
const ORIGIN_MS = Date.parse(ORIGIN);
const DAY_MS = 86_400_000;
const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

/** A Bureau whose agent parks on a human question; its clock is the test's. */
async function parkedBureau(overrides: Partial<BureauOptions> = {}) {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const storage = new MemoryStorage();
  const generate: GenerateFunction = async (context) => {
    return context.step === 0
      ? {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'answer', prompt: 'Which environment?' },
            },
          ],
        }
      : { content: 'thanks', toolCalls: [] };
  };
  const bureau = await createBureau<AgentDefinitions>({
    id: 'resolved-reviews-bureau',
    assets: { storage: createMemoryAssetStorage() },
    agents: {
      asker: createAgent({
        generate,
        toolbox: createToolbox<readonly Tool[]>([]),
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      }),
    },
    runtime,
    storage,
    durable: true,
    maintenance: 'manual',
    ...overrides,
  });
  disposers.push(() => bureau.dispose());
  const run = await bureau.tasks.start('asker', 'deploy', { principal: ALICE });
  await waitForCondition(
    () => bureau.reviews.list().some((review) => review.runId === run.id),
    'expected requestHumanInput to park and surface a review',
  );
  const review = bureau.reviews.list().find((candidate) => candidate.runId === run.id);
  if (review === undefined) throw new Error('Expected a review.');
  return {
    bureau,
    runtime,
    storage,
    review,
    run,
    at: (offsetMilliseconds: number) => runtime.setTime(ORIGIN_MS + offsetMilliseconds),
  };
}

async function recordsIn(storage: MemoryStorage): Promise<string[]> {
  const found: string[] = [];
  const decoder = new TextDecoder();
  for await (const [key, value] of storage.scan(RESOLVED_REVIEW_KEY_PREFIX)) {
    found.push(`${key}=${decoder.decode(value)}`);
  }
  return found;
}

describe('the record of a decided human wait (COR-1828)', () => {
  it('is listed as resolved with its decision, actor, time, owner and answer digest, and read by id', async () => {
    const { bureau, review, at, storage } = await parkedBureau();
    at(5_000);

    await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: BOB,
      payload: { environment: 'production' },
    });

    const resolved = await bureau.reviews.listResolved();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      decision: 'approve',
      decidedBy: BOB,
      decidedAt: ORIGIN_MS + 5_000,
      owner: ALICE,
      answerDigest: digestReviewDelivery({ environment: 'production' }),
      review: { id: review.id, kind: 'human-wait', status: 'approved', signalName: 'answer' },
    });
    expect(bureau.reviews.list()).toHaveLength(0);
    // Read by id, the review says who decided it and when, and what became of the answer.
    expect(await bureau.reviews.get(review.id)).toMatchObject({
      id: review.id,
      status: 'approved',
      resolvedBy: BOB,
      resolvedAt: ORIGIN_MS + 5_000,
      answerDigest: digestReviewDelivery({ environment: 'production' }),
    });
    // The answer itself is nowhere in the record.
    const records = await recordsIn(storage);
    const stored = records.join('\n');
    expect(stored).not.toContain('production');
    expect(stored).toContain(review.id);
  });

  it('keeps a denial, and a rejection with its reason, and no digest of an answer it never took', async () => {
    const { bureau, review, run } = await parkedBureau();

    await bureau.reviews.resolve({
      id: review.id,
      decision: 'reject',
      principal: BOB,
      reason: 'Not this one.',
    });

    const [record] = await bureau.reviews.listResolved();
    expect(record).toMatchObject({
      decision: 'reject',
      reason: 'Not this one.',
      decidedBy: BOB,
      review: { runId: run.id, status: 'rejected' },
    });
    expect(record?.answerDigest).toBeUndefined();
    expect(await bureau.reviews.get(review.id)).toMatchObject({
      status: 'rejected',
      resolutionReason: 'Not this one.',
    });
  });

  it('lists the latest decision first and keeps only the decisions at or after resolvedAfter', async () => {
    const { bureau, review, at } = await parkedBureau();
    at(1_000);
    await bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: BOB });
    const second = await bureau.tasks.start('asker', 'again', { principal: ALICE });
    await waitForCondition(
      () => bureau.reviews.list().some((candidate) => candidate.runId === second.id),
      'expected the second run to park',
    );
    // The second run's model answers without parking again; resolve whatever it holds.
    const [secondReview] = bureau.reviews
      .list()
      .filter((candidate) => candidate.runId === second.id);
    if (secondReview === undefined) throw new Error('Expected a second review.');
    at(9_000);
    await bureau.reviews.resolve({ id: secondReview.id, decision: 'deny', principal: BOB });

    const all = await bureau.reviews.listResolved();
    expect(all.map((record) => record.decidedAt)).toEqual([ORIGIN_MS + 9_000, ORIGIN_MS + 1_000]);
    const recent = await bureau.reviews.listResolved({ resolvedAfter: ORIGIN_MS + 5_000 });
    expect(recent.map((record) => record.review.id)).toEqual([secondReview.id]);
  });

  it('is retired by retention.audit, and kept without it', async () => {
    const kept = await parkedBureau();
    await kept.bureau.reviews.resolve({ id: kept.review.id, decision: 'deny', principal: BOB });
    kept.at(400 * DAY_MS);
    await kept.bureau.maintain();
    expect(await kept.bureau.reviews.listResolved()).toHaveLength(1);

    const retired = await parkedBureau({ retention: { audit: { olderThan: DAY_MS } } });
    await retired.bureau.reviews.resolve({
      id: retired.review.id,
      decision: 'deny',
      principal: BOB,
    });
    // As old as the window is not older than it.
    retired.at(DAY_MS);
    await retired.bureau.maintain();
    expect(await retired.bureau.reviews.listResolved()).toHaveLength(1);
    retired.at(DAY_MS + 1);
    await retired.bureau.maintain();
    expect(await retired.bureau.reviews.listResolved()).toHaveLength(0);
    expect(await recordsIn(retired.storage)).toEqual([]);
  });

  it('keeps nothing in a Bureau with no storage, and still answers an empty list', async () => {
    const generate: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        asker: createAgent({
          generate,
          toolbox: createToolbox<readonly Tool[]>([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    disposers.push(() => bureau.dispose());

    expect(await bureau.reviews.listResolved()).toEqual([]);
  });
});
