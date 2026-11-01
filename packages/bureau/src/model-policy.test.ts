/**
 * Bureau's model policy configuration and selection-planning surface
 * (AB-64's decision record; AB-250/mod-03c).
 *
 * `createModelPolicyPlanner` is tested directly against `createModels`'s
 * catalog and plain `createAgent` fixtures — no full `createBureau()`
 * instance is needed for this module's own behavior, matching
 * `agent-catalog.test.ts`'s own conventions. `create-bureau.test.ts` covers
 * the `selectorAvailable: true` wiring and `bureau.models.plan` surface.
 *
 * No sleeps, no timers, no network — every timestamp and plan id is
 * injected.
 */
import {
  createAgent,
  createMockGenerate,
  createModelCatalog,
  type ProviderName,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import {
  createModelPolicyPlanner,
  modelPolicyDenialOf,
  type PlanSelectionRequest,
} from './model-policy';
import { createModels, type Models } from './models/create-models';

const FIXED_NOW = '2026-09-03T12:00:00.000Z';
const now = () => FIXED_NOW;
let planIdCounter = 0;
function freshNewPlanId(): () => string {
  planIdCounter = 0;
  return () => `bureau-plan-${String(planIdCounter++).padStart(4, '0')}`;
}

const SEED_CATALOG = createModelCatalog({ now: () => FIXED_NOW });

function requireDescriptor(provider: string) {
  const descriptor = SEED_CATALOG.descriptors.find((row) => row.provider === provider);
  if (!descriptor) throw new Error(`expected at least one seed descriptor for ${provider}`);
  return descriptor;
}

const anthropicDescriptor = requireDescriptor('anthropic');
const geminiDescriptor = requireDescriptor('gemini');

function fixedAgent(name: string) {
  return createAgent({
    generate: withBackendDescriptors(createMockGenerate([]), [anthropicDescriptor]),
    name,
  });
}

function selectableAgent(
  name: string,
  allowedCandidates: readonly { provider: ProviderName; model: string }[] = [
    { provider: geminiDescriptor.provider, model: geminiDescriptor.model },
  ],
) {
  return createAgent({ generate: createMockGenerate([]), name, allowedCandidates });
}

/** A catalog over `SEED_CATALOG`'s rows that `plan`/`createSelectionGateFor` only ever read. */
function makeModels(): Models {
  return createModels({
    options: { catalog: SEED_CATALOG.descriptors },
    now,
    notConfigured: () => new Error('no generate'),
    badRequest: (message) => {
      throw new Error(message);
    },
    onReplace: () => {},
    agents: {},
    modelPolicy: undefined,
  });
}

describe('createModelPolicyPlanner: plan is side-effect-free', () => {
  it('leaves the catalog object itself untouched', () => {
    const models = makeModels();
    const before = models.catalog();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      models,
      now,
      newPlanId: freshNewPlanId(),
    });

    planner.plan({ agentName: 'fixed' });
    planner.createSelectionGateFor({ agentName: 'fixed' });

    expect(models.catalog()).toBe(before);
  });

  it('does not change the catalog revision', () => {
    const service = makeModels();
    const revisionBefore = service.catalog().revision;

    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      models: service,
      now,
      newPlanId: freshNewPlanId(),
    });
    planner.plan({ agentName: 'fixed' });
    planner.plan({ agentName: 'fixed' });

    expect(service.catalog().revision).toBe(revisionBefore);
  });

  it('starts no run and dispatches no event — returns synchronously, not a Promise', () => {
    const service = makeModels();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      models: service,
      now,
      newPlanId: freshNewPlanId(),
    });

    const plan = planner.plan({ agentName: 'fixed' });

    expect(plan).not.toBeInstanceOf(Promise);
    expect(plan.outcome).toBe('selected');
  });
});

