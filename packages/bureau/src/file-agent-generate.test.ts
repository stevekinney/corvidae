/**
 * COR-1559 — the generate a file agent runs with picks its model for every step from that step's
 * steering alone: no earlier step's override, no session lookup, and never the default when the
 * model it was told to use cannot be used.
 */
import {
  type BackendDescriptor,
  BudgetExceededError,
  createActiveRun,
  createModelCatalog,
  type GenerateContext,
  type GenerateFunction,
  noToolCalls,
  NonRecoverablePolicyError,
  readBackendDescriptors,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { createTestToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import {
  createFileAgentGenerate,
  EffortNotSupportedError,
  type FileAgentGenerateOptions,
  ModelOverrideUnusableError,
  ModelPolicyDeniedError,
} from './file-agent-generate';
import { modelPolicyDenialOf } from './model-policy';

const rows = createModelCatalog().descriptors;
const row = (provider: string, model: string): BackendDescriptor => {
  const found = rows.find(
    (candidate) => candidate.provider === provider && candidate.model === model,
  );
  if (found === undefined) throw new Error(`The catalog has no ${provider}/${model}.`);
  return found;
};

const DEFAULT = row('anthropic', 'claude-opus-5-5');
const OPUS_5 = row('anthropic', 'claude-opus-5');
const GPT = row('openai', 'gpt-4.1');

/** A step's context carrying only the steering a test names. */
function step(steering?: { model?: string; modelProvider?: string; provider?: string }) {
  return (steering === undefined
    ? {}
    : { steering: { paused: false, configVersion: 1, ...steering } }) as unknown as GenerateContext;
}

function harness(
  allowed: BackendDescriptor[],
  resolveFailsFor?: string,
  costBudgeted = false,
  policyDenial?: (row: BackendDescriptor) => ReturnType<typeof modelPolicyDenialOf>,
) {
  const used: string[] = [];
  const resolved: string[] = [];
  const generateFor =
    (descriptor: BackendDescriptor): GenerateFunction =>
    async () => {
      used.push(`${descriptor.provider}/${descriptor.model}`);
      return { content: descriptor.model, toolCalls: [] };
    };
  const generate = createFileAgentGenerate({
    defaultDescriptor: DEFAULT,
    defaultGenerate: withBackendDescriptors(generateFor(DEFAULT), [DEFAULT]),
    allowed: () => allowed,
    costBudgeted,
    ...(policyDenial === undefined ? {} : { policyDenial }),
    resolveGenerate: (descriptor) => {
      if (descriptor.model === resolveFailsFor) throw new Error('no credentials');
      resolved.push(descriptor.model);
      return generateFor(descriptor);
    },
  });
  return { generate, used, resolved };
}

describe('a file agent’s generate', () => {
  it('uses the default model when a step carries no model steering', async () => {
    const { generate, used } = harness([DEFAULT, OPUS_5]);

    await generate(step());
    await generate(step({ provider: 'openai' }));

    expect(used).toEqual(['anthropic/claude-opus-5-5', 'anthropic/claude-opus-5-5']);
  });

  it('uses the model each step’s own steering names, not an earlier or later step’s', async () => {
    const { generate, used } = harness([DEFAULT, OPUS_5, GPT]);

    await generate(step({ model: 'gpt-4.1', modelProvider: 'openai' }));
    await generate(step());
    await generate(step({ model: 'claude-opus-5' }));
    await generate(step({ model: 'gpt-4.1' }));

    expect(used).toEqual([
      'openai/gpt-4.1',
      'anthropic/claude-opus-5-5',
      'anthropic/claude-opus-5',
      'openai/gpt-4.1',
    ]);
  });

  it('matches the provider as well as the model when the steering names one', async () => {
    const twin: BackendDescriptor = { ...DEFAULT, provider: 'openai' };
    const { generate, used } = harness([DEFAULT, twin]);

    await generate(step({ model: 'claude-opus-5-5', modelProvider: 'openai' }));

    expect(used).toEqual(['openai/claude-opus-5-5']);
  });

  it('resolves a model’s generate once and reuses it', async () => {
    const { generate, resolved } = harness([DEFAULT, OPUS_5]);

    await generate(step({ model: 'claude-opus-5' }));
    await generate(step({ model: 'claude-opus-5' }));

    expect(resolved).toEqual(['claude-opus-5']);
  });

  it('does not resolve the default again when a step names it', async () => {
    const { generate, resolved, used } = harness([DEFAULT, OPUS_5]);

    await generate(step({ model: 'claude-opus-5-5', modelProvider: 'anthropic' }));

    expect(resolved).toEqual([]);
    expect(used).toEqual(['anthropic/claude-opus-5-5']);
  });

  it('fails with a typed error naming the model when it is no longer allowed, and calls nothing', async () => {
    const { generate, used } = harness([DEFAULT]);

    const failure = await generate(step({ model: 'gpt-4.1', modelProvider: 'openai' })).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ModelOverrideUnusableError);
    expect((failure as ModelOverrideUnusableError).model).toBe('gpt-4.1');
    expect((failure as ModelOverrideUnusableError).provider).toBe('openai');
    expect((failure as ModelOverrideUnusableError).message).toContain('gpt-4.1');
    expect(used).toEqual([]);
  });

  it('ends a budgeted run before asking an unpriced row that a provider-less switch to the default name reaches', async () => {
    // The probe: an unpriced twin ahead of the default serves the default's own model name, so the
    // run's name-keyed pricing counts the step at the default's rate while the twin runs it.
    const twin: BackendDescriptor = { ...DEFAULT, provider: 'twin', pricing: undefined };
    const { generate, used } = harness([twin, DEFAULT], undefined, true);

    const failure = await generate(step({ model: DEFAULT.model })).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect((failure as Error).message).toContain('"twin"');
    expect((failure as Error).message).toContain(DEFAULT.model);
    expect(used).toEqual([]);
  });

  it('runs the same unpriced row when the agent has no budget', async () => {
    const twin: BackendDescriptor = { ...DEFAULT, provider: 'twin', pricing: undefined };
    const { generate, used } = harness([twin, DEFAULT]);

    await generate(step({ model: DEFAULT.model }));

    expect(used).toEqual(['twin/claude-opus-5-5']);
  });

  it('fails with a typed error naming the model when the resolver now throws for it', async () => {
    const { generate, used } = harness([DEFAULT, OPUS_5], 'claude-opus-5');

    const failure = await generate(step({ model: 'claude-opus-5' })).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ModelOverrideUnusableError);
    expect((failure as ModelOverrideUnusableError).message).toContain('claude-opus-5');
    expect((failure as ModelOverrideUnusableError).cause).toBeInstanceOf(Error);
    expect(used).toEqual([]);
  });

  it('keeps the default model’s descriptors, so the agent reads as the one it was', () => {
    const { generate } = harness([DEFAULT]);

    expect(readBackendDescriptors(generate).map((descriptor) => descriptor.model)).toEqual([
      'claude-opus-5-5',
    ]);
  });
});

