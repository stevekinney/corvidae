/**
 * COR-1613 — a schedule fire's reviews behave the same on every Bureau sharing the stores: a peer
 * answers its human wait, and a peer closing its last review ends the task stream another
 * instance serves.
 *
 * Two Bureaus open one SQLite database under `workflow-lease` ownership, so each holds the fires
 * it started and the other sees them only through durable state.
 */
import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  OWNER,
  readFrames,
  rpc,
  subscribeRequest,
} from './http/management/management-fixtures.test-support.ts';
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
  reviewsOf,
} from './schedule-fire-fixtures.test-support';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});

/** A renewal interval short enough that the holder hears a peer's signal promptly. */
const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const stopAtApproval = stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls());

describe('a peer answers a fire’s human wait', () => {
  for (const [name, sessionId] of [
    ['recurring', 'peer-wait-session'],
    ['stateless', undefined],
  ] as const) {
    it(`for a ${name} fire, and the fire completes`, async () => {
      const path = harness.nextDatabasePath();
      const seen: string[] = [];
      const options = {
        generate: askingGenerate('answer', seen),
        humanInput: true,
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        durableOwnership: OWNERSHIP,
        // A holder hears a peer's signal through its own background claim renewal.
        durableBackgroundTasks: 'automatic' as const,
      };
      const holder = await harness.open({
        ...options,
        storage: await harness.sqliteStorage(path),
      });
      const { fireId } = await fireOnce(holder, OWNER.alice, sessionId);
      const review = await reviewOf(holder, fireId);
      await sleep(150);
      const peer = await harness.open({ ...options, storage: await harness.sqliteStorage(path) });
      // The peer does not hold the fire, so it does not list the wait, but it can answer it.
      expect(reviewsOf(peer, fireId)).toEqual([]);

      const resolved = await peer.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: OWNER.alice,
        payload: 'staging',
      });

      expect(resolved).toMatchObject({ id: review.id, kind: 'human-wait', decision: 'approve' });
      await pollUntil(
        async () => {
          await sleep(10);
          return (await durableStatus(holder, fireId)) === 'completed' ? true : undefined;
        },
        'the fire to complete',
        500,
      );
      expect(seen.join('')).toContain('staging');
    });
  }
});

void chargesOnce;
void approvalToolbox;
void handlerOf;
void rpc;
void readFrames;
void subscribeRequest;
void (undefined as unknown as GenerateFunction);
void stopAtApproval;
