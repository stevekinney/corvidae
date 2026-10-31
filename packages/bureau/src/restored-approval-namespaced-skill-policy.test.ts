/**
 * COR-1879 — an approval is decided under the active skills by the tool it is bound to, not by the
 * tool's bare name: two namespaces each hold a `charge-card`, and a skill that allows one of them
 * does not let an approval for the other run.
 */
import { type Toolbox, stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createAgentSkills } from './agent-skills';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import { createScheduleFireHarness, pollUntil } from './schedule-fire-fixtures.test-support';
import {
  letStepsCommit,
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

/** `billing:charge-card` and `other:charge-card`, both needing approval. */
function namespacedChargeToolbox(charges: string[]): Toolbox {
  const charge = (namespace: string) =>
    createTool({
      name: 'charge-card',
      namespace,
      version: '1.0.0',
      description: `Charge a card through ${namespace}`,
      input: z.object({ cents: z.number() }),
      async execute() {
        charges.push(namespace);
        return { charged: namespace };
      },
    });
  return createToolbox([charge('billing'), charge('other')], {
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
  }) as unknown as Toolbox;
}

describe('an approval under a skill that allows a same-named tool in another namespace', () => {
  it('refuses the approved call to the tool the skill does not allow', async () => {
    const onDisk = await skillCatalogOnDisk('other:charge-card, deactivate_skill');
    const catalog = await onDisk.discover();
    const charges: string[] = [];
    const bureau = await harness.open({
      generate: async (context) => {
        if (context.step === 0) {
          return {
            content: '',
            toolCalls: [{ id: 'charge-X', name: 'billing__charge-card', arguments: { cents: 1 } }],
          };
        }
        if (context.step === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'lock-1', name: 'activate_skill', arguments: { name: 'lock' } }],
          };
        }
        return { content: 'done', toolCalls: [] };
      },
      stopWhen: stopWhen.noToolCalls(),
      skills: createAgentSkills({ catalog }),
      storage: harness.sqliteHandle(harness.nextDatabasePath()),
      toolbox: namespacedChargeToolbox(charges),
    });
    const run = await bureau.tasks.start('default', 'charge, then lock', {
      principal: OWNER.alice,
    });
    const review = await pollUntil(
      () => bureau.reviews.list().find((candidate) => candidate.runId === run.id),
      'the run’s approval',
    );
    await pollForTime(
      async () => ((await skillsRecorded(bureau, run.contextId)) ? true : undefined),
      'the active skill to be recorded',
    );
    await letStepsCommit();

    const outcome = await bureau.reviews
      .resolve({ id: review.id, decision: 'approve', principal: OWNER.alice })
      .then(
        () => 'approved',
        (error: unknown) => (error as { code?: string }).code,
      );

    expect(outcome).toBe('CONFLICT');
    expect(charges).toEqual([]);
  });
});
