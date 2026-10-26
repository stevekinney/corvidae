/**
 * Bureau's model policy configuration and selection-planning surface
 * (AB-64's decision record; AB-248's `composePolicy` / AB-249's `select`
 * consumed as dependencies; this module is AB-250/mod-03c).
 *
 * A caller asks Bureau what an Agent would use — `models.plan(request)` —
 * and gets a full `SelectionPlan` back without starting a run or refreshing
 * a catalog. `createSelectionGateFor(request)` wraps the same planning
 * logic into a `SelectionGate` (`@lostgradient/operative`), seeded with an
 * initial plan and wired to revalidate against Bureau's LIVE
 * `Bureau.models` catalog and policy configuration on demand — the value
 * `RunOptions.selection` consumes at the `runStep` boundary.
 *
 * Side-effect-free throughout: `plan` starts no run and dispatches no
 * event (`models.catalog()` is a synchronous, cached, side-effect-free read).
 *
 * Out of scope, per AB-250's delivery boundary: `submitSteeringCommand` and
 * `policyRef` resolution through the selector (AB-200); retargeting an
 * active provider request or applying a plan mid-call (ABP-11 non-goals).
 * `createBureau` does not automatically attach a `SelectionGate` to every
 * `bureau.run()` call — that wiring is a later issue's to make; this module
 * only exposes the planning surface and the gate factory `RunOptions.selection`
 * is built from.
 */

import type {
  AgentPreferences,
  BureauInvariants,
  DelegatedAuthority,
  DeploymentInvariants,
  InputMediaRequirement,
  ModelCatalog,
  RunnableAgent,
  SelectionBoundaryContext,
  SelectionGate,
  SelectionPlan,
  SelectionRequest,
  SelectOptions,
  SteeringRequestedValue,
  TaskClassification,
  UserModelConfiguration,
} from '@lostgradient/operative';
import { createSelectionGate, readGenerationProfile, select } from '@lostgradient/operative';

import type { AgentDefinitions } from './agent-catalog';
import type { Models } from './models/create-models';

export type {
  AgentPreferences,
  BureauInvariants,
  DelegatedAuthority,
  DeploymentInvariants,
  UserModelConfiguration,
};

/**
 * `BureauOptions.modelPolicy` — the deployment/Bureau invariants and the
 * per-principal user configuration `plan` composes against, plus
 * the policy revision every produced plan is stamped with. AB-64's decision
 * record: `BureauRunOptions` gains no field for any of this (see
 * `## AB-15 and AB-22 boundaries (AC9)`); it is supplied once, at
 * `createBureau(...)` construction time, and held in memory.
 *
 * Named policy profiles are keys of `users` and of each configuration's own
 * `fallbackOrder` — there is no storage schema and no migration.
 */
export interface BureauModelPolicyOptions {
  readonly deployment?: DeploymentInvariants;
  readonly bureau?: BureauInvariants;
  readonly users?: Readonly<Record<string, UserModelConfiguration>>;
  readonly policyRevision: number;
}

/**
 * The caller-facing request `Bureau.models.plan`/`createSelectionGateFor`
 * accept — the subset of AB-249's `SelectionRequest` a caller supplies;
 * `catalogRevision`, `policyRevision`, and `availabilitySnapshotRevision`
 * are Bureau's own live state and are filled in automatically, never
 * accepted from the caller (a caller-supplied revision could otherwise
 * silently pin a plan against a catalog or policy Bureau no longer holds).
 *
 * `principal` selects the per-principal `UserModelConfiguration` from
 * `BureauModelPolicyOptions.users` — the SAME value `BureauRunOptions.principal`
 * carries for an actual run. Absent: `user` is omitted from the composed
 * `SelectOptions`, narrowing nothing at the user layer.
 */
export interface PlanSelectionRequest {
  readonly agentName: string;
  readonly taskClassification?: TaskClassification;
  readonly requestedValue?: Extract<
    SteeringRequestedValue,
    { target: 'model' | 'provider' | 'route' | 'effort' }
  >;
  readonly principal?: string;
  /**
   * The media the run's input carries (COR-716), for a caller planning ahead of the
   * run. A gate's `revalidate` replaces it with the media of the step in hand, so the
   * plan a run acts on is always judged against what that step will send.
   */
  readonly inputMedia?: readonly InputMediaRequirement[];
}

