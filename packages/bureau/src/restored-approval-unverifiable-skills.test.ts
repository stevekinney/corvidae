/**
 * COR-1620 — an approval restored after a restart is never executed when the skill policy that
 * governed it cannot be verified. Unverifiable means a failed read or deserialization of the
 * snapshot, or a snapshot that names another fire; a refused recovery of a stored skill, and a run
 * with no toolbox of its own, are unverifiable too. A snapshot that verifiably names no skill is
 * not, and such an approval runs as before.
 */
import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { KEYS, type Storage } from '@lostgradient/weft';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';

import type { BureauError } from './create-bureau';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  createScheduleFireHarness,
  fireOnce,
  pollUntil,
  reviewOf,
} from './schedule-fire-fixtures.test-support';
import { scheduledFireReviewStateOf } from './scheduled-fire-review-state';
import {
  chargeApprovalToolbox,
  letStepsCommit,
  lockedAfterCharging,
  pollForTime,
  removeSkillRoots,
  type SkillCatalogOnDisk,
  skillCatalogOnDisk,
  skillsRecorded,
} from './skill-policy-fixtures.test-support';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau } from './types';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});
afterAll(removeSkillRoots);

const SESSION = 'unverifiable-skills-session';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** A storage whose reads of one run's engine checkpoint reject while `failing.on` is set. */
function failingCheckpointReads(fireId: string, failing: { on: boolean }) {
  return (storage: Storage): Storage =>
    new Proxy(storage, {
      get(target, property) {
        const member = Reflect.get(target, property, target) as unknown;
        if (typeof member !== 'function') return member;
        if (property !== 'get') return (member as (...a: unknown[]) => unknown).bind(target);
        return (...args: unknown[]) => {
          if (failing.on && args[0] === KEYS.checkpoint(fireId)) {
            return Promise.reject(new Error('the checkpoint store is unavailable'));
          }
          return (member as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
}

/**
 * Rewrites the skill snapshot a session holds on disk, in its body and in the summary index the
 * boot restore reads, as a process that wrote the snapshot differently would have left it.
 */
async function rewriteSkillSnapshotOnDisk(
  path: string,
  change: (metadata: Record<string, unknown>) => void,
): Promise<void> {
  const storage = await harness.sqliteStorage(path);
  const keys: string[] = [];
  for await (const [key] of storage.scan('agent-session')) keys.push(key);
  let rewritten = 0;
  const rewrite = (metadata: Record<string, unknown> | undefined): boolean => {
    if (metadata === undefined || !('activeSkillRecords' in metadata)) return false;
    change(metadata);
    rewritten += 1;
    return true;
  };
  for (const key of keys) {
    const value = await storage.get(key);
    if (value === null) continue;
    const record = JSON.parse(decoder.decode(value)) as {
      metadata?: Record<string, unknown>;
      summaries?: Record<string, { metadata?: Record<string, unknown> }>;
    };
    let changed = rewrite(record.metadata);
    for (const summary of Object.values(record.summaries ?? {})) {
      changed = rewrite(summary.metadata) || changed;
    }
    if (changed) await storage.put(key, encoder.encode(JSON.stringify(record)));
  }
  if (rewritten === 0) throw new Error('No session held a skill snapshot to rewrite.');
}

const approve = (bureau: Bureau, id: string) =>
  bureau.resolveReview({ id, decision: 'approve', principal: OWNER.alice });

async function refusalOf(bureau: Bureau, id: string): Promise<BureauError> {
  return (await rejectionOf(approve(bureau, id))) as BureauError;
}

/** A fire that parks on its approval after the locking skill is active and committed. */
async function parkedFireWithSkill(catalog: SkillCatalogOnDisk) {
  const path = harness.nextDatabasePath();
  const first = await harness.open({
    generate: lockedAfterCharging('wait'),
    stopWhen: stopWhen.noToolCalls(),
    skills: { catalog: await catalog.discover() },
    toolbox: chargeApprovalToolbox([]),
    storage: { type: 'sqlite', path },
  });
  const { fireId, scheduleId } = await fireOnce(first, OWNER.alice, SESSION);
  const review = await reviewOf(first, fireId);
  await pollForTime(
    async () => ((await skillsRecorded(first, SESSION)) ? true : undefined),
    'the active skill to be recorded',
  );
  await letStepsCommit();
  return { path, first, fireId, scheduleId, review };
}

/** The process after the restart, with the options a fire with the locking skill ran under. */
async function restartFire(
  catalog: SkillCatalogOnDisk,
  path: string,
  charges: number[],
  wrap?: (storage: Storage) => Storage,
) {
  return harness.open({
    generate: lockedAfterCharging('wait'),
    stopWhen: stopWhen.noToolCalls(),
    skills: { catalog: await catalog.discover() },
    toolbox: chargeApprovalToolbox(charges),
    storage:
      wrap === undefined ? { type: 'sqlite', path } : await harness.sqliteStorage(path, wrap),
  });
}

describe('a restored fire approval whose snapshot cannot be read', () => {
  it('is refused with CONFLICT and runs nothing, and a deny still goes through', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path, fireId, review } = await parkedFireWithSkill(catalog);
    const failing = { on: true };
    const charges: number[] = [];
    const restarted = await restartFire(
      catalog,
      path,
      charges,
      failingCheckpointReads(fireId, failing),
    );
    const restored = await reviewOf(restarted, fireId);
    expect(restored.id).toBe(review.id);

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('could not be verified');
    expect(charges).toEqual([]);
    const denied = await restarted.resolveReview({
      id: restored.id,
      decision: 'deny',
      principal: OWNER.alice,
    });
    expect(denied.decision).toBe('deny');
  });

  for (const [label, allowedTools, outcome] of [
    ['proceeds under a policy that allows the call', 'charge-card, deactivate_skill', 'runs'],
    ['is refused by a policy that forbids the call', 'deactivate_skill', 'refused'],
  ] as const) {
    it(`is read again on the next approve, which ${label}`, async () => {
      const catalog = await skillCatalogOnDisk(allowedTools);
      const { path, fireId } = await parkedFireWithSkill(catalog);
      const failing = { on: true };
      const charges: number[] = [];
      const restarted = await restartFire(
        catalog,
        path,
        charges,
        failingCheckpointReads(fireId, failing),
      );
      const restored = await reviewOf(restarted, fireId);
      const first = await refusalOf(restarted, restored.id);
      expect(first.message).toContain('could not be verified');

      failing.on = false;

      if (outcome === 'runs') {
        await approve(restarted, restored.id);
        expect(charges).toEqual([4242]);
      } else {
        const second = await refusalOf(restarted, restored.id);
        expect(second.code).toBe('CONFLICT');
        expect(second.message).toContain('not permitted by the run');
        expect(charges).toEqual([]);
      }
    });
  }
});

describe('a restored fire approval whose snapshot names another fire', () => {
  it('is refused with CONFLICT when a newer fire of the schedule has taken the session', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path, fireId } = await parkedFireWithSkill(catalog);
    // The session names the schedule's newer fire, as it does once that fire has run in it.
    await rewriteSkillSnapshotOnDisk(path, (metadata) => {
      metadata['lastScheduledFireRunId'] = 'a-newer-fire';
    });
    const charges: number[] = [];
    const restarted = await restartFire(catalog, path, charges);
    const restored = await reviewOf(restarted, fireId);

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('could not be verified');
    expect(charges).toEqual([]);
  });
});

describe('a restored session-run approval whose snapshot cannot be read', () => {
  async function parkedRunWithSkill(catalog: SkillCatalogOnDisk) {
    const path = harness.nextDatabasePath();
    const options = async () => ({
      generate: lockedAfterCharging('stop'),
      stopWhen: stopWhen.noToolCalls(),
      skills: { catalog: await catalog.discover() },
    });
    const first = await harness.open({
      ...(await options()),
      toolbox: chargeApprovalToolbox([]),
      storage: { type: 'sqlite', path },
    });
    const run = await first.createRun({ message: 'charge, then lock', principal: OWNER.alice });
    const review = await pollUntil(
      () => first.listPendingReviews().find((candidate) => candidate.runId === run.id),
      'the session run’s approval',
    );
    await pollForTime(
      async () => ((await skillsRecorded(first, run.sessionId)) ? true : undefined),
      'the active skill to be recorded',
    );
    await letStepsCommit();
    return { path, run, review, options };
  }

  it('is refused with CONFLICT when the stored records do not deserialize', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path, review, options } = await parkedRunWithSkill(catalog);
    const charges: number[] = [];
    await rewriteSkillSnapshotOnDisk(path, (metadata) => {
      metadata['activeSkillRecords'] = 'not records';
    });
    const restarted = await harness.open({
      ...(await options()),
      toolbox: chargeApprovalToolbox(charges),
      storage: { type: 'sqlite', path },
    });
    const restored = await pollUntil(
      () => restarted.listPendingReviews().find((candidate) => candidate.id === review.id),
      'the restored approval',
    );

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('could not be verified');
    expect(charges).toEqual([]);
    const denied = await restarted.resolveReview({
      id: restored.id,
      decision: 'deny',
      principal: OWNER.alice,
    });
    expect(denied.decision).toBe('deny');
  });

  it('has no toolbox of its own, so the base toolbox cannot enforce its skills', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path, run, review, options } = await parkedRunWithSkill(catalog);
    const charges: number[] = [];
    const restarted = await harness.open({
      ...(await options()),
      toolbox: chargeApprovalToolbox(charges),
      storage: { type: 'sqlite', path },
    });
    const restored = await pollUntil(
      () => restarted.listPendingReviews().find((candidate) => candidate.id === review.id),
      'the restored approval',
    );
    scheduledFireReviewStateOf(restarted).runToolboxesByRunId.delete(run.id);

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(charges).toEqual([]);
  });
});

