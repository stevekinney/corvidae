/**
 * COR-1810 — why a generation ran on the model it did: one test per branch of the reason's decision
 * order, the rejected list, and the step-level overrides (steering, provider divergence).
 */
import { describe, expect, it } from 'bun:test';

import type { SteeringDesiredState } from '../durable/types.ts';
import { type BackendDescriptor, createModelCatalog, type ModelCatalog } from './model-catalog.ts';
import {
  derivePlanReason,
  MAXIMUM_PLAN_REJECTIONS,
  planReasonForStep,
  rejectionCodeOf,
} from './plan-reason.ts';
import {
  recordEffectiveGeneration,
  select,
  type SelectionCandidate,
  type SelectionRequest,
  type SelectOptions,
} from './selection.ts';

const FIXED_NOW = '2026-09-02T12:00:00.000Z';
const SEED = createModelCatalog({ now: () => FIXED_NOW });

function descriptor(provider: string, model: string): BackendDescriptor {
  const found = SEED.descriptors.find((row) => row.provider === provider && row.model === model);
  if (found === undefined) throw new Error(`fixture descriptor not found: ${provider}/${model}`);
  return found;
}

const anthropic = descriptor('anthropic', 'claude-fable-5');
const openai = descriptor('openai', 'gpt-4o');
const gemini = descriptor('gemini', 'gemini-2.5-pro');

const priced = (model: string, price: number): BackendDescriptor => ({
  ...anthropic,
  model,
  pricing: { inputPerMillionTokens: price, outputPerMillionTokens: price, currency: 'USD' },
});

function catalogOf(descriptors: readonly BackendDescriptor[]): ModelCatalog {
  return {
    revision: 1,
    descriptors,
    generatedAt: FIXED_NOW,
    stale: false,
    projection: 'privileged',
  };
}

const request = (overrides: Partial<SelectionRequest> = {}): SelectionRequest => ({
  agentName: 'test-agent',
  catalogRevision: 1,
  policyRevision: 1,
  availabilitySnapshotRevision: 1,
  ...overrides,
});

const options = (descriptors: readonly BackendDescriptor[], more: Partial<SelectOptions> = {}) =>
  ({
    catalog: catalogOf(descriptors),
    now: () => FIXED_NOW,
    newPlanId: () => 'plan-1',
    ...more,
  }) satisfies SelectOptions;