export interface CreateModelPolicyPlannerOptions<D extends AgentDefinitions> {
  readonly agents: D;
  readonly models: Pick<Models, 'catalog'>;
  readonly modelPolicy?: BureauModelPolicyOptions;
  /** Defaults to the wall clock; inject in tests for byte-stable plans. */
  readonly now?: () => string;
  /** Defaults to `crypto.randomUUID`; inject in tests for byte-stable plans. */
  readonly newPlanId?: () => string;
}

export interface ModelPolicyPlanner {
  /**
   * Builds a full `SelectionPlan` for `request` against Bureau's CURRENT
   * catalog and policy configuration — synchronous, side-effect-free: no
   * run starts, no catalog refresh is triggered, no event is dispatched.
   */
  plan(request: PlanSelectionRequest): SelectionPlan;
  /**
   * Builds a `SelectionGate` seeded with `plan(request)`'s plan
   * and wired to revalidate against Bureau's LIVE catalog/policy on every
   * `revalidate()` call — the value `RunOptions.selection` consumes at the
   * `runStep` boundary (`@lostgradient/operative`).
   */
  createSelectionGateFor(request: PlanSelectionRequest): SelectionGate;
}

/** Reads the named agent's Agent-preferences layer (AB-64's five-layer
 *  precedence model), or `undefined` for an unknown agent name — `select`
 *  treats an absent `agent` the same as one with no preferences at all. */
function resolveAgentPreferences<D extends AgentDefinitions>(
  agentName: string,
  agents: D,
): AgentPreferences | undefined {
  const agent = agents[agentName];
  if (agent === undefined) return undefined;
  // `readGenerationProfile` only reads `agent.generationProfile`, whose
  // presence and shape don't depend on `RunnableAgent`'s `O`/`H` type
  // parameters — but its parameter type defaults to `RunnableAgent<never,
  // false>`, which `D[string]`'s `RunnableAgent<any, true>` half isn't
  // structurally assignable to. Mirrors `agent-catalog.ts`'s identical,
  // identically-justified cast on the same call.
  return readGenerationProfile(agent as RunnableAgent).preferences;
}

/**
 * Narrows `catalog.descriptors` to the candidate set the named Agent's own
 * `GenerationMode` actually offers — `select`/`composePolicy` carry no
 * notion of "candidates this specific Agent attached or nominated"; that
 * narrowing happens here, before the catalog ever reaches `select`, exactly
 * once per `plan`/`createSelectionGateFor` call so it stays
 * correct as Bureau's live catalog changes:
 *
 * - `'fixed'`/`'routed'` — the profile's OWN attached descriptors
 *   (`AgentGenerationProfile.descriptors`, from `withBackendDescriptors`)
 *   are used verbatim, not Bureau's broader catalog: a fixed/routed Agent's
 *   candidate set is exactly what its `GenerateFunction` was built with.
 * - `'selectable'` — Bureau's live catalog, filtered to the Agent's own
 *   `allowedCandidates` (`create-agent.ts`'s option) when it named one;
 *   the full catalog otherwise.
 * - `'opaque'` (no descriptor at all) — an empty descriptor set, matching
 *   AB-64's verification walk: "a custom opaque generator yields an empty
 *   `candidates` array... no fabricated descriptor."
 * - An unknown `agentName` (no catalog entry) — Bureau's full catalog,
 *   unfiltered; `select` still resolves candidates from it and `plan`
 *   doesn't need to special-case a name it can't otherwise validate.
 */
function resolveAgentCatalog<D extends AgentDefinitions>(
  agentName: string,
  agents: D,
  catalog: ModelCatalog,
): ModelCatalog {
  const agent = agents[agentName];
  if (agent === undefined) return catalog;
  // See `resolveAgentPreferences`'s identical cast comment.
  const profile = readGenerationProfile(agent as RunnableAgent);

  if (profile.mode === 'fixed' || profile.mode === 'routed') {
    return { ...catalog, descriptors: profile.descriptors };
  }
  if (profile.mode === 'opaque') {
    return { ...catalog, descriptors: [] };
  }
  // 'selectable'
  const allowed = profile.allowedCandidates;
  if (allowed === undefined) return catalog;
  const allowedKeys = new Set(
    allowed.map((candidate) => `${candidate.provider}::${candidate.model}`),
  );
  return {
    ...catalog,
    descriptors: catalog.descriptors.filter((descriptor) =>
      allowedKeys.has(`${descriptor.provider}::${descriptor.model}`),
    ),
  };
}

