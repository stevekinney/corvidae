/**
 * COR-323 — a session run of a catalog agent that declares `skills: createAgentSkills(...)` keeps
 * the skills it activated across a crash. Bureau snapshots the agent's own client after every step
 * and re-validates the stored records before the recovered run's first step, so the skill's
 * `allowed-tools` still narrows what the run may call. Before the change, only the removed
 * Bureau-wide `skills` option wrote that snapshot: a recovered agent run started with no active
 * skill and was offered every tool.
 *
 * The first process stays open across the "restart", as in the other restart tests: two Bureaus
 * share one SQLite file, and the first, held in a step, stands for the process that died there.
 */
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { getMessages } from 'conversationalist';

import { createAgentSkills } from './agent-skills';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  createScheduleFireHarness,
  durableStatus,
  pollUntil,
} from './schedule-fire-fixtures.test-support';
import {
  chargeApprovalToolbox,
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

type Life = { current: 'first' | 'second' };

/**
 * Step 0 activates `lock`. Step 1 hangs in the first life (the process that dies there), and in the
 * second asks for a charge, recording the tools it was offered.
 */
function dyingInStepOne(life: Life, offered: string[]): GenerateFunction {
  return async (context) => {
    if (context.step === 0) {
      return {
        content: '',
        toolCalls: [{ id: 'lock-1', name: 'activate_skill', arguments: { name: 'lock' } }],
      };
    }
    if (context.step === 1 && life.current === 'second') {
      offered.push(...context.toolbox.tools().map((tool) => tool.name));
      return {
        content: '',
        toolCalls: [{ id: 'charge-Y', name: 'charge-card', arguments: { cents: 4242 } }],
      };
    }
    if (context.step === 1) {
      return new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    }
    return { content: 'done', toolCalls: [] };
  };
}

describe('a session run of an agent with skills, reattached after its process died', () => {
  it('resumes with the skill it had activated, so the skill still narrows the run’s tools', async () => {
    const catalog = await skillCatalogOnDisk();
    const path = harness.nextDatabasePath();
    const life: Life = { current: 'first' };
    const agentFor = async (charges: number[], offered: string[]) =>
      createAgent({
        generate: dyingInStepOne(life, offered),
        stopWhen: stopWhen.noToolCalls(),
        skills: createAgentSkills({ catalog: await catalog.discover() }),
        toolbox: chargeApprovalToolbox(charges),
      });

    const first = await harness.open({
      storage: { type: 'sqlite', path },
      agents: { default: await agentFor([], []) },
    });
    const run = await first.tasks.start('default', 'lock, then charge', { principal: OWNER.alice });
    await pollForTime(
      async () => ((await skillsRecorded(first, run.contextId)) ? true : undefined),
      'the active skill to be recorded',
    );
    await letStepsCommit();

    life.current = 'second';
    const charges: number[] = [];
    const offered: string[] = [];
    const restarted = await harness.open({
      storage: { type: 'sqlite', path },
      agents: { default: await agentFor(charges, offered) },
    });
    await pollUntil(
      async () => ((await durableStatus(restarted, run.id)) === 'completed' ? true : undefined),
      'the reattached run to complete',
    );

    // The recovered run had `lock` active: `charge-card` was never offered, the call for it was
    // refused before it reached an approval, and nothing ran.
    expect(offered).not.toContain('charge-card');
    expect(restarted.reviews.list().filter((review) => review.runId === run.id)).toEqual([]);
    const session = await restarted.contexts.get(run.contextId);
    const refusal = getMessages(session!.conversationHistory).find(
      (message) => message.toolResult?.callId === 'charge-Y',
    )?.toolResult?.error?.code;
    expect(refusal).toBe('SKILL_TOOL_DENIED');
    expect(charges).toEqual([]);
  });
});
