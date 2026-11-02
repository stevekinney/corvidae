/**
 * COR-1996 — the model policy binds a plugin code agent's run at every path that builds one: a
 * child run or workflow step the catalog dispatches, durable or not, a task and its session run, a durable run reattached
 * after a restart, and the run runtime a session or a schedule fire is built from. A step whose
 * model the deployment or the Bureau forbids ends in error naming the model before any provider is
 * called, and a step whose model the policy allows runs unchanged.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  type BackendDescriptor,
  createAgent,
  createModelCatalog,
  type DurableRunDeps,
  type GenerateFunction,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import type { AgentDefinitions } from './agent-catalog';
import { createCatalogDispatcher } from './bureau-catalog-dispatch';
import { createBureau } from './create-bureau';
import { ModelPolicyDeniedError } from './file-agent-generate';
import type { BureauModelPolicyOptions } from './model-policy';
import { createRuntimeComposition } from './runtime-composition';
import { createSteppedGenerate, noopTool } from './testing/model-override.test-support';
import { waitForTaskState } from './test';
import { startTaskFrom } from './test/task-start-request.ts';
import type { Bureau } from './types';

const rows = createModelCatalog().descriptors;
const row = (provider: string, model: string): BackendDescriptor => {
  const found = rows.find(
    (candidate) => candidate.provider === provider && candidate.model === model,
  );
  if (found === undefined) throw new Error(`The catalog has no ${provider}/${model}.`);
  return found;
};

const OPUS_5_5 = row('anthropic', 'claude-opus-5-5');

const DENY_OPUS_5_5: BureauModelPolicyOptions = {
  deployment: { deniedModels: ['claude-opus-5-5'] },
  policyRevision: 2,
};
const DENY_OPUS_5: BureauModelPolicyOptions = {
  bureau: { deniedModels: ['claude-opus-5'] },
  policyRevision: 3,
};

/** The policy and catalog a composition reads in these tests: the default catalog. */
const source = (modelPolicy: BureauModelPolicyOptions) => ({
  current: () => modelPolicy,
  catalog: () => rows,
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A generate that reports `descriptor` as its one catalog row and records each call it takes. */
function fixedGenerate(descriptor: BackendDescriptor, calls: string[]): GenerateFunction {
  return withBackendDescriptors(async () => {
    calls.push(descriptor.model);
    return { content: 'done', toolCalls: [] };
  }, [descriptor]);
}

async function openBureau(options: {
  readonly generate: GenerateFunction;
  readonly modelPolicy: BureauModelPolicyOptions;
  readonly durable: boolean;
}) {
  const bureau = await createBureau<AgentDefinitions>({
    agents: { coder: createAgent({ name: 'coder', generate: options.generate }) },
    storage: new MemoryStorage(),
    ...(options.durable ? { durable: true } : {}),
    modelPolicy: options.modelPolicy,
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function runCoder(bureau: Bureau<AgentDefinitions>, contextId?: string) {
  const run = await startTaskFrom(bureau, {
    input: 'go',
    agentName: 'coder',
    principal: 'alice',
    ...(contextId === undefined ? {} : { contextId }),
  });
  await waitForTaskState(bureau, run.id);
  return bureau.tasks.detail(run.id);
}

describe.each([
  ['a durable task', true],
  ['a task that is not durable', false],
])('%s of a code agent', (_name, durable) => {
  it('ends in error naming the model, and never calls the provider, when the policy forbids it', async () => {
    const calls: string[] = [];
    const bureau = await openBureau({
      generate: fixedGenerate(OPUS_5_5, calls),
      modelPolicy: DENY_OPUS_5_5,
      durable,
    });

    const summary = await runCoder(bureau);

    expect(summary?.status).toBe('error');
    expect(summary?.error).toContain('anthropic/claude-opus-5-5');
    expect(summary?.error).toContain('deployment');
    expect(calls).toEqual([]);
  });

  it('runs a model the policy allows unchanged', async () => {
    const calls: string[] = [];
    const bureau = await openBureau({
      generate: fixedGenerate(OPUS_5_5, calls),
      modelPolicy: DENY_OPUS_5,
      durable,
    });

    const summary = await runCoder(bureau);

    expect(summary?.status).not.toBe('error');
    expect(calls).toEqual(['claude-opus-5-5']);
  });
});

describe('a session run of a code agent', () => {
  it('ends in error naming the model, and never calls the provider, when the policy forbids it', async () => {
    const calls: string[] = [];
    const bureau = await openBureau({
      generate: fixedGenerate(OPUS_5_5, calls),
      modelPolicy: DENY_OPUS_5_5,
      durable: true,
    });

    const summary = await runCoder(bureau, 'coder-session');

    expect(summary?.status).toBe('error');
    expect(summary?.error).toContain('anthropic/claude-opus-5-5');
    expect(calls).toEqual([]);
  });
});

describe('a durable run of a code agent reattached after a restart', () => {
  async function recovered(modelPolicy: BureauModelPolicyOptions, calls: string[]) {
    const runtime = await createRuntimeComposition(
      { storage: new MemoryStorage(), durable: true },
      { modelPolicy: source(modelPolicy) },
    );
    cleanups.push(() => runtime.durable?.engine[Symbol.dispose]?.());
    runtime.setCatalogAgentRunOptionsResolver(async () => ({
      status: 'resolved',
      options: {
        generate: fixedGenerate(OPUS_5_5, calls),
        toolbox: createToolbox([], { context: {} }),
        conversation: createConversationHistory({ id: 'recovered-coder' }),
      },
      definitionRevision: 1,
      generationMode: 'fixed',
    }));
    await runtime.persistCatalogRunRecoveryRecord('recovered-coder-run', {
      agentName: 'coder',
      definitionRevision: 1,
      principal: 'alice',
      input: 'go',
    });
    const result = await runtime.resolveRunServices({
      workflowId: 'recovered-coder-run',
      workflowType: 'agentRun',
      input: {
        runId: 'recovered-coder-run',
        sessionId: 'recovered-coder-run',
        agentName: 'coder',
      },
    });
    if (result.status !== 'available') throw new Error(`recovery was ${result.status}`);
    return (result as { services: DurableRunDeps }).services.options.generate;
  }

  const context = { step: 0 } as unknown as Parameters<GenerateFunction>[0];

  it('refuses its next step with a ModelPolicyDeniedError and calls no provider', async () => {
    const calls: string[] = [];
    const generate = await recovered(DENY_OPUS_5_5, calls);

    expect(await rejection(generate(context))).toBeInstanceOf(ModelPolicyDeniedError);
    expect(calls).toEqual([]);
  });

  it('takes its next step unchanged when the policy allows the model', async () => {
    const calls: string[] = [];
    const generate = await recovered(DENY_OPUS_5, calls);

    await generate(context);

    expect(calls).toEqual(['claude-opus-5-5']);
  });
});

describe('the run runtime of a catalog agent', () => {
  async function runtimeOf(modelPolicy: BureauModelPolicyOptions, calls: string[]) {
    const runtime = await createRuntimeComposition(
      { storage: new MemoryStorage(), generate: async () => ({ content: 'x', toolCalls: [] }) },
      { modelPolicy: source(modelPolicy) },
    );
    cleanups.push(() => runtime.durable?.engine[Symbol.dispose]?.());
    const runRuntime = await runtime.createRunRuntime(
      { agentName: 'coder', message: 'go', sessionId: 'coder-session', runId: 'coder-run' },
      {
        sessionAgent: {
          agentName: 'coder',
          options: {
            generate: fixedGenerate(OPUS_5_5, calls),
            toolbox: createToolbox([], { context: {} }),
            conversation: createConversationHistory({ id: 'coder-session' }),
          },
          definitionRevision: 1,
          agentResolvesGuardrails: false,
          generationMode: 'fixed',
          instructions: undefined,
        },
      },
    );
    return runRuntime.generate;
  }

  const context = { step: 0 } as unknown as Parameters<GenerateFunction>[0];

  it('refuses a step with a ModelPolicyDeniedError and calls no provider', async () => {
    const calls: string[] = [];
    const generate = await runtimeOf(DENY_OPUS_5_5, calls);

    expect(await rejection(generate(context))).toBeInstanceOf(ModelPolicyDeniedError);
    expect(calls).toEqual([]);
  });

  it('runs a step unchanged when the policy allows the model', async () => {
    const calls: string[] = [];
    const generate = await runtimeOf(DENY_OPUS_5, calls);

    await generate(context);

    expect(calls).toEqual(['claude-opus-5-5']);
  });
});

describe.each([
  ['a process-local child run', false],
  ['a durable workflow step', true],
])('%s of a code agent', (_name, durable) => {
  async function dispatch(modelPolicy: BureauModelPolicyOptions, calls: string[]) {
    const runtimeServices = createDefaultRuntimeServices();
    const runtime = await createRuntimeComposition(
      {
        storage: new MemoryStorage(),
        runtime: runtimeServices,
        ...(durable ? { durable: true } : {}),
      },
      { modelPolicy: source(modelPolicy) },
    );
    cleanups.push(() => runtime.durable?.engine[Symbol.dispose]?.());
    const coder = createAgent({ name: 'coder', generate: fixedGenerate(OPUS_5_5, calls) });
    const dispatcher = createCatalogDispatcher({
      agentCatalog: { find: (name: string) => (name === 'coder' ? coder : undefined) },
      runtime,
      runtimeServices,
      getShutdownPromise: () => undefined,
      catalogRuns: new Set(),
      runAttribution: new Map(),
      detachBestEffortPromise: () => {},
      createBureauError: (message, code) => Object.assign(new Error(message), { code }),
      validateAgentRunInput: () => {},
      onDurableRunAborted: () => {},
    });
    return durable
      ? dispatcher.startWorkflowStepRun({
          agentName: 'coder',
          input: 'work',
          runId: 'step-run-1',
          workflowStep: { workflowId: 'workflow-1', step: 0 },
          principal: 'alice',
        })
      : dispatcher.startChildRun({
          agentName: 'coder',
          input: 'work',
          childRunId: 'child-1',
          context: {
            childCorrelation: {
              parentAgentName: 'planner',
              parentRunId: 'parent-1',
              childAgentName: 'coder',
              childRunId: 'child-1',
            },
          },
          taskOrigin: { kind: 'agent', parentRunId: 'parent-1', agentName: 'planner' },
          principal: 'alice',
        });
  }

  it('ends in error naming the model, and never calls the provider, when the policy forbids it', async () => {
    const calls: string[] = [];
    const handle = await dispatch(DENY_OPUS_5_5, calls);

    const result = await handle.result();

    expect(result.finishReason).toBe('error');
    expect(result.error).toMatchObject({
      kind: 'policy',
      message: expect.stringContaining('anthropic/claude-opus-5-5'),
    });
    expect(calls).toEqual([]);
  });

  it('runs a model the policy allows unchanged', async () => {
    const calls: string[] = [];
    const handle = await dispatch(DENY_OPUS_5, calls);

    const result = await handle.result();

    expect(result.finishReason).not.toBe('error');
    expect(calls).toEqual(['claude-opus-5-5']);
  });
});

describe('a session of a selectable code agent steered to a model', () => {
  it('fails at its next step, before the provider is called, once the policy forbids that model', async () => {
    const stepped = createSteppedGenerate();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        picker: createAgent({
          name: 'picker',
          generate: stepped.generate,
          tools: { noop: noopTool },
          allowedCandidates: [
            { provider: 'anthropic', model: 'claude-opus-5-5' },
            { provider: 'anthropic', model: 'claude-opus-5' },
          ],
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });
    cleanups.push(() => bureau.dispose());
    const run = await startTaskFrom(bureau, {
      input: 'go',
      agentName: 'picker',
      principal: 'alice',
    });
    await stepped.firstStepEntered;
    const admitted = await bureau.contexts.steer(run.contextId, {
      id: 'to-opus-5',
      principal: 'alice',
      requestedValue: {
        target: 'model',
        override: 'claude-opus-5',
        provider: 'anthropic',
      } as never,
    });
    const { revision } = await bureau.settings.get();
    const tightened = await bureau.settings.update(
      { modelPolicy: DENY_OPUS_5 },
      { expectedRevision: revision },
    );
    stepped.releaseFirstStep();

    const detail = await waitForTaskState(bureau, run.id);

    expect(admitted.outcome).toBe('accepted');
    expect(tightened.outcome).toBe('applied');
    expect(detail.status).toBe('error');
    expect(detail.error).toContain(
      'forbidden by the bureau model policy (model denied: claude-opus-5)',
    );
    expect(stepped.observed).toHaveLength(1);
  });
});

describe('holding the run options of a catalog agent', () => {
  const generate: GenerateFunction = fixedGenerate(OPUS_5_5, []);
  const options = {
    generate,
    toolbox: createToolbox([], { context: {} }),
    maximumSteps: 3,
  };

  it('replaces only the generate and keeps every other option', async () => {
    const runtime = await createRuntimeComposition(
      { storage: new MemoryStorage() },
      { modelPolicy: source(DENY_OPUS_5) },
    );

    const held = runtime.holdToModelPolicy(options, 'fixed');

    expect(held.generate).not.toBe(generate);
    expect({ ...held, generate }).toEqual(options);
  });

  it('returns the options themselves when the composition reads no policy', async () => {
    const runtime = await createRuntimeComposition({ storage: new MemoryStorage() });

    expect(runtime.holdToModelPolicy(options, 'fixed')).toBe(options);
  });
});

describe('a session of a fixed code agent carrying a model steer', () => {
  it('refuses the agent its one row, and never calls its provider, whatever model the steer names', async () => {
    // A `policyRef` model steer is held to the policy at admission, not to what the session's agent
    // allows, so a fixed agent can carry one naming a model that is not its row, as a session
    // switched to a fixed agent from a selectable one carries what it was steered to. The provider
    // of a fixed agent is built for its row and ignores the steer, so the step runs that row.
    const calls: string[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: { coder: createAgent({ name: 'coder', generate: fixedGenerate(OPUS_5_5, calls) }) },
      storage: new MemoryStorage(),
      durable: true,
      modelPolicy: {
        ...DENY_OPUS_5_5,
        users: { cheaper: { exactOverride: { model: 'claude-opus-5' } } },
      },
    });
    cleanups.push(() => bureau.dispose());
    const contextId = 'steered-coder';
    await runCoder(bureau, contextId);
    const steered = await bureau.contexts.steer(contextId, {
      id: 'to-opus-5',
      principal: 'alice',
      requestedValue: { target: 'model', policyRef: 'cheaper' },
    });

    const second = await runCoder(bureau, contextId);

    expect(steered.outcome).toBe('accepted');
    expect(second?.status).toBe('error');
    expect(second?.error).toContain('anthropic/claude-opus-5-5');
    expect(calls).toEqual([]);
  });
});
