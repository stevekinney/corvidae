/**
 * COR-1620 — an approval restored after a restart is never executed when the skill policy that
 * governed it cannot be verified. Unverifiable means a failed read or deserialization of the
 * snapshot, or a snapshot that names another fire; a refused recovery of a stored skill, and a run
 * with no toolbox of its own, are unverifiable too. A snapshot that verifiably names no skill is
 * not, and such an approval runs as before.
 */
import { type GenerateFunction, stopWhen, type Toolbox } from '@lostgradient/operative';
import { KEYS, type Storage } from '@lostgradient/weft';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';

import type { BureauError } from './create-bureau';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  createScheduleFireHarness,
  durableStatus,
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
import type { Bureau, BureauDiagnostic } from './types';

const harness = createScheduleFireHarness();

/**
 * Makes a toolbox's resume report no `approvalBindingConsumed`, as a toolbox without an approval
 * store does. It is installed on the toolbox itself, so the identity Bureau keys a restored run's
 * skill policy on is kept, and the resume still runs through the receiver: a skill gate in front
 * of it still sees the call.
 */
function reportNoConsumption(toolbox: Toolbox): void {
  const resume = toolbox.resumeApproval as (...args: unknown[]) => Promise<object>;
  Object.defineProperty(toolbox, 'resumeApproval', {
    configurable: true,
    value: async function (this: unknown, ...args: unknown[]) {
      const result = (await resume.apply(this, args)) as { approvalBindingConsumed?: boolean };
      const { approvalBindingConsumed: _consumed, ...unreported } = result;
      return unreported;
    },
  });
}

/**
 * Makes `toolbox` report its approval binding consumed on every resume. A call that ran and then
 * failed with the skill gate's code, for example a tool that rethrows a refusal from a gated
 * toolbox it delegates to, reports exactly this.
 */
function reportConsumption(toolbox: Toolbox): void {
  const resume = toolbox.resumeApproval as (...args: unknown[]) => Promise<object>;
  Object.defineProperty(toolbox, 'resumeApproval', {
    configurable: true,
    value: async function (this: unknown, ...args: unknown[]) {
      const result = await resume.apply(this, args);
      return { ...result, approvalBindingConsumed: true };
    },
  });
}

/** What the Bureaus a test opened reported, which a test that expects a fault asserts. */
const diagnostics: BureauDiagnostic[] = [];

afterEach(async () => {
  await harness.dispose();
  diagnostics.length = 0;
});

/** The boot recovery of a fire whose checkpoint store is unavailable fails, and says so once. */
function expectBootRecoveryFailure(): void {
  expect(diagnostics.map(({ level, scope, message }) => ({ level, scope, message }))).toEqual([
    {
      level: 'error',
      scope: 'recovery',
      message:
        '[bureau] Durable run recovery failed during boot: the checkpoint store is unavailable',
    },
  ]);
}
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

/**
 * What a read of a session's body returns, set after the restart: `missing` reads it as absent,
 * and `rejectAt` fails the read with that number (counted from `count = 0`) with an error.
 */
type BodyReads = { mode: 'through' | 'missing'; count: number; rejectAt: number | undefined };

/** A storage that reads a session's body back as `reads` says. */
function sessionBodyReads(reads: BodyReads) {
  return (storage: Storage): Storage =>
    new Proxy(storage, {
      get(target, property) {
        const member = Reflect.get(target, property, target) as unknown;
        if (typeof member !== 'function') return member;
        if (property !== 'get') return (member as (...a: unknown[]) => unknown).bind(target);
        return (...args: unknown[]) => {
          if (!String(args[0]).startsWith('agent-session-v2:body:')) {
            return (member as (...a: unknown[]) => unknown).apply(target, args);
          }
          reads.count += 1;
          if (reads.rejectAt === reads.count) {
            return Promise.reject(new Error('the session store is unavailable'));
          }
          if (reads.mode === 'missing') return Promise.resolve(null);
          return (member as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
}

const newBodyReads = (): BodyReads => ({ mode: 'through', count: 0, rejectAt: undefined });

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
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
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
    expectBootRecoveryFailure();
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
      expectBootRecoveryFailure();
    });
  }
});