describe('createModelPolicyPlanner: plan', () => {
  it('yields a one-candidate selected plan for a fixed Agent', () => {
    const service = makeModels();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      models: service,
      now,
      newPlanId: freshNewPlanId(),
    });

    const plan = planner.plan({ agentName: 'fixed' });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.selected).toEqual({
      provider: anthropicDescriptor.provider,
      model: anthropicDescriptor.model,
    });
  });

  it('narrows candidates to a selectable Agent’s own allowedCandidates', () => {
    const service = makeModels();
    const planner = createModelPolicyPlanner({
      agents: {
        selectable: selectableAgent('selectable', [
          { provider: geminiDescriptor.provider, model: geminiDescriptor.model },
        ]),
      } satisfies AgentDefinitions,
      models: service,
      now,
      newPlanId: freshNewPlanId(),
    });

    const plan = planner.plan({ agentName: 'selectable' });

    expect(plan.candidates.every((candidate) => candidate.provider === 'gemini')).toBe(true);
    expect(plan.selected?.provider).toBe('gemini');
    expect(plan.selected?.model).toBe(geminiDescriptor.model);
  });

  it('applies the per-principal UserModelConfiguration selected by request.principal', () => {
    const service = makeModels();
    const planner = createModelPolicyPlanner({
      agents: {
        selectable: selectableAgent('selectable', [
          { provider: geminiDescriptor.provider, model: geminiDescriptor.model },
          { provider: anthropicDescriptor.provider, model: anthropicDescriptor.model },
        ]),
      } satisfies AgentDefinitions,
      models: service,
      modelPolicy: {
        policyRevision: 1,
        users: {
          // With no preference set, both candidates tie at the same rank
          // score and `select` breaks the tie lexicographically by
          // `(provider, model)` — 'anthropic' sorts before 'gemini', so
          // that's the default winner. Denying it forces the switch, which
          // is the observable proof `principal` actually changed the plan.
          'user-a': { deniedProviders: ['anthropic'] },
        },
      },
      now,
      newPlanId: freshNewPlanId(),
    });

    const withoutPrincipal = planner.plan({ agentName: 'selectable' });
    expect(withoutPrincipal.selected?.provider).toBe('anthropic');

    const withPrincipal: PlanSelectionRequest = { agentName: 'selectable', principal: 'user-a' };
    const withPrincipalPlan = planner.plan(withPrincipal);
    expect(withPrincipalPlan.selected?.provider).toBe('gemini');
  });

  it('composes with no user layer when request.principal is absent', () => {
    const service = makeModels();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      models: service,
      modelPolicy: {
        policyRevision: 1,
        users: { 'user-a': { deniedProviders: ['anthropic'] } },
      },
      now,
      newPlanId: freshNewPlanId(),
    });

    const plan = planner.plan({ agentName: 'fixed' });
    expect(plan.outcome).toBe('selected');
    expect(plan.selected?.provider).toBe('anthropic');
  });

  it('stamps every plan with modelPolicy.policyRevision', () => {
    const service = makeModels();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      models: service,
      modelPolicy: { policyRevision: 7 },
      now,
      newPlanId: freshNewPlanId(),
    });

    expect(planner.plan({ agentName: 'fixed' }).policyRevision).toBe(7);
  });
});

describe('createModelPolicyPlanner: createSelectionGateFor', () => {
  it('builds a gate seeded with plan’s own plan', () => {
    const service = makeModels();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      models: service,
      now,
      newPlanId: freshNewPlanId(),
    });

    const gate = planner.createSelectionGateFor({ agentName: 'fixed' });

    expect(gate.getPlan()?.outcome).toBe('selected');
    expect(gate.getPlan()?.selected?.provider).toBe('anthropic');
  });

  it('revalidate() reflects Bureau’s live catalog after a commit — a selectable Agent draws from Bureau’s catalog, unlike a fixed Agent’s own attached descriptor', () => {
    const service = makeModels();
    const planner = createModelPolicyPlanner({
      agents: {
        selectable: selectableAgent('selectable', [
          { provider: geminiDescriptor.provider, model: geminiDescriptor.model },
        ]),
      } satisfies AgentDefinitions,
      models: service,
      now,
      newPlanId: freshNewPlanId(),
    });

    const gate = planner.createSelectionGateFor({ agentName: 'selectable' });
    expect(gate.getPlan()?.outcome).toBe('selected');
    expect(gate.getPlan()?.selected?.provider).toBe('gemini');

    // Bureau's catalog moves on — the gemini descriptor is dropped
    // entirely via the synchronous operator-override commit path
    // (`Models.replace`).
    service.replace(
      service.catalog().descriptors.filter((descriptor) => descriptor.provider !== 'gemini'),
    );

    const revalidated = gate.revalidate();
    expect(revalidated.outcome).not.toBe('selected');
  });
});