describe('a file agent’s generate under the model policy (COR-1980)', () => {
  const deny = (...models: string[]) => {
    const policy = { deployment: { deniedModels: models }, policyRevision: 7 };
    return (row: BackendDescriptor) => modelPolicyDenialOf(row, policy);
  };
  const failureOf = (work: Promise<unknown>) =>
    work.then(
      () => undefined,
      (error: unknown) => error,
    );

  it('fails a step on a forbidden default model with a typed error naming it, and calls nothing', async () => {
    const { generate, used } = harness([DEFAULT, OPUS_5], undefined, false, deny(DEFAULT.model));

    const failure = await failureOf(generate(step()));

    expect(failure).toBeInstanceOf(ModelPolicyDeniedError);
    const error = failure as ModelPolicyDeniedError;
    expect(error.code).toBe('model-policy-denied');
    expect(error.provider).toBe('anthropic');
    expect(error.model).toBe('claude-opus-5-5');
    expect(error.layer).toBe('deployment');
    expect(error.policyRevision).toBe(7);
    expect(error.message).toContain('anthropic/claude-opus-5-5');
    expect(used).toEqual([]);
  });

  it('fails a step switched to a forbidden model, and never falls back to the default', async () => {
    const { generate, used, resolved } = harness(
      [DEFAULT, OPUS_5],
      undefined,
      false,
      deny('claude-opus-5'),
    );

    const failure = await failureOf(generate(step({ model: 'claude-opus-5' })));

    expect(failure).toBeInstanceOf(ModelPolicyDeniedError);
    expect((failure as ModelPolicyDeniedError).model).toBe('claude-opus-5');
    expect(used).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it('fails a step that names the forbidden default by name', async () => {
    const { generate, used } = harness([DEFAULT, OPUS_5], undefined, false, deny(DEFAULT.model));

    const failure = await failureOf(generate(step({ model: DEFAULT.model })));

    expect(failure).toBeInstanceOf(ModelPolicyDeniedError);
    expect(used).toEqual([]);
  });

  it('lets a step switched to an allowed model run though the default is forbidden', async () => {
    const { generate, used } = harness([DEFAULT, OPUS_5], undefined, false, deny(DEFAULT.model));

    await generate(step({ model: 'claude-opus-5' }));

    expect(used).toEqual(['anthropic/claude-opus-5']);
  });

  it('reads the policy at every step, so a change applies from the next one', async () => {
    let denied: string[] = [];
    const { generate, used } = harness([DEFAULT, OPUS_5], undefined, false, (row) =>
      deny(...denied)(row),
    );

    await generate(step());
    denied = [DEFAULT.model];
    const failure = await failureOf(generate(step()));
    denied = [];
    await generate(step());

    expect(failure).toBeInstanceOf(ModelPolicyDeniedError);
    expect(used).toEqual(['anthropic/claude-opus-5-5', 'anthropic/claude-opus-5-5']);
  });

  it('judges a forbidden model before the cost budget does', async () => {
    const twin: BackendDescriptor = { ...DEFAULT, provider: 'twin', pricing: undefined };
    const { generate } = harness([twin, DEFAULT], undefined, true, deny(DEFAULT.model));

    const failure = await failureOf(generate(step({ model: DEFAULT.model })));

    expect(failure).toBeInstanceOf(ModelPolicyDeniedError);
  });
});

describe('a file agent’s default effort (COR-1961)', () => {
  const THREE_TIERS = row('anthropic', 'claude-opus-4-5');
  const failureOf = (work: Promise<unknown>) =>
    work.then(
      () => undefined,
      (error: unknown) => error,
    );

  /** What one call was handed: the model it ran on and the context it received. */
  interface Call {
    readonly model: string;
    readonly effort: string | undefined;
    readonly context: GenerateContext;
  }

  function effortHarness(
    allowed: BackendDescriptor[],
    options: Pick<FileAgentGenerateOptions, 'defaultEffort' | 'effortFallbackMode'>,
  ) {
    const calls: Call[] = [];
    const generateFor =
      (descriptor: BackendDescriptor): GenerateFunction =>
      async (context) => {
        calls.push({ model: descriptor.model, effort: context.steering?.effort, context });
        return { content: descriptor.model, toolCalls: [] };
      };
    const generate = createFileAgentGenerate({
      defaultDescriptor: DEFAULT,
      defaultGenerate: withBackendDescriptors(generateFor(DEFAULT), [DEFAULT]),
      allowed: () => allowed,
      resolveGenerate: generateFor,
      ...options,
    });
    return { generate, calls };
  }

  /** A step's context for a run, steered as named. */
  function stepOf(
    steering?: { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' },
    runId = 'run-1',
  ) {
    return {
      runId,
      ...(steering === undefined
        ? {}
        : { steering: { paused: false, configVersion: 3, ...steering } }),
    } as unknown as GenerateContext;
  }

  it('sends the default to a model that takes it unchanged', async () => {
    const { generate, calls } = effortHarness([DEFAULT], { defaultEffort: 'high' });

    await generate(stepOf());

    expect(calls.map((call) => call.effort)).toEqual(['high']);
  });

  it('sends it in a copy, so the session’s steering is not written and the original is untouched', async () => {
    const { generate, calls } = effortHarness([DEFAULT], { defaultEffort: 'high' });
    const context = stepOf({ model: DEFAULT.model });
    const before = structuredClone(context.steering);

    await generate(context);

    expect(context.steering).toEqual(before);
    expect(calls[0]?.context).not.toBe(context);
    expect(calls[0]?.context.steering).toMatchObject({ paused: false, configVersion: 3 });
  });

  it('gives a step with no steering at all a steering that holds only the default', async () => {
    const { generate, calls } = effortHarness([DEFAULT], { defaultEffort: 'low' });

    await generate(stepOf());

    expect(calls[0]?.context.steering).toEqual({ paused: false, configVersion: 0, effort: 'low' });
  });

  it('lets the effort a person steered to win over the default', async () => {
    const { generate, calls } = effortHarness([DEFAULT], { defaultEffort: 'high' });

    await generate(stepOf({ effort: 'low' }));

    expect(calls.map((call) => call.effort)).toEqual(['low']);
  });

  it('passes the very same context through when the file has no default', async () => {
    const { generate, calls } = effortHarness([DEFAULT, THREE_TIERS], {});
    const plain = stepOf();
    const steered = stepOf({ effort: 'max' });
    const switched = stepOf({ model: THREE_TIERS.model });

    await generate(plain);
    await generate(steered);
    await generate(switched);

    expect(calls.map((call) => call.context)).toEqual([plain, steered, switched]);
    expect(calls[0]?.context).toBe(plain);
    expect(calls[1]?.context).toBe(steered);
    expect(calls[2]?.context).toBe(switched);
  });

  it('re-checks the default against a model the session was switched to, and sends it when that model takes it', async () => {
    const { generate, calls } = effortHarness([DEFAULT, THREE_TIERS], { defaultEffort: 'medium' });

    await generate(stepOf({ model: THREE_TIERS.model }));

    expect(calls.map((call) => [call.model, call.effort])).toEqual([[THREE_TIERS.model, 'medium']]);
  });

  describe('on a model that cannot do the default', () => {
    const modeOf = (mode: 'reject' | 'degrade') => {
      const asked: Array<string | undefined> = [];
      return {
        asked,
        effortFallbackMode: async (runId: string | undefined) => {
          asked.push(runId);
          return mode;
        },
      };
    };

    it('fails the step under reject with a typed error naming the model and the effort, and calls nothing', async () => {
      const mode = modeOf('reject');
      const { generate, calls } = effortHarness([DEFAULT, THREE_TIERS], {
        defaultEffort: 'max',
        effortFallbackMode: mode.effortFallbackMode,
      });

      const failure = await failureOf(generate(stepOf({ model: THREE_TIERS.model })));

      expect(failure).toBeInstanceOf(EffortNotSupportedError);
      const error = failure as EffortNotSupportedError;
      expect(error.code).toBe('effort-not-supported');
      expect(error.provider).toBe('anthropic');
      expect(error.model).toBe(THREE_TIERS.model);
      expect(error.effort).toBe('max');
      expect(error.message).toContain('anthropic/claude-opus-4-5');
      expect(calls).toEqual([]);
      expect(mode.asked).toEqual(['run-1']);
    });

    it('is a policy verdict a retry never repeats', async () => {
      const { generate } = effortHarness([DEFAULT, THREE_TIERS], { defaultEffort: 'max' });

      const failure = await failureOf(generate(stepOf({ model: THREE_TIERS.model })));

      expect(failure).toBeInstanceOf(NonRecoverablePolicyError);
    });

    it('ends a run with the error and asks once, though the run retries every failure', async () => {
      const asked: Array<string | undefined> = [];
      const generate = createFileAgentGenerate({
        defaultDescriptor: THREE_TIERS,
        defaultGenerate: async () => ({ content: 'unreachable', toolCalls: [] }),
        allowed: () => [THREE_TIERS],
        resolveGenerate: () => async () => ({ content: 'unreachable', toolCalls: [] }),
        defaultEffort: 'max',
        effortFallbackMode: async (runId) => {
          asked.push(runId);
          return 'reject';
        },
      });

      const result = await createActiveRun({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runId: 'run-9',
        retry: { attempts: 3, delay: 0, shouldRetry: () => true },
      }).result;

      expect(result.finishReason).toBe('error');
      expect((result.error as { cause?: unknown }).cause).toBeInstanceOf(EffortNotSupportedError);
      expect(asked).toEqual(['run-9']);
    });

    it('rejects when no fallback mode is supplied or the step has no run', async () => {
      const bare = effortHarness([DEFAULT, THREE_TIERS], { defaultEffort: 'max' });
      expect(await failureOf(bare.generate(stepOf({ model: THREE_TIERS.model })))).toBeInstanceOf(
        EffortNotSupportedError,
      );

      const asked: Array<string | undefined> = [];
      const runless = effortHarness([DEFAULT, THREE_TIERS], {
        defaultEffort: 'max',
        effortFallbackMode: async (runId) => {
          asked.push(runId);
          return runId === undefined ? 'reject' : 'degrade';
        },
      });
      const context = { steering: { paused: false, configVersion: 1, model: THREE_TIERS.model } };
      expect(
        await failureOf(runless.generate(context as unknown as GenerateContext)),
      ).toBeInstanceOf(EffortNotSupportedError);
      expect(asked).toEqual([undefined]);
    });

    it('sends the tier the model degrades it to under degrade', async () => {
      const mode = modeOf('degrade');
      const { generate, calls } = effortHarness([DEFAULT, THREE_TIERS], {
        defaultEffort: 'max',
        effortFallbackMode: mode.effortFallbackMode,
      });

      await generate(stepOf({ model: THREE_TIERS.model }));

      expect(calls.map((call) => [call.model, call.effort])).toEqual([[THREE_TIERS.model, 'high']]);
    });

    it('sends no effort under degrade when the model supports none, and the context is the caller’s own', async () => {
      const mode = modeOf('degrade');
      const { generate, calls } = effortHarness([DEFAULT, GPT], {
        defaultEffort: 'high',
        effortFallbackMode: mode.effortFallbackMode,
      });
      const context = stepOf({ model: GPT.model });

      await generate(context);

      expect(calls.map((call) => [call.model, call.effort])).toEqual([[GPT.model, undefined]]);
      expect(calls[0]?.context).toBe(context);
    });

    it('rejects a model with no effort support under reject', async () => {
      const mode = modeOf('reject');
      const { generate, calls } = effortHarness([DEFAULT, GPT], {
        defaultEffort: 'low',
        effortFallbackMode: mode.effortFallbackMode,
      });

      expect(await failureOf(generate(stepOf({ model: GPT.model })))).toBeInstanceOf(
        EffortNotSupportedError,
      );
      expect(calls).toEqual([]);
    });

    it('does not ask the mode, or refuse, when the person steered an effort', async () => {
      const mode = modeOf('reject');
      const { generate, calls } = effortHarness([DEFAULT, GPT], {
        defaultEffort: 'low',
        effortFallbackMode: mode.effortFallbackMode,
      });

      await generate(stepOf({ model: GPT.model, effort: 'high' }));

      expect(calls.map((call) => call.effort)).toEqual(['high']);
      expect(mode.asked).toEqual([]);
    });

    it('does not ask the mode when the model takes the default', async () => {
      const mode = modeOf('reject');
      const { generate } = effortHarness([DEFAULT], {
        defaultEffort: 'low',
        effortFallbackMode: mode.effortFallbackMode,
      });

      await generate(stepOf());

      expect(mode.asked).toEqual([]);
    });
  });

  it('judges the model policy before the effort', async () => {
    const policy = { deployment: { deniedModels: [GPT.model] }, policyRevision: 2 };
    const { generate } = effortHarness([DEFAULT, GPT], {
      defaultEffort: 'low',
    });
    const guarded = createFileAgentGenerate({
      defaultDescriptor: DEFAULT,
      defaultGenerate: generate,
      allowed: () => [DEFAULT, GPT],
      resolveGenerate: () => generate,
      defaultEffort: 'low',
      policyDenial: (candidate) => modelPolicyDenialOf(candidate, policy),
    });

    expect(await failureOf(guarded(stepOf({ model: GPT.model })))).toBeInstanceOf(
      ModelPolicyDeniedError,
    );
  });
});