describe('a restored fire approval whose snapshot names another fire', () => {
  it('is refused with CONFLICT when a newer fire of the schedule has taken the session', async () => {
    const catalog = await skillCatalogOnDisk();
    const path = harness.nextDatabasePath();
    const phase = { first: true };
    const locked = lockedAfterCharging('stop');
    const generate: GenerateFunction = (context) =>
      phase.first ? locked(context) : Promise.resolve({ content: 'nothing to do', toolCalls: [] });
    const first = await harness.open({
      generate,
      stopWhen: stopWhen.noToolCalls(),
      skills: { catalog: await catalog.discover() },
      toolbox: chargeApprovalToolbox([]),
      storage: { type: 'sqlite', path },
    });
    const created = await first.createSchedule({
      agentName: 'researcher',
      input: 'check in',
      spec: '1m',
      principal: OWNER.alice,
      sessionId: SESSION,
    });
    if (created?.nextFireAt === null || created?.nextFireAt === undefined) {
      throw new Error('The schedule has no first occurrence.');
    }
    await first.runDurableMaintenance(created.nextFireAt);
    const fireId = await pollUntil(async () => {
      const current = await first.getSchedule(created.id);
      return current?.currentWorkflowId;
    }, 'the first fire');
    await reviewOf(first, fireId);
    await pollForTime(
      async () => ((await skillsRecorded(first, SESSION)) ? true : undefined),
      'the active skill to be recorded',
    );
    await letStepsCommit();
    await pollUntil(
      async () => ((await durableStatus(first, fireId)) === 'completed' ? true : undefined),
      'the first fire to settle',
    );
    // The schedule's next occurrence is a newer fire, in the same session.
    phase.first = false;
    const schedule = await first.getSchedule(created.id);
    if (schedule?.nextFireAt === null || schedule?.nextFireAt === undefined) {
      throw new Error('The schedule has no second occurrence.');
    }
    await first.runDurableMaintenance(schedule.nextFireAt);
    const newer = await pollUntil(async () => {
      const current = await first.getSchedule(created.id);
      const id = current?.currentWorkflowId;
      return id !== undefined && id !== fireId ? id : undefined;
    }, 'the newer fire');
    await pollForTime(async () => {
      const session = await first.getSession(SESSION);
      return session?.metadata['lastScheduledFireRunId'] === newer ? true : undefined;
    }, 'the newer fire to take the session');
    const charges: number[] = [];
    const restarted = await harness.open({
      generate: () => Promise.resolve({ content: 'nothing to do', toolCalls: [] }),
      stopWhen: stopWhen.noToolCalls(),
      skills: { catalog: await catalog.discover() },
      toolbox: chargeApprovalToolbox(charges),
      storage: { type: 'sqlite', path },
    });
    const restored = await reviewOf(restarted, fireId);

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('could not be verified');
    expect(refusal.message).toContain('another fire');
    expect(charges).toEqual([]);
  });

  it('is refused with CONFLICT when the session names another fire that did not run', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path, fireId } = await parkedFireWithSkill(catalog);
    await rewriteSkillSnapshotOnDisk(path, (metadata) => {
      metadata['lastScheduledFireRunId'] = 'a-newer-fire';
    });
    const charges: number[] = [];
    const restarted = await restartFire(catalog, path, charges);
    const restored = await reviewOf(restarted, fireId);

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('another fire');
    expect(charges).toEqual([]);
  });

  it('is refused with CONFLICT when its snapshot step does not deserialize', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path, fireId } = await parkedFireWithSkill(catalog);
    await rewriteSkillSnapshotOnDisk(path, (metadata) => {
      metadata['activeSkillRecordsStep'] = 'corrupt';
    });
    const charges: number[] = [];
    const restarted = await restartFire(catalog, path, charges);
    const restored = await reviewOf(restarted, fireId);

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('snapshot step does not deserialize');
    expect(charges).toEqual([]);
  });
});

