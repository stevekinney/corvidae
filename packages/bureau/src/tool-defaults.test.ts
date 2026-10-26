/**
 * COR-1700 — a durable Bureau offers `requestHumanInput` and `scheduleWakeup` by default, to the
 * run kinds that received them under the old `humanInput: true` / `wakeup: true` opt-ins:
 * session tasks (`createRun`), schedule fires, and durable catalog tasks (`bureau.run`). Child
 * runs and goal attempts never receive them. `false` removes exactly one tool, `true` is refused
 * with `BAD_REQUEST`, and a non-durable Bureau offers neither whatever the options say.
 */
import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { BureauError, createBureau } from './create-bureau';
import {
  createScheduleFireHarness,
  fireOnce,
  pollUntil as pollUntilDefined,
} from './schedule-fire-fixtures.test-support';
import { createAgentSkills } from './agent-skills';
import { removeSkillRoots, skillCatalogOnDisk } from './skill-policy-fixtures.test-support';
import { waitForRunState } from './test';
import { AGENT_STEP, workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { startWorkflowBureau } from './testing/workflow-bureau.test-support';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau, BureauOptions } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];
const harness = createScheduleFireHarness();

afterAll(removeSkillRoots);

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  await harness.dispose();
});

async function pollUntil(check: () => boolean, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('Condition was not met.');
}

/** The tool names offered at each step an agent took. */
type Offered = string[][];

/** An agent that records the tools it was offered and finishes with no tool call. */
function recordingAgent(offered: Offered) {
  const generate: GenerateFunction = async (context: GenerateContext) => {
    offered.push(context.toolbox.tools().map((tool) => tool.name));
    return { content: 'done', toolCalls: [] };
  };
  return createAgent({ generate, toolbox: createToolbox([]) });
}

/** An agent that records its tools, then parks on `requestHumanInput` so it stays running. */
function parkingAgent(offered: Offered) {
  const generate: GenerateFunction = async (context: GenerateContext) => {
    offered.push(context.toolbox.tools().map((tool) => tool.name));
    if (context.step > 0) return { content: 'done', toolCalls: [] };
    return {
      content: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'requestHumanInput',
          arguments: { signalName: 'answer', prompt: '?' },
        },
      ],
    };
  };
  return createAgent({
    generate,
    toolbox: createToolbox([]),
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
  });
}

type ToolOptions = Pick<BureauOptions<AgentDefinitions>, 'humanInput' | 'wakeup'>;

async function start(
  agents: AgentDefinitions,
  options: ToolOptions & { durable?: boolean } = {},
): Promise<Bureau<AgentDefinitions>> {
  const { durable = true, ...toolOptions } = options;
  const bureau = await createBureau<AgentDefinitions>({
    agents: { ...agents },
    storage: { type: 'memory' },
    durableExecution: durable,
    ...toolOptions,
  });
  bureaus.push(bureau);
  return bureau;
}

async function sessionTaskTools(options: ToolOptions & { durable?: boolean }): Promise<string[]> {
  const offered: Offered = [];
  const bureau = await start(
    { alpha: recordingAgent(offered), default: recordingAgent([]) },
    options,
  );
  const run = await bureau.createRun({ message: 'hello', agentName: 'alpha' });
  await waitForRunState(bureau, run.id);
  for (let turn = 0; turn < 10; turn += 1) await yieldToPortableEventLoop();
  return offered.flat();
}

async function catalogTaskTools(options: ToolOptions & { durable?: boolean }): Promise<string[]> {
  const offered: Offered = [];
  const bureau = await start({ asker: recordingAgent(offered) }, options);
  await bureau.run('asker', 'go').result();
  return offered.flat();
}

async function scheduleFireTools(options: ToolOptions): Promise<string[]> {
  const offered: Offered = [];
  const bureau = await harness.open({
    ...options,
    agents: { default: recordingAgent(offered) },
  });
  await fireOnce(bureau);
  await pollUntilDefined(() => (offered.length > 0 ? true : undefined), 'the fire to run');
  return offered.flat();
}