describe('createModelPolicyPlanner: the request’s input media (COR-716)', () => {
  const audio = [{ modality: 'audio', sourceForm: 'inline', count: 1 }] as const;

  function plannerOver(agents: AgentDefinitions) {
    const service = makeModels();
    return createModelPolicyPlanner({
      agents,
      models: service,
      now,
      newPlanId: freshNewPlanId(),
    });
  }

  it('plan excludes a candidate that cannot accept the request’s media, typed', () => {
    const planner = plannerOver({ fixed: fixedAgent('fixed') } satisfies AgentDefinitions);

    const plan = planner.plan({ agentName: 'fixed', inputMedia: audio });

    // The fixed Agent’s one backend takes no audio.
    expect(plan.outcome).toBe('no-candidate');
    expect(plan.candidates[0]).toMatchObject({
      eligible: false,
      exclusionCode: 'incompatible-modality',
    });
    expect(plan.request.inputMedia).toEqual(audio);
  });

  it('a gate carries the media of each revalidation into the request it selects with', () => {
    const planner = plannerOver({ fixed: fixedAgent('fixed') } satisfies AgentDefinitions);
    const gate = planner.createSelectionGateFor({ agentName: 'fixed' });
    const initial = gate.getPlan();
    expect(initial?.outcome).toBe('selected');

    const withAudio = gate.revalidate({ inputMedia: audio });

    expect(withAudio.outcome).toBe('no-candidate');
    expect(withAudio.request.inputMedia).toEqual(audio);
    // The superseded plan is untouched.
    expect(initial?.selected?.provider).toBe('anthropic');
    // And a step with no media goes back to the media-free request.
    expect(gate.revalidate().request.inputMedia).toBeUndefined();
  });

  it('a request that names no media plans exactly as before', () => {
    const planner = plannerOver({ fixed: fixedAgent('fixed') } satisfies AgentDefinitions);

    const plan = planner.plan({ agentName: 'fixed' });

    expect(plan.outcome).toBe('selected');
    expect(plan.request.inputMedia).toBeUndefined();
  });
});

describe('modelPolicyDenialOf (COR-1980)', () => {
  it('allows every row when there is no policy, or the policy has no binding layer', () => {
    expect(modelPolicyDenialOf(anthropicDescriptor, undefined)).toBeUndefined();
    expect(modelPolicyDenialOf(anthropicDescriptor, { policyRevision: 1 })).toBeUndefined();
  });

  it('reports the deployment layer, its reason, and the policy revision', () => {
    const denial = modelPolicyDenialOf(anthropicDescriptor, {
      deployment: { deniedModels: [anthropicDescriptor.model] },
      policyRevision: 4,
    });

    expect(denial).toEqual({
      layer: 'deployment',
      reason: `model denied: ${anthropicDescriptor.model}`,
      policyRevision: 4,
    });
  });

  it('reports the Bureau layer for a denied provider', () => {
    const denial = modelPolicyDenialOf(anthropicDescriptor, {
      bureau: { deniedProviders: ['anthropic'] },
      policyRevision: 2,
    });

    expect(denial).toMatchObject({ layer: 'bureau', reason: 'provider denied: anthropic' });
  });

  it('reports the deployment layer first when both layers deny the row', () => {
    const denial = modelPolicyDenialOf(anthropicDescriptor, {
      deployment: { deniedProviders: ['anthropic'] },
      bureau: { deniedProviders: ['anthropic'] },
      policyRevision: 1,
    });

    expect(denial?.layer).toBe('deployment');
  });

  it('still judges a row that is unavailable or unhealthy, because authority is not availability', () => {
    const off = {
      ...anthropicDescriptor,
      availability: 'unavailable',
      health: 'unhealthy',
    } as const;

    expect(
      modelPolicyDenialOf(off, { deployment: { deniedModels: [off.model] }, policyRevision: 1 }),
    ).toMatchObject({ layer: 'deployment' });
    expect(modelPolicyDenialOf(off, { policyRevision: 1 })).toBeUndefined();
  });

  it('binds nothing at the users layer', () => {
    expect(
      modelPolicyDenialOf(anthropicDescriptor, {
        users: { alice: { exactOverride: { provider: 'gemini', model: 'x' } } },
        policyRevision: 1,
      }),
    ).toBeUndefined();
  });
});
