/**
 * COR-1613 — an approval restored after a restart is decided under the active-skill policy that
 * governed the call when it was requested, for a schedule fire and a session run alike.
 *
 * A skill's `allowed-tools` narrows what a run may call. The session persists the active skills,
 * but the restore of a pending approval built its toolbox without them, so a call the skill would
 * refuse ran after the restart.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction, stopWhen, type Toolbox } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  createScheduleFireHarness,
  fireOnce,
  pollUntil,
  reviewOf,
} from './schedule-fire-fixtures.test-support';
import { discoverSkills, type SkillCatalogRevision } from './skills';
import type { Bureau } from './types';

const harness = createScheduleFireHarness();
const roots: string[] = [];

afterEach(async () => {
  await harness.dispose();
});
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** `charge-card` needs approval; the skill tools do not. */
function approvalToolbox(charges: number[]): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret: 'skill-policy-secret',
      policy: {
        beforeExecute: (context) =>
          context.toolName === 'charge-card'
            ? {
                allow: false,
                status: 'needs_approval',
                reason: 'Operator approval required',
                action: { message: 'Approve charge' },
              }
            : { allow: true },
      },
    },
  ) as unknown as Toolbox;
}

/** A catalog with one skill that narrows a run to `deactivate_skill`, so `charge-card` is refused. */
async function lockingCatalog(): Promise<SkillCatalogRevision> {
  const root = await mkdtemp(join(tmpdir(), 'bureau-restored-skill-policy-'));
  roots.push(root);
  await mkdir(join(root, 'lock'), { recursive: true });
  await writeFile(
    join(root, 'lock', 'SKILL.md'),
    [
      '---',
      'name: lock',
      'description: Locks the run to deactivation',
      'allowed-tools: deactivate_skill',
      '---',
      '',
      'Only deactivate.',
      '',
    ].join('\n'),
  );
  return discoverSkills({
    sources: [{ id: 'user', kind: 'user', location: root, precedence: 20 }],
  });
}

/** Step 0 asks for a charge, step 1 activates the locking skill, and step 2 stops or waits. */
function lockedAfterCharging(finish: 'stop' | 'wait'): GenerateFunction {
  return async (context) => {
    if (context.step === 0) {
      return {
        content: '',
        toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
      };
    }
    if (context.step === 1) {
      return {
        content: '',
        toolCalls: [{ id: 'lock-1', name: 'activate_skill', arguments: { name: 'lock' } }],
      };
    }
    if (finish === 'stop') return { content: 'done', toolCalls: [] };
    return new Promise((_resolve, reject) => {
      context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
}

/** Polls by the clock: the steps in question are separated by real work, not by event-loop turns. */
async function pollForTime<T>(check: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Condition was not met: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function skillsRecorded(bureau: Bureau, sessionId: string): Promise<boolean> {
  const session = await bureau.getSession(sessionId);
  const records = session?.metadata['activeSkillRecords'];
  return Array.isArray(records) && records.length > 0;
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
    for (let turn = 0; turn < 100; turn += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));

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
    const run = await first.createRun({ message: 'charge, then lock', principal: OWNER.alice });
    const review = await pollUntil(
      () => first.listPendingReviews().find((candidate) => candidate.runId === run.id),
      'the session run’s approval',
    );
    await pollForTime(
      async () => ((await skillsRecorded(first, run.sessionId)) ? true : undefined),
      'the active skill to be recorded',
    );
    for (let turn = 0; turn < 100; turn += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));

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
    const run = await first.createRun({ message: 'charge', principal: OWNER.alice });
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