/** Selects the per-principal `UserModelConfiguration`, matching how a real
 *  run resolves it from `BureauRunOptions.principal`. A run with no
 *  principal composes with `user` omitted, narrowing nothing at that layer. */
function resolveUserConfiguration(
  principal: string | undefined,
  modelPolicy: BureauModelPolicyOptions | undefined,
): UserModelConfiguration | undefined {
  if (principal === undefined) return undefined;
  return modelPolicy?.users?.[principal];
}

function buildSelectionRequest(
  request: PlanSelectionRequest,
  models: Pick<Models, 'catalog'>,
  modelPolicy: BureauModelPolicyOptions | undefined,
  context?: SelectionBoundaryContext,
): SelectionRequest {
  // The step in hand knows what it will send; a request planned ahead of the run only
  // what its caller said. At a revalidation the step's media wins, and a step with none
  // is judged with none rather than with the plan's earlier guess.
  const inputMedia = context === undefined ? request.inputMedia : context.inputMedia;
  // `availabilitySnapshotRevision` is pinned to the catalog's own
  // `revision`: `Bureau.models` has no separate availability
  // overlay — descriptor availability is part of the catalog's own
  // content, so any availability change is a catalog content change and
  // therefore already a new catalog revision. A future live health/
  // availability probe distinct from a full catalog refresh would give
  // this its own counter; none exists yet.
  const catalog = models.catalog();
  return {
    agentName: request.agentName,
    ...(request.taskClassification === undefined
      ? {}
      : { taskClassification: request.taskClassification }),
    ...(request.requestedValue === undefined ? {} : { requestedValue: request.requestedValue }),
    ...(inputMedia === undefined ? {} : { inputMedia }),
    catalogRevision: catalog.revision,
    policyRevision: modelPolicy?.policyRevision ?? 0,
    availabilitySnapshotRevision: catalog.revision,
  };
}

function buildSelectOptions<D extends AgentDefinitions>(
  request: PlanSelectionRequest,
  agents: D,
  models: Pick<Models, 'catalog'>,
  modelPolicy: BureauModelPolicyOptions | undefined,
  now: (() => string) | undefined,
  newPlanId: (() => string) | undefined,
): SelectOptions {
  return {
    catalog: resolveAgentCatalog(request.agentName, agents, models.catalog()),
    ...(modelPolicy?.deployment === undefined ? {} : { deployment: modelPolicy.deployment }),
    ...(modelPolicy?.bureau === undefined ? {} : { bureau: modelPolicy.bureau }),
    agent: resolveAgentPreferences(request.agentName, agents),
    user: resolveUserConfiguration(request.principal, modelPolicy),
    ...(now === undefined ? {} : { now }),
    ...(newPlanId === undefined ? {} : { newPlanId }),
  };
}

/**
 * Builds Bureau's selection-planning surface: `plan`, called
 * directly (AB-250's "a caller asks Bureau what an Agent would use"
 * observable outcome), and `createSelectionGateFor`, which wraps the same
 * logic into the `SelectionGate` a run's `RunOptions.selection` consumes.
 */
export function createModelPolicyPlanner<D extends AgentDefinitions>(
  options: CreateModelPolicyPlannerOptions<D>,
): ModelPolicyPlanner {
  const { agents, models, modelPolicy, now, newPlanId } = options;

  function plan(request: PlanSelectionRequest): SelectionPlan {
    const selectionRequest = buildSelectionRequest(request, models, modelPolicy);
    const selectOptions = buildSelectOptions(request, agents, models, modelPolicy, now, newPlanId);
    return select(selectionRequest, selectOptions);
  }

  function createSelectionGateFor(request: PlanSelectionRequest): SelectionGate {
    return createSelectionGate({
      initialPlan: plan(request),
      request: (context) => buildSelectionRequest(request, models, modelPolicy, context),
      options: () => buildSelectOptions(request, agents, models, modelPolicy, now, newPlanId),
    });
  }

  return { plan, createSelectionGateFor };
}
