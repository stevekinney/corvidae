/**
 * COR-1620 (correction) — the skill policy of a run whose approval is restored holds against a
 * later run that clears the session's snapshot, and against every toolbox recovery builds: a
 * replayed fire and a reattached session run take no tool their persisted skill would forbid when
 * the snapshot cannot be verified or a stored skill is refused, and keep the snapshot they hold.
 *
 * The first process stays open across each "restart", as in the other restart tests: two Bureaus
 * share one SQLite file, and the first, held in a step, stands for the process that died there.
 */
import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { type Storage } from '@lostgradient/weft';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { getMessages } from 'conversationalist';

import type { BureauError } from './create-bureau';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  crashAfterSessionWrite,
  createScheduleFireHarness,
  durableStatus,
  fireOnce,
  pollUntil,
  reviewOf,
} from './schedule-fire-fixtures.test-support';
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
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { Bureau } from './types';
import { createAgentSkills } from './agent-skills';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});
afterAll(removeSkillRoots);

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const SESSION = 'skill-recovery-session';

const approve = (bureau: Bureau, id: string) =>
  bureau.reviews.resolve({ id, decision: 'approve', principal: OWNER.alice });

async function refusalOf(bureau: Bureau, id: string): Promise<BureauError> {
  return (await rejectionOf(approve(bureau, id))) as BureauError;
}

/**
 * What the session recorded for the replayed step's call: COR-1628 refuses a call the run's skill
 * policy does not permit before the call reaches its approval, so the refusal is the call's result.
 */
async function recordedResultCode(
  bureau: Bureau,
  sessionId: string,
  callId: string,
): Promise<string | undefined> {
  return pollUntil(async () => {
    const session = await bureau.contexts.get(sessionId);
    if (session === undefined) return undefined;
    return getMessages(session.conversationHistory).find(
      (message) => message.toolResult?.callId === callId,
    )?.toolResult?.error?.code;
  }, `the result of ${callId} to be recorded`);
}

