/**
 * COR-1613 — an approval restored after a restart is decided under the active-skill policy that
 * governed the call when it was requested, for a schedule fire and a session run alike.
 *
 * A skill's `allowed-tools` narrows what a run may call. The session persists the active skills,
 * but the restore of a pending approval built its toolbox without them, so a call the skill would
 * refuse ran after the restart.
 */
import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';

import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  createScheduleFireHarness,
  fireOnce,
  pollUntil,
  reviewOf,
} from './schedule-fire-fixtures.test-support';
import {
  chargeApprovalToolbox as approvalToolbox,
  letStepsCommit,
  lockedAfterCharging,
  pollForTime,
  removeSkillRoots,
  skillCatalogOnDisk,
  skillsRecorded,
} from './skill-policy-fixtures.test-support';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});
afterAll(removeSkillRoots);

async function lockingCatalog() {
  const catalog = await skillCatalogOnDisk();
  return catalog.discover();
}

describe('a restored approval keeps the skill policy it was requested under', () => {
  it('refuses a call the active skill would refuse, for a schedule fire', async () => {
    const catalog = await lockingCatalog();
    const path = harness.nextDatabasePath();
    const options = {
      generate: lockedAfterCharging('wait'),
      stopWhen: stopWhen.noToolCalls(),
      skills: { catalog },
    };
    const first = await harness.open({
      ...options,
      toolbox: approvalToolbox([]),
      storage: { type: 'sqlite', path },
    });
    const { fireId } = await fireOnce(first, OWNER.alice, 'skill-fire-session');
    const review = await reviewOf(first, fireId);
    // The skill is active and committed by the time the second step is done.
    await pollForTime(
      async () => ((await skillsRecorded(first, 'skill-fire-session')) ? true : undefined),
      'the active skill to be recorded',
    );
    await letStepsCommit();

    const charges: number[] = [];
    const restarted = await harness.open({
      ...options,
      toolbox: approvalToolbox(charges),
      storage: { type: 'sqlite', path },
    });
    const restored = await reviewOf(restarted, fireId);
    expect(restored.id).toBe(review.id);
    await restarted
      .resolveReview({ id: restored.id, decision: 'approve', principal: OWNER.alice })
      .catch(() => undefined);

    expect(charges).toEqual([]);
  });

  it('refuses a call the active skill would refuse, for a session run', async () => {
    const catalog = await lockingCatalog();
    const path = harness.nextDatabasePath();
    const options = {
      generate: lockedAfterCharging('stop'),
      stopWhen: stopWhen.noToolCalls(),
      skills: { catalog },
    };
    const first = await harness.open({
      ...options,
      toolbox: approvalToolbox([]),
      storage: { type: 'sqlite', path },
    });
    const run = await first.createRun({
      agentName: 'bureau',
      message: 'charge, then lock',
      principal: OWNER.alice,
    });
    const review = await pollUntil(
      () => first.listPendingReviews().find((candidate) => candidate.runId === run.id),
      'the session run’s approval',
    );
    await pollForTime(
      async () => ((await skillsRecorded(first, run.sessionId)) ? true : undefined),
      'the active skill to be recorded',
    );
    await letStepsCommit();

    const charges: number[] = [];
    const restarted = await harness.open({
      ...options,
      toolbox: approvalToolbox(charges),
      storage: { type: 'sqlite', path },
    });
    const restored = await pollUntil(
      () => restarted.listPendingReviews().find((candidate) => candidate.id === review.id),
      'the restored approval',
    );
    await restarted
      .resolveReview({ id: restored.id, decision: 'approve', principal: OWNER.alice })
      .catch(() => undefined);

    expect(charges).toEqual([]);
  });
});

describe('the control: without the skill, the same restored approval runs', () => {
  it('runs the tool when no skill was active', async () => {
    const path = harness.nextDatabasePath();
    const generate: GenerateFunction = async (context) =>
      context.step === 0
        ? {
            content: '',
            toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
          }
        : { content: 'done', toolCalls: [] };
    const options = { generate, stopWhen: stopWhen.noToolCalls() };
    const first = await harness.open({
      ...options,
      toolbox: approvalToolbox([]),
      storage: { type: 'sqlite', path },
    });
    const run = await first.createRun({
      agentName: 'bureau',
      message: 'charge',
      principal: OWNER.alice,
    });
    const review = await pollUntil(
      () => first.listPendingReviews().find((candidate) => candidate.runId === run.id),
      'the session run’s approval',
    );
    const charges: number[] = [];
    const restarted = await harness.open({
      ...options,
      toolbox: approvalToolbox(charges),
      storage: { type: 'sqlite', path },
    });
    await pollUntil(
      () => restarted.listPendingReviews().find((candidate) => candidate.id === review.id),
      'the restored approval',
    );

    await restarted.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });

    expect(charges).toEqual([4242]);
  });
});
