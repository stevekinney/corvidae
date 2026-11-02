/**
 * COR-1996 — the model policy binds the generate of a plugin code agent. A code agent is opaque to
 * Bureau except for the catalog rows its generate reports and the model a step is steered to, so a
 * step is refused only when every row it could use is forbidden: the one row of a fixed agent, or
 * the rows a steered model names. The refusal is a `ModelPolicyDeniedError` raised before the
 * provider is called, and the policy is read at every step.
 */
import {
  type BackendDescriptor,
  createModelCatalog,
  type GenerateContext,
  type GenerateFunction,
  type GenerationMode,
  NonRecoverablePolicyError,
  readBackendDescriptors,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { holdGenerateToModelPolicy } from './code-agent-model-policy';
import { ModelPolicyDeniedError } from './file-agent-generate';
import type { BureauModelPolicyOptions } from './model-policy';

const rows = createModelCatalog().descriptors;
const row = (provider: string, model: string): BackendDescriptor => {
  const found = rows.find(
    (candidate) => candidate.provider === provider && candidate.model === model,
  );
  if (found === undefined) throw new Error(`The catalog has no ${provider}/${model}.`);
  return found;
};

const OPUS_5_5 = row('anthropic', 'claude-opus-5-5');
const OPUS_5 = row('anthropic', 'claude-opus-5');
/** OpenAI serving a model named like Anthropic's, so two providers share one model name. */
const TWIN_OF_OPUS_5_5: BackendDescriptor = { ...OPUS_5_5, provider: 'openai' };

const DENY_OPUS_5_5: BureauModelPolicyOptions = {
  deployment: { deniedModels: ['claude-opus-5-5'] },
  policyRevision: 4,
};
const DENY_OPUS_5: BureauModelPolicyOptions = {
  bureau: { deniedModels: ['claude-opus-5'] },
  policyRevision: 5,
};
const DENY_BOTH: BureauModelPolicyOptions = {
  deployment: { deniedModels: ['claude-opus-5-5', 'claude-opus-5'] },
  policyRevision: 6,
};
const DENY_OPENAI: BureauModelPolicyOptions = {
  deployment: { deniedProviders: ['openai'] },
  policyRevision: 8,
};
const ALLOW_ALL: BureauModelPolicyOptions = { policyRevision: 7 };

/** A step's context carrying only the steering a test names. */
function step(steering?: { model?: string; modelProvider?: string }): GenerateContext {
  return (steering === undefined
    ? {}
    : { steering: { paused: false, configVersion: 1, ...steering } }) as unknown as GenerateContext;
}

/** A generate that reports `descriptors` and records the model each call is steered to. */
function recorder(descriptors: readonly BackendDescriptor[]) {
  const calls: Array<string | undefined> = [];
  const generate: GenerateFunction = async (context) => {
    calls.push(context.steering?.model);
    return { content: 'ok', toolCalls: [] };
  };
  return { generate: withBackendDescriptors(generate, descriptors), calls };
}

/**
 * `generate` held to `policy`, read afresh at every step, over `catalog`, as the agent of `mode`:
 * a selectable agent unless a test says otherwise.
 */
function hold(
  generate: GenerateFunction,
  policy: () => BureauModelPolicyOptions | undefined,
  catalog: readonly BackendDescriptor[] = [...rows, TWIN_OF_OPUS_5_5],
  mode: GenerationMode = 'selectable',
): GenerateFunction {
  return holdGenerateToModelPolicy(generate, { current: policy, catalog: () => catalog }, mode);
}

/** `generate` held to `policy` as a fixed agent, over the default catalog. */
function holdFixed(
  generate: GenerateFunction,
  policy: () => BureauModelPolicyOptions | undefined,
): GenerateFunction {
  return hold(generate, policy, undefined, 'fixed');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('a code agent whose generate reports one catalog row', () => {
  it('refuses a step with a ModelPolicyDeniedError naming the row and calls no provider', async () => {
    const { generate, calls } = recorder([OPUS_5_5]);
    const held = holdFixed(generate, () => DENY_OPUS_5_5);

    const failure = await rejection(held(step()));

    expect(failure).toBeInstanceOf(ModelPolicyDeniedError);
    expect(failure).toBeInstanceOf(NonRecoverablePolicyError);
    expect(failure).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      layer: 'deployment',
      policyRevision: 4,
    });
    expect(calls).toEqual([]);
  });

  it('runs a row the policy allows exactly as it ran', async () => {
    const { generate, calls } = recorder([OPUS_5_5]);
    const held = holdFixed(generate, () => DENY_OPUS_5);

    expect(await held(step())).toEqual({ content: 'ok', toolCalls: [] });
    expect(calls).toEqual([undefined]);
  });

  it('reads the policy at every step, so a change applies from the next one', async () => {
    const { generate, calls } = recorder([OPUS_5_5]);
    let policy: BureauModelPolicyOptions | undefined = ALLOW_ALL;
    const held = holdFixed(generate, () => policy);

    await held(step());
    policy = DENY_OPUS_5_5;
    const during = await rejection(held(step()));
    policy = undefined;
    await held(step());

    expect(during).toBeInstanceOf(ModelPolicyDeniedError);
    expect(calls).toHaveLength(2);
  });

  it('keeps the descriptors its generate reports', () => {
    const { generate } = recorder([OPUS_5_5]);

    expect(readBackendDescriptors(holdFixed(generate, () => DENY_OPUS_5_5))).toEqual([OPUS_5_5]);
  });

  it('judges a bare steer to a name two providers share by the row the agent itself reports', async () => {
    const { generate, calls } = recorder([TWIN_OF_OPUS_5_5]);
    const held = holdFixed(generate, () => DENY_OPENAI);

    const failure = await rejection(held(step({ model: 'claude-opus-5-5' })));

    expect(failure).toMatchObject({ provider: 'openai', model: 'claude-opus-5-5' });
    expect(calls).toEqual([]);
  });
});