describe('the plan reason of a selection', () => {
  it('is pinned when a requested model override chose the model', () => {
    const plan = select(
      request({ requestedValue: { target: 'model', override: 'gpt-4o' } }),
      options([anthropic, openai], { user: { exactOverride: { provider: 'openai' } } }),
    );

    expect(plan.reason).toMatchObject({ code: 'pinned', rejected: [] });
    expect(plan.reason?.detail).toContain('openai/gpt-4o');
  });

  it('is pinned when the user’s standing exact override chose the model', () => {
    const plan = select(
      request(),
      options([anthropic, openai], {
        user: { exactOverride: { provider: 'openai', model: 'gpt-4o' } },
      }),
    );

    expect(plan.reason?.code).toBe('pinned');
  });

  it('is capability when the only eligible model is what a missing capability left', () => {
    const plan = select(
      request({
        inputMedia: [{ modality: 'audio', sourceForm: 'inline', count: 1 }],
      }),
      options([anthropic, openai, gemini]),
    );

    expect(plan.selected?.provider).toBe('gemini');
    expect(plan.reason?.code).toBe('capability');
    expect(plan.reason?.rejected).toEqual([
      { provider: 'anthropic', model: 'claude-fable-5', code: 'capability' },
      { provider: 'openai', model: 'gpt-4o', code: 'capability' },
    ]);
    expect(plan.reason?.detail).toContain('incompatible-modality');
  });

  it('is policy when the only eligible model is what the layered policy left', () => {
    const plan = select(
      request(),
      options([anthropic, openai], { deployment: { deniedModels: ['gpt-4o'] } }),
    );

    expect(plan.reason?.code).toBe('policy');
    expect(plan.reason?.rejected).toEqual([
      { provider: 'openai', model: 'gpt-4o', code: 'policy' },
    ]);
  });

  it('is policy for the only model the catalog offers', () => {
    const plan = select(request(), options([anthropic]));

    expect(plan.reason).toMatchObject({ code: 'policy', rejected: [] });
  });

  it('is fallback when the other models were unavailable', () => {
    const plan = select(
      request(),
      options([anthropic, { ...openai, availability: 'unavailable' }]),
    );

    expect(plan.selected?.provider).toBe('anthropic');
    expect(plan.reason).toMatchObject({
      code: 'fallback',
      rejected: [{ provider: 'openai', model: 'gpt-4o', code: 'fallback' }],
    });
  });

  it('maps every availability exclusion to fallback and every denial to policy', () => {
    for (const code of ['unavailable', 'unhealthy', 'stale-catalog'] as const) {
      expect([code, rejectionCodeOf(code)]).toEqual([code, 'fallback']);
    }
    for (const code of [
      'denied-by-deployment',
      'denied-by-bureau',
      'denied-by-user',
      'exceeds-delegated-authority',
    ] as const) {
      expect([code, rejectionCodeOf(code)]).toEqual([code, 'policy']);
    }
  });

  it('is cost when a cost preference put the cheaper of two eligible models first', () => {
    const plan = select(
      request(),
      options([priced('expensive', 100), priced('cheap', 1)], {
        user: { costPreference: 'lowest-cost' },
      }),
    );

    expect(plan.selected?.model).toBe('cheap');
    expect(plan.reason?.code).toBe('cost');
    expect(plan.reason?.detail).toContain('anthropic/cheap');
    expect(plan.reason?.detail).toContain('anthropic/expensive');
  });

  it('is policy, not cost, when two eligible models rank on the agent’s preferences alone', () => {
    const plan = select(
      request(),
      options([priced('expensive', 100), priced('cheap', 1)], {
        agent: { preferredModels: ['expensive'] },
      }),
    );

    expect(plan.selected?.model).toBe('expensive');
    expect(plan.reason?.code).toBe('policy');
  });

  it('is policy when a cost preference has nothing to separate the models on', () => {
    const plan = select(
      request(),
      options([priced('a', 5), priced('b', 5)], { user: { costPreference: 'lowest-cost' } }),
    );

    expect(plan.reason?.code).toBe('policy');
  });

  it('carries no reason on a plan that selected nothing', () => {
    const plan = select(request(), options([]));

    expect(plan.outcome).toBe('no-candidate');
    expect(plan.reason).toBeUndefined();
  });

  it('is latency when a latency preference gave the winner the larger advantage', () => {
    const candidate = (model: string, cost: number, latency: number): SelectionCandidate => ({
      provider: 'anthropic',
      model,
      descriptorSnapshot: anthropic,
      eligible: true,
      rankingInputs: { cost, latency, preferenceMatch: 0 },
    });

    const reason = derivePlanReason({
      ranked: [candidate('fast', 0.2, 1), candidate('slow', 0.1, 0)],
      rejected: [],
      pinned: false,
      costPreference: 'balanced',
      latencyPreference: 'lowest-latency',
    });

    expect(reason.code).toBe('latency');
  });

  it('lists at most the cap of rejected models and says how many it passed over', () => {
    const many = Array.from({ length: MAXIMUM_PLAN_REJECTIONS + 7 }, (_, index) =>
      priced(`denied-${index}`, 1),
    );
    const plan = select(
      request(),
      options([anthropic, ...many], {
        deployment: { deniedModels: many.map((row) => row.model) },
      }),
    );

    expect(plan.reason?.rejected).toHaveLength(MAXIMUM_PLAN_REJECTIONS);
    expect(plan.reason?.detail).toContain(`${MAXIMUM_PLAN_REJECTIONS + 7} models were passed over`);
  });
});

describe('the plan reason of a step', () => {
  const steering = (more: Partial<SteeringDesiredState>): SteeringDesiredState => ({
    paused: false,
    configVersion: 3,
    ...more,
  });

  it('is the plan’s own reason when nothing overrides it', () => {
    const plan = select(request(), options([anthropic]));

    expect(planReasonForStep(plan, undefined)).toBe(plan.reason);
    expect(planReasonForStep(plan, steering({ paused: false }))).toBe(plan.reason);
  });

  it('is pinned when steering named a model the plan did not choose', () => {
    const plan = select(request(), options([anthropic, openai]));

    const reason = planReasonForStep(plan, steering({ model: 'gpt-4o', modelProvider: 'openai' }));

    expect(reason?.code).toBe('pinned');
    expect(reason?.detail).toContain('gpt-4o');
    expect(reason?.rejected).toEqual(plan.reason?.rejected ?? []);
  });

  it('is pinned for a steered run that has no plan at all', () => {
    expect(planReasonForStep(undefined, steering({ model: 'gpt-4o' }))?.code).toBe('pinned');
  });

  it('is fallback when the provider answered with a model other than the planned one', () => {
    const plan = select(request(), options([anthropic, openai]));
    const diverged = recordEffectiveGeneration(plan, {
      planId: plan.planId,
      provider: 'openai',
      model: 'gpt-4o',
      divergedFromPlan: true,
    });

    expect(diverged.outcome).toBe('provider-effective-divergence');
    expect(planReasonForStep(diverged, undefined)?.code).toBe('fallback');
  });

  it('is absent when the run has no plan and no steering override', () => {
    expect(planReasonForStep(undefined, undefined)).toBeUndefined();
  });
});