describe('a restored fire approval whose stored skill the catalog now refuses', () => {
  it('is refused with CONFLICT, since the skill’s tool policy is not in force', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path } = await parkedFireWithSkill(catalog);
    // The skill's instructions drift while the process is away, so its digest no longer matches.
    await catalog.rewrite('Different instructions than the run had.');
    const charges: number[] = [];
    const restarted = await restartFire(catalog, path, charges);
    const restored = await pollUntil(
      () => restarted.listPendingReviews()[0],
      'the restored approval',
    );

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('could not be verified');
    expect(charges).toEqual([]);
  });
});

describe('a restored approval of a run that never activated a skill', () => {
  const chargesOnce: GenerateFunction = async (context) =>
    context.step === 0
      ? {
          content: '',
          toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
        }
      : { content: 'done', toolCalls: [] };

  it('runs as before for a schedule fire', async () => {
    const catalog = await skillCatalogOnDisk();
    const path = harness.nextDatabasePath();
    const options = async () => ({
      generate: chargesOnce,
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
      skills: { catalog: await catalog.discover() },
    });
    const first = await harness.open({
      ...(await options()),
      toolbox: chargeApprovalToolbox([]),
      storage: { type: 'sqlite', path },
    });
    const { fireId } = await fireOnce(first, OWNER.alice, 'no-skill-session');
    await reviewOf(first, fireId);
    const charges: number[] = [];
    const restarted = await harness.open({
      ...(await options()),
      toolbox: chargeApprovalToolbox(charges),
      storage: { type: 'sqlite', path },
    });
    const restored = await reviewOf(restarted, fireId);

    await approve(restarted, restored.id);

    expect(charges).toEqual([4242]);
  });

  it('runs as before for a session run with no toolbox of its own', async () => {
    const path = harness.nextDatabasePath();
    const options = {
      generate: chargesOnce,
      stopWhen: stopWhen.noToolCalls(),
    };
    const first = await harness.open({
      ...options,
      toolbox: chargeApprovalToolbox([]),
      storage: { type: 'sqlite', path },
    });
    const run = await first.createRun({ message: 'charge', principal: OWNER.alice });
    const review = await pollUntil(
      () => first.listPendingReviews().find((candidate) => candidate.runId === run.id),
      'the session run’s approval',
    );
    const charges: number[] = [];
    const restarted = await harness.open({
      ...options,
      toolbox: chargeApprovalToolbox(charges),
      storage: { type: 'sqlite', path },
    });
    await pollUntil(
      () => restarted.listPendingReviews().find((candidate) => candidate.id === review.id),
      'the restored approval',
    );
    scheduledFireReviewStateOf(restarted).runToolboxesByRunId.delete(run.id);

    await approve(restarted, review.id);

    expect(charges).toEqual([4242]);
  });
});