/** Rewrites the skill snapshot a session holds on disk, in its body and in the summary index. */
async function rewriteSnapshotOnDisk(
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

/** What the session holds as its skill snapshot, read from disk. */
async function snapshotOnDisk(path: string): Promise<unknown[]> {
  const storage = await harness.sqliteStorage(path);
  const found: unknown[] = [];
  for await (const [key, value] of storage.scan('agent-session-v2:body:')) {
    const record = JSON.parse(decoder.decode(value)) as { metadata?: Record<string, unknown> };
    if (record.metadata !== undefined && key.length > 0)
      found.push(record.metadata['activeSkillRecords']);
  }
  return found;
}

/** A model that never answers its step, until the run is aborted. */
const hanging: GenerateFunction = (context) =>
  new Promise((_resolve, reject) => {
    context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

/**
 * A model whose first life activates `lock` at step 0 and hangs in step 1 (the process that dies
 * there), and whose second life asks for a charge at step 1 once the replay reaches it.
 */
function dyingInStepOne(
  life: { current: 'first' | 'second' },
  offered: string[] = [],
): GenerateFunction {
  return async (context) => {
    if (context.step === 0) {
      return {
        content: '',
        toolCalls: [{ id: 'lock-1', name: 'activate_skill', arguments: { name: 'lock' } }],
      };
    }
    if (context.step === 1 && life.current === 'second') {
      // The tools the replayed step is offered.
      offered.push(...context.toolbox.tools().map((tool) => tool.name));
      return {
        content: '',
        toolCalls: [{ id: 'charge-Y', name: 'charge-card', arguments: { cents: 4242 } }],
      };
    }
    if (context.step === 1) return hanging(context);
    return { content: 'done', toolCalls: [] };
  };
}

describe('a run’s approval after a later run starts in its session', () => {
  async function restoredRunWithSkill(catalog: SkillCatalogOnDisk) {
    const path = harness.nextDatabasePath();
    const first = await harness.open({
      storage: { type: 'sqlite', path },
      agents: {
        default: createAgent({
          generate: lockedAfterCharging('stop'),
          stopWhen: stopWhen.noToolCalls(),
          skills: createAgentSkills({ catalog: await catalog.discover() }),
          toolbox: chargeApprovalToolbox([]),
        }),
      },
    });
    const run = await first.tasks.start('default', 'charge, then lock', { principal: OWNER.alice });
    const review = await pollUntil(
      () => first.reviews.list().find((candidate) => candidate.runId === run.id),
      'the session run’s approval',
    );
    await pollForTime(
      async () => ((await skillsRecorded(first, run.contextId)) ? true : undefined),
      'the active skill to be recorded',
    );
    await letStepsCommit();
    const charges: number[] = [];
    const restarted = await harness.open({
      storage: { type: 'sqlite', path },
      agents: {
        default: createAgent({
          generate: hanging,
          stopWhen: stopWhen.noToolCalls(),
          skills: createAgentSkills({ catalog: await catalog.discover() }),
          toolbox: chargeApprovalToolbox(charges),
        }),
      },
    });
    const restored = await pollUntil(
      () => restarted.reviews.list().find((candidate) => candidate.id === review.id),
      'the restored approval',
    );
    return { restarted, restored, run, charges };
  }

  it('is refused for a session run once the next run has cleared the snapshot', async () => {
    const catalog = await skillCatalogOnDisk();
    const { restarted, restored, run, charges } = await restoredRunWithSkill(catalog);
    const before = await refusalOf(restarted, restored.id);
    expect(before.message).toContain('not permitted by the run');

    // The next run starts in the session and has not finished its first step: the session's
    // snapshot is cleared, which is not a record that the earlier run had no skills.
    await restarted.tasks.start('default', 'the next run', {
      contextId: run.contextId,
      principal: OWNER.alice,
    });

    const refusal = await refusalOf(restarted, restored.id);
    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('could not be verified');
    expect(charges).toEqual([]);
  });

  it('is refused for a schedule fire once the snapshot is cleared', async () => {
    const catalog = await skillCatalogOnDisk();
    const path = harness.nextDatabasePath();
    const first = await harness.open({
      storage: { type: 'sqlite', path },
      agents: {
        default: createAgent({
          generate: lockedAfterCharging('wait'),
          stopWhen: stopWhen.noToolCalls(),
          skills: createAgentSkills({ catalog: await catalog.discover() }),
          toolbox: chargeApprovalToolbox([]),
        }),
      },
    });
    const { fireId } = await fireOnce(first, OWNER.alice, SESSION);
    await reviewOf(first, fireId);
    await pollForTime(
      async () => ((await skillsRecorded(first, SESSION)) ? true : undefined),
      'the active skill to be recorded',
    );
    await letStepsCommit();
    const charges: number[] = [];
    const restarted = await harness.open({
      storage: { type: 'sqlite', path },
      agents: {
        default: createAgent({
          generate: hanging,
          stopWhen: stopWhen.noToolCalls(),
          skills: createAgentSkills({ catalog: await catalog.discover() }),
          toolbox: chargeApprovalToolbox(charges),
        }),
      },
    });
    const restored = await reviewOf(restarted, fireId);
    // The start of a run in the fire's session clears its snapshot: a run cannot be started in a
    // session of the harness's fire agent, so the clearing is written as it leaves the session.
    await rewriteSnapshotOnDisk(path, (metadata) => {
      metadata['activeSkillRecordsRunId'] = null;
      metadata['activeSkillRecords'] = null;
    });

    const refusal = await refusalOf(restarted, restored.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('could not be verified');
    expect(charges).toEqual([]);
  });

  it('is still approved when no skills are configured, whatever the next run left', async () => {
    const path = harness.nextDatabasePath();
    const chargesOnce: GenerateFunction = async (context) =>
      context.step === 0
        ? {
            content: '',
            toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
          }
        : { content: 'done', toolCalls: [] };
    const first = await harness.open({
      storage: { type: 'sqlite', path },
      agents: {
        default: createAgent({
          generate: chargesOnce,
          stopWhen: stopWhen.noToolCalls(),
          toolbox: chargeApprovalToolbox([]),
        }),
      },
    });
    const run = await first.tasks.start('default', 'charge', { principal: OWNER.alice });
    const review = await pollUntil(
      () => first.reviews.list().find((candidate) => candidate.runId === run.id),
      'the session run’s approval',
    );
    const charges: number[] = [];
    const restarted = await harness.open({
      storage: { type: 'sqlite', path },
      agents: {
        default: createAgent({
          generate: hanging,
          stopWhen: stopWhen.noToolCalls(),
          toolbox: chargeApprovalToolbox(charges),
        }),
      },
    });
    await pollUntil(
      () => restarted.reviews.list().find((candidate) => candidate.id === review.id),
      'the restored approval',
    );
    await restarted.tasks.start('default', 'the next run', {
      contextId: run.contextId,
      principal: OWNER.alice,
    });

    await approve(restarted, review.id);

    expect(charges).toEqual([4242]);
  });
});

describe('a fire replayed after its process died in a step', () => {
  async function fireDyingInStepOne(catalog: SkillCatalogOnDisk) {
    const path = harness.nextDatabasePath();
    const life = { current: 'first' as 'first' | 'second' };
    const first = await harness.open({
      storage: { type: 'sqlite', path },
      agents: {
        default: createAgent({
          generate: dyingInStepOne(life),
          stopWhen: stopWhen.noToolCalls(),
          skills: createAgentSkills({ catalog: await catalog.discover() }),
          toolbox: chargeApprovalToolbox([]),
        }),
      },
    });
    const { fireId } = await fireOnce(first, OWNER.alice, SESSION);
    await pollForTime(
      async () => ((await skillsRecorded(first, SESSION)) ? true : undefined),
      'the active skill to be recorded',
    );
    await letStepsCommit();
    return { path, fireId, life };
  }

  async function replay(
    catalog: SkillCatalogOnDisk,
    path: string,
    life: { current: 'first' | 'second' },
    charges: number[],
    wrap?: (storage: Storage) => Storage,
    offered: string[] = [],
    withSkills = true,
  ) {
    life.current = 'second';
    const skills = withSkills
      ? { skills: createAgentSkills({ catalog: await catalog.discover() }) }
      : {};
    return harness.open({
      storage:
        wrap === undefined ? { type: 'sqlite', path } : await harness.sqliteStorage(path, wrap),
      agents: {
        default: createAgent({
          generate: dyingInStepOne(life, offered),
          stopWhen: stopWhen.noToolCalls(),
          ...skills,
          toolbox: chargeApprovalToolbox(charges),
        }),
      },
    });
  }

  it('runs no tool, and keeps the snapshot, when the snapshot cannot be read', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path, fireId, life } = await fireDyingInStepOne(catalog);
    await rewriteSnapshotOnDisk(path, (metadata) => {
      metadata['activeSkillRecordsStep'] = 'corrupt';
    });
    const charges: number[] = [];
    const offered: string[] = [];
    const restarted = await replay(catalog, path, life, charges, undefined, offered);

    await pollUntil(
      async () => ((await durableStatus(restarted, fireId)) === 'completed' ? true : undefined),
      'the replayed fire to complete',
    );

    expect(offered).toEqual([]);
    expect(charges).toEqual([]);
    // The call is refused before it reaches an approval, because the policy is unverified.
    expect(restarted.reviews.list().filter((review) => review.runId === fireId)).toEqual([]);
    expect(await recordedResultCode(restarted, SESSION, 'charge-Y')).toBe('SKILL_TOOL_DENIED');
    expect(charges).toEqual([]);
    const held = await snapshotOnDisk(path);
    expect(held.some((records) => Array.isArray(records) && records.length === 1)).toBe(true);
  });

  it('runs no tool, and keeps the snapshot, when a stored skill is refused on recovery', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path, fireId, life } = await fireDyingInStepOne(catalog);
    await catalog.rewrite('Instructions that are not the ones the run had.');
    const charges: number[] = [];
    const offered: string[] = [];
    const restarted = await replay(catalog, path, life, charges, undefined, offered);

    await pollUntil(
      async () => ((await durableStatus(restarted, fireId)) === 'completed' ? true : undefined),
      'the replayed fire to complete',
    );

    expect(offered).toEqual([]);
    expect(charges).toEqual([]);
    // The call is refused before it reaches an approval, because the policy is unverified.
    expect(restarted.reviews.list().filter((review) => review.runId === fireId)).toEqual([]);
    expect(await recordedResultCode(restarted, SESSION, 'charge-Y')).toBe('SKILL_TOOL_DENIED');
    expect(charges).toEqual([]);
    const held = await snapshotOnDisk(path);
    expect(held.some((records) => Array.isArray(records) && records.length === 1)).toBe(true);
  });

  it('is refused at approve, under the snapshot read again, once the snapshot names another fire', async () => {
    // A skill that allows the charge: the replayed step's approval is listed, under a toolbox
    // that recovery built.
    const catalog = await skillCatalogOnDisk('charge-card, deactivate_skill');
    const { path, fireId, life } = await fireDyingInStepOne(catalog);
    const charges: number[] = [];
    const restarted = await replay(catalog, path, life, charges);
    const listed = await reviewOf(restarted, fireId);
    await rewriteSnapshotOnDisk(path, (metadata) => {
      metadata['lastScheduledFireRunId'] = 'a-newer-fire';
    });

    const refusal = await refusalOf(restarted, listed.id);

    expect(refusal.code).toBe('CONFLICT');
    expect(refusal.message).toContain('could not be verified');
    expect(charges).toEqual([]);
  });

  it('lists the approval and runs it under the intact snapshot, which allows the call', async () => {
    const catalog = await skillCatalogOnDisk('charge-card, deactivate_skill');
    const { path, fireId, life } = await fireDyingInStepOne(catalog);
    const charges: number[] = [];
    const offered: string[] = [];
    const restarted = await replay(catalog, path, life, charges, undefined, offered);
    const listed = await reviewOf(restarted, fireId);

    await approve(restarted, listed.id).catch(() => undefined);

    expect(offered).toContain('charge-card');
    expect(charges).toEqual([4242]);
  });

  it('is offered no tool, and its call is refused, when this Bureau has no skills to enforce the stored ones', async () => {
    const catalog = await skillCatalogOnDisk('charge-card, deactivate_skill');
    const { path, fireId, life } = await fireDyingInStepOne(catalog);
    const charges: number[] = [];
    const offered: string[] = [];
    const restarted = await replay(catalog, path, life, charges, undefined, offered, false);

    await pollUntil(
      async () => ((await durableStatus(restarted, fireId)) === 'completed' ? true : undefined),
      'the replayed fire to complete',
    );

    // The call is refused before it reaches an approval: this Bureau cannot enforce the skills.
    expect(restarted.reviews.list().filter((review) => review.runId === fireId)).toEqual([]);
    expect(await recordedResultCode(restarted, SESSION, 'charge-Y')).toBe('SKILL_TOOL_DENIED');
    expect(offered).toEqual([]);
    expect(charges).toEqual([]);
  });
});