describe('a durable Bureau offers the tools by default', () => {
  it('offers both to a session task and only the other when one is false', async () => {
    const absent = await sessionTaskTools({});
    expect(absent).toContain('requestHumanInput');
    expect(absent).toContain('scheduleWakeup');

    const noHumanInput = await sessionTaskTools({ humanInput: false });
    expect(noHumanInput).not.toContain('requestHumanInput');
    expect(noHumanInput).toContain('scheduleWakeup');

    const noWakeup = await sessionTaskTools({ wakeup: false });
    expect(noWakeup).toContain('requestHumanInput');
    expect(noWakeup).not.toContain('scheduleWakeup');
  });

  it('keeps requestHumanInput when humanInput carries inputSchemas', async () => {
    const tools = await sessionTaskTools({
      humanInput: { inputSchemas: { answer: { type: 'string' } } },
    });
    expect(tools).toContain('requestHumanInput');
  });

  it('offers requestHumanInput, not scheduleWakeup, to a durable catalog task', async () => {
    const absent = await catalogTaskTools({});
    expect(absent).toContain('requestHumanInput');
    expect(absent).not.toContain('scheduleWakeup');

    expect(await catalogTaskTools({ humanInput: false })).not.toContain('requestHumanInput');
  });

  it('offers requestHumanInput, not scheduleWakeup, to a schedule fire', async () => {
    const absent = await scheduleFireTools({});
    expect(absent).toContain('requestHumanInput');
    expect(absent).not.toContain('scheduleWakeup');

    expect(await scheduleFireTools({ humanInput: false })).not.toContain('requestHumanInput');
  });

  it('offers neither tool to a child run', async () => {
    const childOffered: Offered = [];
    const bureau = await start({
      parent: parkingAgent([]),
      child: recordingAgent(childOffered),
    });
    const parent = bureau.run('parent', 'go');
    await pollUntil(() => bureau.listPendingReviews().some((review) => review.runId === parent.id));

    const dispatched = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'child',
      input: 'go',
    });
    expect(dispatched.outcome).toBe('started');
    await pollUntil(() => childOffered.length > 0);

    expect(childOffered.flat()).not.toContain('requestHumanInput');
    expect(childOffered.flat()).not.toContain('scheduleWakeup');
  });

  it('narrows the tools to an active skill’s allowed-tools, the two it adds included', async () => {
    const offered: Offered = [];
    const catalog = await skillCatalogOnDisk();
    const generate: GenerateFunction = async (context) => {
      offered.push(context.toolbox.tools().map((tool) => tool.name));
      return context.step === 0
        ? {
            content: '',
            toolCalls: [{ id: 'lock-1', name: 'activate_skill', arguments: { name: 'lock' } }],
          }
        : { content: 'done', toolCalls: [] };
    };
    const bureau = await start({
      asker: createAgent({
        generate,
        toolbox: createToolbox([]),
        skills: createAgentSkills({ catalog: await catalog.discover() }),
      }),
    });
    await bureau.run('asker', 'go').result();

    expect(offered[0]).toContain('requestHumanInput');
    // `lock` allows only `deactivate_skill`: the Bureau's own tools are narrowed with the rest.
    expect(offered[1]).not.toContain('requestHumanInput');
    expect(offered[1]).toContain('deactivate_skill');
  });

  it('offers neither tool to a workflow-file agent step', async () => {
    const offered: Offered = [];
    const harness = await startWorkflowBureau({
      overrides: { agents: { writer: recordingAgent(offered) } },
    });
    try {
      await harness.put(
        'digest.json',
        workflowFileText('digest', {
          trigger: { kind: 'schedule', spec: '1h' },
          steps: [{ ...AGENT_STEP }],
        }),
      );
      await harness.bureau.workflows?.refresh();
      const instance = await harness.bureau.durableEngine()?.start('digest', null, { id: 'step' });
      await instance?.result();

      expect(offered.length).toBeGreaterThan(0);
      expect(offered.flat()).not.toContain('requestHumanInput');
      expect(offered.flat()).not.toContain('scheduleWakeup');

      // The control: the same agent, run directly on the same Bureau, is offered the tool.
      offered.length = 0;
      await harness.bureau.run('writer', 'go').result();
      expect(offered.flat()).toContain('requestHumanInput');
    } finally {
      await harness.dispose();
    }
  });

  it('offers neither tool to a goal attempt', async () => {
    const offered: Offered = [];
    const withValidator = await createBureau<AgentDefinitions>({
      agents: { asker: recordingAgent(offered) },
      storage: { type: 'memory' },
      durableExecution: true,
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
    });
    bureaus.push(withValidator);
    await withValidator.goals.create({
      goalRunId: 'goal-1',
      agentName: 'asker',
      prompt: 'go',
      identity: { name: 'goal', version: '1' },
      validator: { name: 'accepts-any-answer', version: '1' },
      bounds: { maximumAttempts: 1, maximumTotalSteps: 5 },
    });
    await pollUntil(() => offered.length > 0);

    expect(offered.flat()).not.toContain('requestHumanInput');
    expect(offered.flat()).not.toContain('scheduleWakeup');
  });
});

describe('a non-durable Bureau offers neither tool', () => {
  it('whatever the options say', async () => {
    for (const options of [{}, { humanInput: false, wakeup: false } as const]) {
      const session = await sessionTaskTools({ ...options, durable: false });
      const catalog = await catalogTaskTools({ ...options, durable: false });
      for (const tools of [session, catalog]) {
        expect(tools).not.toContain('requestHumanInput');
        expect(tools).not.toContain('scheduleWakeup');
      }
    }
    const withSchemas = await sessionTaskTools({
      humanInput: { inputSchemas: { answer: { type: 'string' } } },
      durable: false,
    });
    expect(withSchemas).not.toContain('requestHumanInput');
  });
});

describe('humanInput and wakeup accept only their documented forms', () => {
  it.each([
    ['humanInput', true],
    ['wakeup', true],
    ['wakeup', 'yes'],
    ['wakeup', null],
    ['humanInput', 'yes'],
  ] as const)('refuses %s: %p as BAD_REQUEST', async (name, value) => {
    const error = await rejectionOf(
      createBureau<AgentDefinitions>({
        agents: { default: recordingAgent([]) },
        storage: { type: 'memory' },
        durableExecution: true,
        [name]: value,
      } as unknown as BureauOptions<AgentDefinitions>),
    );
    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('BAD_REQUEST');
    expect((error as BureauError).message).toContain(name);
  });
});