describe('a code agent whose generate reports several catalog rows', () => {
  it('is not judged unsteered, because Bureau cannot tell which row its router picks', async () => {
    const { generate, calls } = recorder([OPUS_5_5, OPUS_5]);
    const held = hold(generate, () => DENY_BOTH);

    await held(step());

    expect(calls).toEqual([undefined]);
  });

  it('refuses a step steered to a forbidden row, and runs one steered to an allowed row', async () => {
    const { generate, calls } = recorder([OPUS_5_5, OPUS_5]);
    const held = hold(generate, () => DENY_OPUS_5_5);

    const refused = await rejection(held(step({ model: 'claude-opus-5-5' })));
    await held(step({ model: 'claude-opus-5' }));

    expect(refused).toMatchObject({ model: 'claude-opus-5-5' });
    expect(calls).toEqual(['claude-opus-5']);
  });
});

describe('a steered model that the generate does not report', () => {
  it('is judged by the catalog rows of that name', async () => {
    const { generate, calls } = recorder([OPUS_5]);
    const held = hold(generate, () => DENY_OPUS_5_5);

    const refused = await rejection(
      held(step({ model: 'claude-opus-5-5', modelProvider: 'anthropic' })),
    );
    await held(step({ model: 'gpt-4.1' }));

    expect(refused).toBeInstanceOf(ModelPolicyDeniedError);
    expect(calls).toEqual(['gpt-4.1']);
  });

  it('is admitted when the catalog has an allowed row of that name, as steering admission admits it', async () => {
    const { generate, calls } = recorder([OPUS_5]);
    const held = hold(generate, () => DENY_OPENAI);

    await held(step({ model: 'claude-opus-5-5' }));

    expect(calls).toEqual(['claude-opus-5-5']);
  });

  it('is not judged when no row has that name, which its own generate reports', async () => {
    const { generate, calls } = recorder([OPUS_5_5]);
    const held = hold(generate, () => DENY_OPUS_5_5, []);

    await held(step({ model: 'retired-model' }));

    expect(calls).toEqual(['retired-model']);
  });

  it('runs a selectable agent steered to an allowed model though a row it reports is forbidden', async () => {
    const { generate, calls } = recorder([OPUS_5_5]);
    const held = hold(generate, () => DENY_OPUS_5_5);

    await held(step({ model: 'claude-opus-5' }));

    expect(calls).toEqual(['claude-opus-5']);
  });
});

describe('a fixed agent carrying a model steer', () => {
  it('judges the one row it reports and ignores the steered model, which its provider ignores too', async () => {
    const { generate, calls } = recorder([OPUS_5_5]);
    const held = holdFixed(generate, () => DENY_OPUS_5_5);

    const failure = await rejection(held(step({ model: 'claude-opus-5' })));

    expect(failure).toBeInstanceOf(ModelPolicyDeniedError);
    expect(failure).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(calls).toEqual([]);
  });

  it('runs when the one row it reports is allowed, whatever model the steer names', async () => {
    const { generate, calls } = recorder([OPUS_5_5]);
    const held = holdFixed(generate, () => DENY_OPUS_5);

    await held(step({ model: 'claude-opus-5' }));

    expect(calls).toEqual(['claude-opus-5']);
  });
});

describe('a code agent whose generate reports no catalog row', () => {
  it('cannot be judged unsteered, so its steps run whatever the policy forbids', async () => {
    const { generate, calls } = recorder([]);
    const held = hold(generate, () => DENY_BOTH);

    await held(step());

    expect(calls).toEqual([undefined]);
  });

  it('is judged by the catalog rows of the model a step is steered to', async () => {
    const { generate, calls } = recorder([]);
    const held = hold(generate, () => DENY_OPUS_5_5);

    const refused = await rejection(held(step({ model: 'claude-opus-5-5' })));
    await held(step({ model: 'claude-opus-5' }));

    expect(refused).toMatchObject({ model: 'claude-opus-5-5', layer: 'deployment' });
    expect(calls).toEqual(['claude-opus-5']);
  });
});