describe('a session run reattached after its process died in a step', () => {
  async function runDyingInStepOne(catalog: SkillCatalogOnDisk) {
    const path = harness.nextDatabasePath();
    const life = { current: 'first' as 'first' | 'second' };
    const first = await harness.open({
      storage: { type: 'sqlite', path },
      agents: {
        default: createAgent({
          generate: dyingInStepOne(life),
          stopWhen: stopWhen.noToolCalls(),
          skills: createAgentSkills({ catalog: await catalog.discover() }),
          toolbox: chargeApprovalToolbox([]),
        }),
      },
    });
    const run = await first.tasks.start('default', 'lock, then charge', { principal: OWNER.alice });
    await pollForTime(
      async () => ((await skillsRecorded(first, run.contextId)) ? true : undefined),
      'the active skill to be recorded',
    );
    await letStepsCommit();
    return { path, run, life };
  }

  async function reattach(
    catalog: SkillCatalogOnDisk,
    path: string,
    life: { current: 'first' | 'second' },
    charges: number[],
    offered: string[] = [],
    onLog?: (record: { level: string; message: string }) => void,
  ) {
    life.current = 'second';
    return harness.open({
      ...(onLog === undefined ? {} : { onLog }),
      storage: { type: 'sqlite', path },
      agents: {
        default: createAgent({
          generate: dyingInStepOne(life, offered),
          stopWhen: stopWhen.noToolCalls(),
          skills: createAgentSkills({ catalog: await catalog.discover() }),
          toolbox: chargeApprovalToolbox(charges),
        }),
      },
    });
  }

  it('runs no tool, and keeps the snapshot, when the snapshot cannot be read', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path, run, life } = await runDyingInStepOne(catalog);
    await rewriteSnapshotOnDisk(path, (metadata) => {
      metadata['activeSkillRecords'] = 'not records';
    });
    const charges: number[] = [];
    const offered: string[] = [];
    const restarted = await reattach(catalog, path, life, charges, offered);

    await pollUntil(
      async () => ((await durableStatus(restarted, run.id)) === 'completed' ? true : undefined),
      'the reattached run to complete',
    );

    expect(offered).toEqual([]);
    expect(charges).toEqual([]);
    // The call is refused before it reaches an approval, because the policy is unverified.
    expect(restarted.reviews.list().filter((review) => review.runId === run.id)).toEqual([]);
    expect(await recordedResultCode(restarted, run.contextId, 'charge-Y')).toBe(
      'SKILL_TOOL_DENIED',
    );
    expect(charges).toEqual([]);
    const held = await snapshotOnDisk(path);
    expect(held.some((records) => records === 'not records')).toBe(true);
  });

  it('logs a warning naming the run and the reason when it is reattached unverified', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path, run, life } = await runDyingInStepOne(catalog);
    await rewriteSnapshotOnDisk(path, (metadata) => {
      metadata['activeSkillRecords'] = 'not records';
    });
    const logs: { level: string; message: string }[] = [];
    const restarted = await reattach(catalog, path, life, [], [], (record) => logs.push(record));

    await pollUntil(
      async () => ((await durableStatus(restarted, run.id)) === 'completed' ? true : undefined),
      'the reattached run to complete',
    );

    const warning = logs.find((record) => record.message.includes('is reattached without tools'));
    expect(warning?.level).toBe('warn');
    expect(warning?.message).toContain(run.id);
    expect(warning?.message).toContain('do not deserialize');
  });

  it('runs no tool, and keeps the snapshot, when a stored skill is refused on recovery', async () => {
    const catalog = await skillCatalogOnDisk();
    const { path, run, life } = await runDyingInStepOne(catalog);
    await catalog.rewrite('Instructions that are not the ones the run had.');
    const charges: number[] = [];
    const offered: string[] = [];
    const restarted = await reattach(catalog, path, life, charges, offered);

    await pollUntil(
      async () => ((await durableStatus(restarted, run.id)) === 'completed' ? true : undefined),
      'the reattached run to complete',
    );

    expect(offered).toEqual([]);
    expect(charges).toEqual([]);
    // The call is refused before it reaches an approval, because the policy is unverified.
    expect(restarted.reviews.list().filter((review) => review.runId === run.id)).toEqual([]);
    expect(await recordedResultCode(restarted, run.contextId, 'charge-Y')).toBe(
      'SKILL_TOOL_DENIED',
    );
    expect(charges).toEqual([]);
    const held = await snapshotOnDisk(path);
    expect(held.some((records) => Array.isArray(records) && records.length === 1)).toBe(true);
  });
});