/** A session run that parks on its approval after the locking skill is active and committed. */
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
  return { path, run, review, options };
}

describe('a restored session-run approval whose snapshot cannot be read', () => {
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

  it('runs as before for a fire whose recurring schedule has since run a newer fire', async () => {
    // No `skills` option: the newer fire's snapshot is not this fire's policy, and there is none.
    const path = harness.nextDatabasePath();
    const phase = { first: true };
    const generate: GenerateFunction = (context) =>
      phase.first && context.step === 0
        ? Promise.resolve({
            content: '',
            toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
          })
        : Promise.resolve({ content: 'nothing to do', toolCalls: [] });
    const first = await harness.open({
      generate,
      stopWhen: stopWhen.noToolCalls(),
      toolbox: chargeApprovalToolbox([]),
      storage: { type: 'sqlite', path },
    });
    const created = await first.createSchedule({
      agentName: 'researcher',
      input: 'check in',
      spec: '1m',
      principal: OWNER.alice,
      sessionId: SESSION,
    });
    if (created?.nextFireAt === null || created?.nextFireAt === undefined) {
      throw new Error('The schedule has no first occurrence.');
    }
    await first.runDurableMaintenance(created.nextFireAt);
    const fireId = await pollUntil(async () => {
      const current = await first.getSchedule(created.id);
      return current?.currentWorkflowId;
    }, 'the first fire');
    await reviewOf(first, fireId);
    await pollUntil(
      async () => ((await durableStatus(first, fireId)) === 'completed' ? true : undefined),
      'the first fire to settle',
    );
    phase.first = false;
    const schedule = await first.getSchedule(created.id);
    if (schedule?.nextFireAt === null || schedule?.nextFireAt === undefined) {
      throw new Error('The schedule has no second occurrence.');
    }
    await first.runDurableMaintenance(schedule.nextFireAt);
    const newer = await pollUntil(async () => {
      const current = await first.getSchedule(created.id);
      const id = current?.currentWorkflowId;
      return id !== undefined && id !== fireId ? id : undefined;
    }, 'the newer fire');
    await pollForTime(async () => {
      const session = await first.getSession(SESSION);
      return session?.metadata['lastScheduledFireRunId'] === newer ? true : undefined;
    }, 'the newer fire to take the session');
    const charges: number[] = [];
    const restarted = await harness.open({
      generate,
      stopWhen: stopWhen.noToolCalls(),
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

describe('a restored session-run approval is decided under the snapshot read at approve', () => {
  async function restoreRun(
    catalog: SkillCatalogOnDisk,
    reads: BodyReads,
    charges: number[],
    withSkills = true,
  ) {
    const parked = await parkedRunWithSkill(catalog);
    const restarted = await harness.open({
      generate: lockedAfterCharging('stop'),
      stopWhen: stopWhen.noToolCalls(),
      ...(withSkills ? { skills: { catalog: await catalog.discover() } } : {}),
      toolbox: chargeApprovalToolbox(charges),
      storage: await harness.sqliteStorage(parked.path, sessionBodyReads(reads)),
    });
    const restored = await pollUntil(
      () => restarted.listPendingReviews().find((candidate) => candidate.id === parked.review.id),
      'the restored approval',
    );
    return { ...parked, restarted, restored };
  }

  it('is checked against the changed snapshot at approve, and the live run toolbox still refuses the call', async () => {
    const charges: number[] = [];
    const { restarted, restored, path } = await restoreRun(
      await skillCatalogOnDisk(),
      newBodyReads(),
      charges,
    );
    // As restored, the skill forbids the call.
    const before = await refusalOf(restarted, restored.id);
    expect(before.message).toContain('not permitted by the run');

    // The snapshot now says, verifiably and under the same run, that no skill is active. The
    // approve-time check follows it and lets the call through to the run's toolbox, but that
    // toolbox still holds the skill the restore activated (COR-1628), so it refuses the call
    // rather than run it under a policy the live run does not hold.
    await rewriteSkillSnapshotOnDisk(path, (metadata) => {
      metadata['activeSkillRecords'] = [];
    });
    const after = await refusalOf(restarted, restored.id);

    expect(after.message).not.toContain('not permitted by the run');
    expect(after.message).toContain("the active skills' allowed-tools exclude it");
    expect(charges).toEqual([]);
  });

  it('keeps the review pending when the run toolbox refuses the call and no approval is consumed', async () => {
    const charges: number[] = [];
    const { restarted, restored, path, run } = await restoreRun(
      await skillCatalogOnDisk(),
      newBodyReads(),
      charges,
    );
    await rewriteSkillSnapshotOnDisk(path, (metadata) => {
      metadata['activeSkillRecords'] = [];
    });
    // The run's toolbox reports no consumption for its resume, as one without an approval store
    // does, so its refusal carries no `approvalBindingConsumed`.
    const runToolbox = scheduledFireReviewStateOf(restarted).runToolboxesByRunId.get(run.id);
    if (runToolbox === undefined) throw new Error('The restored run has no toolbox of its own.');
    reportNoConsumption(runToolbox);

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain("the active skills' allowed-tools exclude it");
    expect(charges).toEqual([]);
    expect(restarted.listPendingReviews().some((review) => review.id === restored.id)).toBe(true);
    const denied = await restarted.resolveReview({
      id: restored.id,
      decision: 'deny',
      principal: OWNER.alice,
    });
    expect(denied.decision).toBe('deny');
  });

  it('resolves the review when the toolbox reports its binding consumed, whatever code the error carries', async () => {
    const charges: number[] = [];
    const { restarted, restored, path, run } = await restoreRun(
      await skillCatalogOnDisk(),
      newBodyReads(),
      charges,
    );
    await rewriteSkillSnapshotOnDisk(path, (metadata) => {
      metadata['activeSkillRecords'] = [];
    });
    // The binding is spent, so the call counts as having run: the review must not stay pending on
    // an approval no later approve could use.
    const runToolbox = scheduledFireReviewStateOf(restarted).runToolboxesByRunId.get(run.id);
    if (runToolbox === undefined) throw new Error('The restored run has no toolbox of its own.');
    reportConsumption(runToolbox);

    const resolved = await approve(restarted, restored.id);

    expect(resolved.decision).toBe('approve');
    expect(restarted.listPendingReviews().some((review) => review.id === restored.id)).toBe(false);
  });

  it('is refused when the snapshot names another run', async () => {
    const charges: number[] = [];
    const { restarted, restored, path } = await restoreRun(
      await skillCatalogOnDisk(),
      newBodyReads(),
      charges,
    );
    await rewriteSkillSnapshotOnDisk(path, (metadata) => {
      metadata['activeSkillRecordsRunId'] = 'another-run';
    });

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('names another run');
    expect(charges).toEqual([]);
  });

  it('is refused when the session cannot be found', async () => {
    const reads = newBodyReads();
    const charges: number[] = [];
    const { restarted, restored } = await restoreRun(await skillCatalogOnDisk(), reads, charges);
    reads.mode = 'missing';

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('its session is not found');
    expect(charges).toEqual([]);
  });

  it('is refused when the session cannot be read', async () => {
    const reads = newBodyReads();
    const charges: number[] = [];
    const { restarted, restored } = await restoreRun(await skillCatalogOnDisk(), reads, charges);
    // A refused approve reads the session a fixed number of times, the last at the policy check.
    reads.count = 0;
    await refusalOf(restarted, restored.id);
    const readsToTheCheck = reads.count;
    reads.count = 0;
    reads.rejectAt = readsToTheCheck;

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('could not be read');
    expect(charges).toEqual([]);
  });

  it('is refused when this Bureau has no skills to enforce the stored ones', async () => {
    const charges: number[] = [];
    const { restarted, restored } = await restoreRun(
      await skillCatalogOnDisk(),
      newBodyReads(),
      charges,
      false,
    );

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('could not be verified');
    expect(charges).toEqual([]);
  });
});