describe('a fire replayed after its process died before committing the step that activated a skill', () => {
  it('is decided under no skill, since no committed step activated one', async () => {
    const catalog = await skillCatalogOnDisk();
    const path = harness.nextDatabasePath();
    const crash = crashAfterSessionWrite('"name":"lock"');
    const life = { current: 'first' as 'first' | 'second' };
    // Step 0 activates the skill in the first life, and asks for the charge in the second.
    const generate: GenerateFunction = async (context) => {
      if (context.step > 0) return { content: 'done', toolCalls: [] };
      const toolCalls =
        life.current === 'first'
          ? [{ id: 'lock-1', name: 'activate_skill', arguments: { name: 'lock' } }]
          : [{ id: 'charge-Z', name: 'charge-card', arguments: { cents: 4242 } }];
      return { content: '', toolCalls };
    };
    const first = await harness.open({
      storage: await harness.sqliteStorage(path, crash.wrap),
      agents: {
        default: createAgent({
          generate,
          stopWhen: stopWhen.noToolCalls(),
          skills: createAgentSkills({ catalog: await catalog.discover() }),
          toolbox: chargeApprovalToolbox([]),
        }),
      },
    });
    const { fireId } = await fireOnce(first, OWNER.alice, SESSION);
    await crash.reached;
    // The session holds the skill the step activated; the step never committed.
    await pollForTime(
      async () => ((await skillsRecorded(first, SESSION)) ? true : undefined),
      'the active skill to be recorded',
    );

    life.current = 'second';
    const charges: number[] = [];
    const restarted = await harness.open({
      storage: { type: 'sqlite', path },
      agents: {
        default: createAgent({
          generate,
          stopWhen: stopWhen.noToolCalls(),
          skills: createAgentSkills({ catalog: await catalog.discover() }),
          toolbox: chargeApprovalToolbox(charges),
        }),
      },
    });
    const listed = await reviewOf(restarted, fireId);

    await approve(restarted, listed.id);

    expect(charges).toEqual([4242]);
  });
});
