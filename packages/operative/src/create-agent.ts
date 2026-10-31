import type { HookRegistry, RuntimeServices } from '@lostgradient/lifecycle';
import { createDefaultRuntimeServices, mergeHookRegistries } from '@lostgradient/lifecycle';
import type {
  AnyToolbox,
  HeadlessPermissionPolicyConfiguration,
  Tool,
  ToolboxOptions,
  ToolConfiguration,
} from 'armorer';
import { createHeadlessPermissionPolicyHooks, createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';
import type { ZodType } from 'zod';

import { appendAgentInput, assertAgentInput, isConversationInput } from './agent-input';
import type { AgentSkills, GuardrailAdditions } from './agent-policy';
import {
  composeAgentRunPolicy,
  OPERATIVE_RESOLVES_GUARDRAILS,
  resolveAgentGuardrails,
} from './agent-policy';
import type { AgentRun } from './agent-run';
import { createAgentRun } from './agent-run';
import type { AgentSkillDescriptor } from './agent-skill-descriptor';
import { noToolCalls } from './conditions/predicates';
import type { ContextEpochSealer } from './context-epoch';
import type { MediaCostEstimator } from './context/types';
import type { RunCostBudget } from './cost-budget';
import { validateRunCostBudget } from './cost-budget';
import { getModelPricing } from './cost-estimation';
import { createActiveRun } from './create-run';
import type { GeneratedMediaAdmitter } from './generated-media';
import type { AgentGenerationProfile, AgentPreferences } from './generation-profile';
import type { AssetSafetyPolicy, GuardrailsOptions } from './guardrails/types';
import type { OperativeHookMap } from './hooks';
import { inputMessageIdentifier } from './message-identifiers';
import { readBackendDescriptors } from './providers/backend-descriptor-attachment';
import type { ProviderName } from './providers/types';
import type { AgentInput, AgentRunContext, DefinitionResolvingAgent } from './runnable-agent';
import { OPERATIVE_RESOLVE_RUN_OPTIONS } from './runnable-agent';
import { toOutputJsonSchema } from './structured-output/response-schema';
import type {
  ContentSourceResolver,
  ContextManagementOptions,
  GenerateFunction,
  OperativeExecuteOptions,
  RetryOptions,
  RunOptions,
  StopCondition,
} from './types';

// ---------------------------------------------------------------------------
// CreateAgentOptions — the options bag
//
// `generate` is REQUIRED here (no bureau to inherit a provider from).
// `tools` is a name-keyed map: the map KEY is canonical, not the tool's
// inner `.name` (map-form avoids the `.name`-disagreement authoring bug).
// ---------------------------------------------------------------------------

/**
 * How many example prompts an agent may suggest, and how long each may be. One definition for every
 * place that checks them: `createAgent`, an agent file's `examples` frontmatter, and the Bureau's
 * `bureau.agents.list` output. A prompt is a button label on a new chat, so a long one is a
 * paragraph in a button, not a suggestion.
 */
export const AGENT_EXAMPLE_LIMITS = Object.freeze({ maxPrompts: 3, maxLength: 200 });

/**
 * Fields shared by every `CreateAgentOptions` tool-configuration variant.
 * Split out from `CreateAgentOptions` so the exclusive tool-configuration
 * union below can be intersected with it.
 */
export interface CreateAgentOptionsBase {
  /**
   * The LLM provider function. REQUIRED — no bureau to inherit from.
   * Receives a `GenerateContext` and returns a `GenerateResponse`.
   */
  generate: GenerateFunction;

  /**
   * Identifies this agent — stamped on curated `tool.*` bubble events
   * (`AgentRunContext.agentName`'s standalone-path default) and populates
   * the returned agent's `RunnableAgent.name`. Optional here (unlike the
   * final `RunnableAgent` contract, where AB-15 makes it required): a
   * `createAgent` result already satisfies `RunnableAgent<O, H>`
   * structurally without one, defaulting to `'(agent)'`.
   */
  name?: string | undefined;

  /**
   * A human-readable summary of what this agent does. Pure description: it is
   * never sent to the model and does not affect a run. Bureau's agent discovery
   * tool searches and returns it, and an A2A Agent Card would carry it as
   * `AgentCard.description`.
   */
  description?: string | undefined;

  /**
   * Prompts that show what a person might ask this agent, for a host that offers them as buttons
   * on a new chat. Pure description: they are never sent to the model on their own and do not
   * affect a run. Not the same as an A2A skill's `examples`, which belong to one skill; these
   * describe the agent as a whole. Left out, the agent suggests none. At most
   * {@link AGENT_EXAMPLE_LIMITS}`.maxPrompts` prompts, each non-blank and at most
   * {@link AGENT_EXAMPLE_LIMITS}`.maxLength` characters; `createAgent` throws otherwise.
   */
  examples?: readonly string[] | undefined;

  /**
   * Descriptive metadata for the capabilities this agent offers, in the shape
   * of A2A's `AgentSkill` (specification section 4.4.5). Pure description: it
   * never reaches a run.
   *
   * Not the same as `skills`: `skills` is the runtime skill-catalog seam
   * (`AgentSkills`) that gives a run activatable instructions and tools,
   * while this list only tells a caller, or Bureau's agent discovery tool,
   * what the agent can do. An A2A Agent Card would map it to
   * `AgentCard.skills`.
   */
  skillDescriptors?: readonly AgentSkillDescriptor[] | undefined;

  /**
   * System instructions injected as a system message on step 0.
   * Prepended to every run started by this agent.
   */
  instructions?: string | undefined;

  /**
   * Stop conditions checked after each step.
   *
   * Defaults to `stopWhen.noToolCalls()` when omitted — `createAgent` (unlike
   * the lower-level `createActiveRun`, which never applies a default) has no
   * caller to fall back on, and a run with no stop condition at all runs
   * every step to `maximumSteps` (`DEFAULT_MAXIMUM_STEPS`, 25) before
   * exiting with `finishReason: 'maximum-steps'`. For a plain text-in/
   * text-out agent this default is exactly "stop once the model replies
   * without calling a tool" — pass an explicit `stopWhen` (including
   * `stopWhen.toolCalled(...)` for agents that MUST end on a tool call, e.g.
   * `createHandoffTool`) to override it.
   */
  stopWhen?: (StopCondition | StopCondition[]) | undefined;

  /** Hard cap on the number of steps before the loop exits. */
  maximumSteps?: number | undefined;

  /** Options forwarded to toolbox.execute() within the loop. */
  executeOptions?: OperativeExecuteOptions | undefined;

  /** Retry configuration for transient generate failures. */
  retry?: RetryOptions | undefined;

  /**
   * Prices each request of a run, so the run reports a `costEstimate` and can keep to a
   * {@link CreateAgentOptionsBase.costBudget}; see `RunOptions.costEstimation`.
   */
  costEstimation?: RunOptions['costEstimation'];

  /**
   * What one run may spend, in US dollars (COR-1914); see `RunOptions.costBudget`. It needs
   * `costEstimation` with a priced model, and `createAgent` throws without one.
   */
  costBudget?: RunCostBudget | undefined;

  /** Context window management (compaction). */
  contextManagement?: ContextManagementOptions | undefined;

  /**
   * Creates the effective-context epoch sealer for one run; see
   * `RunOptions.contextEpoch`. Called once per run, because a sealer chains
   * the epochs it seals: one shared across runs would link a run's first
   * epoch to another run's last. Sealing is opt-in: without it, no epoch is
   * recorded.
   */
  createContextEpoch?: (() => ContextEpochSealer) | undefined;

  /**
   * Projects media parts whose source no provider takes directly (a managed
   * asset, an upload, a local file, an MCP resource, an A2A reference) to a
   * form one does. Without it such a part fails the step with a
   * `MediaAdmissionError` before any provider call; nothing is dropped.
   */
  contentSourceResolver?: ContentSourceResolver | undefined;
  /**
   * Admits generated media as managed assets; see `RunOptions.generatedMediaAdmitter`. Without
   * one, a media part the model generates fails the step with a `GeneratedMediaNotAdmittedError`.
   */
  generatedMediaAdmitter?: GeneratedMediaAdmitter | undefined;
  /** What to do with a resolved asset no safety gate gave a verdict; see `RunOptions.assetSafety`. */
  assetSafety?: AssetSafetyPolicy | undefined;

  /**
   * Costs media parts. Defaults to a catalog estimator built from the
   * descriptors `generate` carries; a `generate` with no descriptors and no
   * estimator here cannot admit any media part.
   */
  mediaCostEstimator?: MediaCostEstimator | undefined;

  /**
   * Zod schema for the validated terminal `output` value (AB-18) — the
   * single validated output contract. Drives type inference
   * (`z.output<typeof schema>`), the provider-native JSON Schema sent to the
   * model, and runtime validation of the model's final text. There is no
   * separate `responseSchema`/`responseJsonSchema` pair and no non-Zod
   * Standard Schema branch.
   *
   * MUST NOT declare a field intended to carry binary or media content
   * (AB-70's amendment to this issue) — `output` is JSON-only, and a
   * generated asset a run produces belongs in `RunResult.parts` as a
   * managed-asset reference part, never inlined as base64 here.
   */
  output?: ZodType | undefined;

  /**
   * The Agent-requirements-and-preferences layer of AB-64's precedence
   * model (AB-245). Populates the returned agent's
   * `generationProfile.preferences` verbatim; consumed by AB-66's
   * not-yet-built selector, never by this function.
   */
  generationPreferences?: AgentPreferences | undefined;

  /**
   * The revision of this agent's definition: the number the returned agent's
   * `generationProfile.revision` reports, and so the `definitionRevision`
   * Bureau's control plane shows for it. A positive safe integer. Defaults to
   * `1`, which is what an agent that is only ever defined in code reports. A
   * host that rebuilds an agent from a definition that changes over time
   * (Bureau's file agents, COR-1584) passes the revision it keeps for that
   * definition, so a client fencing on `(name, definitionRevision)` sees the
   * change.
   */
  revision?: number | undefined;

  /**
   * Candidates a future selector (AB-66) may choose among. Supplying this
   * promotes the returned agent's `generationProfile.mode` to `'selectable'`
   * regardless of how many `BackendDescriptor`s `generate` itself carries.
   * `generationProfile.selector` still always reads `'unavailable'` here —
   * a `createAgent` agent has no Bureau, no policy configuration, and no
   * catalog, so it can never select (AB-64's verification walk).
   */
  allowedCandidates?:
    readonly { readonly provider: ProviderName; readonly model: string }[] | undefined;

  /**
   * The AB-92/AB-252 injectable runtime-service seam: wall time, monotonic
   * time, timers, identifiers, randomness, and deferred-work tracking.
   * `createAgent` resolves `options.runtime ?? createDefaultRuntimeServices()`
   * exactly once, at agent construction, and passes the SAME resolved
   * instance into every run this agent starts — two runs from one agent
   * share one clock; two agents never share one. Unconfigured (the
   * default), a run reads the real globals; a test composes its own
   * deterministic instance with `createManualRuntimeServices()` from
   * `@lostgradient/operative`.
   */
  runtime?: RuntimeServices | undefined;
  /**
   * This agent's own hook tier (COR-1265, COR-567).
   *
   * Construction-time only, matching every other field here: an agent
   * definition is reused across runs, so a registry swapped in afterwards
   * would retroactively change runs already in flight. The value surfaces
   * as the readonly `hooks` on the resulting agent, and `buildRunOptions`
   * composes it into each run's effective plan through
   * `mergeHookRegistries` rather than handing this instance to the run —
   * so mutating this registry later cannot reach a run already dispatched.
   *
   * Under Bureau, this tier composes UNDER Bureau's invariants: Bureau's
   * registrations hold final narrowing power for every dispatch shape, and
   * an agent hook can add behavior but never widen inherited authority or
   * suppress a Bureau registration.
   */
  hooks?: HookRegistry<OperativeHookMap> | undefined;

  /**
   * This agent's guardrail tripwires (COR-1367) — the per-agent counterpart
   * of the deprecated `BureauOptions.guardrails`, with the same values:
   *
   * - a `GuardrailsOptions` runs exactly that configuration (input and
   *   output detectors, taint, `mode`) on every run this agent starts;
   * - `false` opts this agent out of guardrails altogether;
   * - omitted, the agent inherits: a host's policy handed down through
   *   `AgentRunContext.inheritedGuardrails` when there is one, and otherwise
   *   the AB-40 preset (`createDefaultGuardrailsPreset()` — a prompt-injection
   *   input detector and an output PII validator, both `mode: 'tripwire'`).
   *   An agent that says nothing is therefore guarded, standalone or under
   *   Bureau, and never silently loses the preset.
   *
   * A fresh `createGuardrails` per run, so taint from one run never reaches
   * another. The guardrails also scan this agent's skill bodies and skill
   * resources (COR-1226) when `skills` is set.
   *
   * The output validator runs in `validateResponse`, after `generate`
   * returns. A `generate` that streams text to clients as it arrives has
   * already delivered it by then; buffer generation when the output
   * tripwire must gate what a client sees.
   */
  guardrails?: GuardrailsOptions | false | undefined;

  /**
   * Detectors and validators added to this agent's resolved guardrails (COR-1877), whichever layer
   * resolved them: the agent's own `guardrails`, the host's inherited policy, or the AB-40 preset.
   * They run beside those and never replace them, so an agent that adds one is still guarded by the
   * preset. When the resolved guardrails are `false`, whether the agent's own or its host's, they run alone, as a tripwire.
   */
  additionalGuardrails?: GuardrailAdditions | undefined;

  /**
   * This agent's skills (COR-1367) — the per-agent counterpart of the
   * deprecated `BureauOptions.skills`. Build the value with
   * `createAgentSkills({ catalog })` from `@lostgradient/bureau`; this option
   * takes the `AgentSkills` seam rather than a catalog because operative
   * cannot import the private skills package.
   *
   * Each run then gets a fresh skill client bound to the catalog: the catalog
   * is shown to the model at step 0, `activate_skill`/`load_skill_resource`/
   * `deactivate_skill` join the run's toolbox, active skill instructions are
   * re-rendered on every step, an active skill's `allowed-tools` narrows the
   * tools the model sees, and skill content is scanned by this agent's
   * resolved guardrails.
   *
   * Under `permissions`, the skill tools are ordinary tools: deny-by-default
   * denies them unless the allowlist names them. With a shared `toolbox`, the
   * skill tools are combined into a per-run toolbox built from it, which
   * keeps the shared toolbox's approval configuration (see
   * `combineToolboxes`) but not its in-memory event emitter.
   *
   * Omitted, the agent has no skills: Bureau's own `skills` never reached a
   * catalog-dispatched agent and still does not.
   */
  skills?: AgentSkills | undefined;
}

/**
 * The exclusive tool-configuration surface of `CreateAgentOptions`. Encodes
 * the runtime-enforced exclusivity at the type level: `toolbox` is exclusive
 * with BOTH `tools` and `permissions`, which may otherwise be combined
 * freely (including "neither" — no tool configuration at all) —
 * `tools`/`permissions` combined with `toolbox` is a type error, not just a
 * runtime throw.
 *
 * Deliberately just two variants, not one per row of the accepted matrix
 * ("no tool configuration", `tools`, `permissions`, `tools` + `permissions`,
 * `toolbox`): a caller commonly forwards an already-optional value, e.g.
 * `const tools: Record<string, Tool> | undefined = maybeTools();
 * createAgent({ generate, tools })`. A one-variant-per-row union rejects
 * that — `tools: X | undefined` doesn't structurally match either "tools
 * required" or "tools absent". Widening `tools` and `permissions` to
 * `T | undefined` within a single non-toolbox variant accepts every
 * combination of "present, absent, or explicitly undefined" for both at
 * once, while the separate toolbox variant still excludes both.
 *
 * The excluded `toolbox`/`tools`/`permissions` fields in each variant are
 * typed `?: undefined` rather than omitted, so an explicitly `undefined`
 * value (e.g. `{ toolbox, tools: undefined }`) is still accepted —
 * `undefined` is treated as omitted, matching the runtime guards in
 * `validateCreateAgentOptions`. `?: undefined` (rather than `?: never`)
 * keeps this true even under `exactOptionalPropertyTypes: true`, where an
 * optional property no longer implicitly includes `undefined` — this repo
 * currently disables that flag (`tsconfig.base.json`), but the excluded
 * fields don't depend on it either way.
 */
export type CreateAgentToolConfiguration =
  | {
      tools?: Record<string, Tool> | undefined;
      toolbox?: undefined;
      permissions?: HeadlessPermissionPolicyConfiguration | undefined;
      toolboxOptions?: CreateAgentToolboxOptions | undefined;
    }
  | {
      tools?: undefined;
      toolbox: AnyToolbox;
      permissions?: undefined;
      toolboxOptions?: undefined;
    };

/**
 * Builds the options of the toolbox `createAgent` makes for one run (COR-1913). It is called once
 * for each run, and again when a durable run's options are rebuilt on recovery, so a policy hook,
 * a budget or a counter it creates belongs to that run alone: two runs of one agent never share
 * it, which a supplied `toolbox` cannot promise. `context` is the run's own, or `undefined` for a
 * call that has none. The result is handed to `createToolbox` with the agent's `tools`; give it
 * the `approvalSecret` there, and every toolbox that is to resume the approvals it signs.
 *
 * Mutually exclusive with `toolbox` and with `permissions`, which sets the toolbox's `policy` and
 * so would be silently replaced.
 */
export type CreateAgentToolboxOptions = (context: AgentRunContext | undefined) => ToolboxOptions;

/**
 * Options for `createAgent({...})`. Distinct from the old `DefineAgentOptions`
 * (which requires a `toolbox`). Here `tools` is a name-keyed map and `generate`
 * is unconditionally required — there is no bureau to inherit a provider from.
 *
 * The tool-configuration fields (`tools`, `toolbox`, `permissions`) are
 * mutually exclusive along the axes documented on
 * `CreateAgentToolConfiguration`:
 *
 * - `tools` — agent tools as a name-keyed map. The map key is the canonical
 *   tool name; the tool's own `.name` property is ignored (key wins).
 *   Optional — an agent with no tools is valid for pure-generation tasks.
 *   Mutually exclusive with `toolbox`.
 * - `toolbox` — a pre-built `Toolbox` instance, used as-is for every run
 *   started by this agent. Mutually exclusive with `tools` (which composes a
 *   fresh internal toolbox instead) and with `permissions` (which configures
 *   a toolbox this factory builds itself).
 *
 *   Unlike `tools`, a `toolbox` you pass here is NOT rebuilt per run — every
 *   `run()` call shares this exact instance. Armorer's cross-request approval
 *   flow additionally requires versioned tools, request-scoped authority in
 *   `executeOptions.requestContext`, the same authority re-authenticated when
 *   calling `toolbox.resumeApproval()`, and approval state shared between the
 *   issuing and resuming toolbox. A module-scoped toolbox supplies process-local
 *   state; multi-process or restart-safe hosts must configure the same durable
 *   `ApprovalStateStore` and `approvalSecret` on every toolbox instance.
 *
 *   Because the instance is shared, concurrent runs against the same
 *   `StandaloneAgent` will cross-fire each other's toolbox events and share
 *   budget/loop-detection counters — the same tradeoff as constructing the
 *   toolbox yourself and reusing it. If you don't need cross-run state
 *   (approvals, budgets), use `tools` instead for per-run isolation.
 * - `toolboxOptions` — a function that returns the options of the toolbox this factory builds
 *   for a run from `tools`, called once per run (COR-1913). Use it for what must belong to a run
 *   alone and so cannot sit on a shared `toolbox`: a policy hook that keeps a count, a budget, an
 *   `approvalSecret` with the approval policy that raises approvals. Mutually exclusive with
 *   `toolbox` and with `permissions`.
 * - `permissions` — headless deny-by-default permission mode (AB-94,
 *   armorer's `createHeadlessPermissionPolicyHooks`). When set, every tool
 *   call is checked against an explicit allowlist/denylist and an optional
 *   capability-tier policy and synchronous per-call gate — anything unlisted
 *   or that would otherwise require human approval is denied outright (this
 *   run never parks on a human). A denial feeds the model a tool-error
 *   result and the loop continues; it never throws and never terminates the
 *   run.
 *
 *   For the opposite mode — parking on a pending approval instead of denying
 *   it — pass a pre-built `toolbox` (with its own approval policy) and use
 *   `stopWhen: stopWhen.pendingApproval()`. `permissions` only configures a
 *   toolbox this factory builds itself, so it's mutually exclusive with
 *   `toolbox`.
 *
 * This is a `type` (intersecting `CreateAgentOptionsBase` with the
 * `CreateAgentToolConfiguration` union), not an `interface`, as of AB-16 —
 * enforcing exclusivity requires a union, and TypeScript interfaces can't
 * `extends` a type containing a union, nor declaration-merge into one. A
 * consumer that previously wrote `interface MyOptions extends
 * CreateAgentOptions` for the full options bag needs `MyOptions =
 * CreateAgentOptions & { ... }` instead; extending or declaration-merging
 * onto just the non-exclusive fields still works via the separately
 * exported `CreateAgentOptionsBase` interface.
 */
export type CreateAgentOptions = CreateAgentOptionsBase & CreateAgentToolConfiguration;

/**
 * Defensively copies and deep-freezes `preferences` before it becomes part
 * of the cached, frozen `generationProfile` snapshot. `Object.freeze` on the
 * profile object alone is shallow — without this, a caller holding the same
 * `AgentPreferences` object (or one of its array fields) it passed to
 * `generationPreferences` could mutate it after `createAgent()` returns and
 * retroactively change what the already-constructed agent reports.
 */
function freezeGenerationPreferences(preferences: AgentPreferences): AgentPreferences {
  return Object.freeze({
    ...(preferences.requiredCapabilities
      ? { requiredCapabilities: Object.freeze([...preferences.requiredCapabilities]) }
      : {}),
    ...(preferences.preferredProviders
      ? { preferredProviders: Object.freeze([...preferences.preferredProviders]) }
      : {}),
    ...(preferences.preferredModels
      ? { preferredModels: Object.freeze([...preferences.preferredModels]) }
      : {}),
    ...(preferences.minimumContextWindowTokens !== undefined
      ? { minimumContextWindowTokens: preferences.minimumContextWindowTokens }
      : {}),
    ...(preferences.requiredInputModalities
      ? {
          requiredInputModalities: Object.freeze(
            preferences.requiredInputModalities.map((required) =>
              Object.freeze({
                modality: required.modality,
                ...(required.sourceForms
                  ? { sourceForms: Object.freeze([...required.sourceForms]) }
                  : {}),
              }),
            ),
          ),
        }
      : {}),
  });
}

/** Same rationale as {@link freezeGenerationPreferences}, for `allowedCandidates`. */
function freezeAllowedCandidates(
  candidates: NonNullable<CreateAgentOptionsBase['allowedCandidates']>,
): NonNullable<CreateAgentOptionsBase['allowedCandidates']> {
  return Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate })));
}

/**
 * Validates the mutually-exclusive option combinations in
 * `CreateAgentOptions` once, at `createAgent()` call time (not per-run).
 */
function validateExamples(examples: readonly string[] | undefined): void {
  if (examples === undefined) return;
  const { maxPrompts, maxLength } = AGENT_EXAMPLE_LIMITS;
  if (examples.length > maxPrompts) {
    throw new Error(
      `createAgent: \`examples\` holds at most ${String(maxPrompts)} prompts; received ${String(examples.length)}.`,
    );
  }
  for (const prompt of examples) {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new Error('createAgent: each of `examples` must be a non-empty string.');
    }
    if (prompt.length > maxLength) {
      throw new Error(
        `createAgent: each of \`examples\` is at most ${String(maxLength)} characters; received ${String(prompt.length)}.`,
      );
    }
  }
}

function validateCreateAgentOptions(options: CreateAgentOptions): void {
  if (options.tools && options.toolbox) {
    throw new Error(
      'createAgent: `tools` and `toolbox` are mutually exclusive. Pass `tools` for a fresh, ' +
        'per-run internal toolbox, or `toolbox` to use a pre-built Toolbox instance as-is across ' +
        "every run (required for armorer's cross-request approval flow, where " +
        '`toolbox.resumeApproval` must share the same `approvalSecret` that minted the pending ' +
        'approval).',
    );
  }

  if (
    options.revision !== undefined &&
    !(Number.isSafeInteger(options.revision) && options.revision >= 1)
  ) {
    throw new Error(
      `createAgent: \`revision\` must be a positive safe integer; received ${String(options.revision)}.`,
    );
  }

  validateExamples(options.examples);

  if (options.costBudget !== undefined) {
    const problem = validateRunCostBudget(options.costBudget);
    if (problem !== undefined) throw new Error(`createAgent: ${problem}`);
    const { costEstimation } = options;
    if (
      costEstimation === undefined ||
      getModelPricing(costEstimation.model, costEstimation.pricing) === undefined
    ) {
      throw new Error(
        'createAgent: `costBudget` needs `costEstimation` naming a model with a price, because ' +
          'the budget is measured against the run’s priced cost. Without one it could not be enforced.',
      );
    }
  }

  if (options.toolbox && options.toolboxOptions) {
    throw new Error(
      'createAgent: `toolboxOptions` configures the toolbox this factory builds for each run and ' +
        'cannot be combined with `toolbox` (a pre-built Toolbox instance already owns its own ' +
        'options). Pass the options to `createToolbox` yourself instead.',
    );
  }

  if (options.permissions && options.toolboxOptions) {
    throw new Error(
      'createAgent: `permissions` and `toolboxOptions` both set the policy of the toolbox built ' +
        'for each run, so they cannot be combined. Put the permission hooks in `toolboxOptions` ' +
        'with `createHeadlessPermissionPolicyHooks`.',
    );
  }

  if (options.toolbox && options.permissions) {
    throw new Error(
      'createAgent: `permissions` configures a freshly-built internal toolbox and cannot be ' +
        'combined with `toolbox` (a pre-built Toolbox instance already owns its own policy and ' +
        'hooks). Configure permissions directly on the toolbox you pass, via ' +
        '`createHeadlessPermissionPolicyHooks`, instead.',
    );
  }

  // AB-18: an unrepresentable `output` schema fails FAST, synchronously, at
  // `createAgent()` call time — not on `await run.result()` after a run has
  // already started. `toOutputJsonSchema` throws `OutputSchemaConversionError`
  // for a schema `z.toJSONSchema` can't convert; its result is discarded here
  // (the loop recomputes it per run via `resolveResponseFormat`, a cheap
  // re-derivation once this guard has already proven the schema convertible).
  if (options.output) {
    toOutputJsonSchema(options.output);
  }
}

// ---------------------------------------------------------------------------
// StandaloneAgent — the runtime agent returned by createAgent()
//
// NOT a `RunnableAgent` from the deleted synchronous builder chain (AB-22).
// The runtime object just needs `.run()`.
// ---------------------------------------------------------------------------

/**
 * The runtime agent returned by `createAgent({...})`. Bureau-less, in-memory
 * only. Calling `.run(input)` starts a new ephemeral run each time.
 */
export interface StandaloneAgent<
  O = never,
  H extends boolean = false,
> extends DefinitionResolvingAgent {
  /**
   * This agent's identity — `options.name`, defaulting to `'(agent)'` when
   * omitted. Makes a `createAgent` result structurally satisfy
   * `RunnableAgent<O, H>` (AB-21), so it can be passed to `createLazyAgent`
   * or placed in an `AgentDefinitions` map without a cast.
   */
  readonly name: string;

  /**
   * A human-readable summary of what this agent does. Pure description: it is
   * never sent to the model and does not affect a run. Bureau's agent discovery
   * tool searches and returns it, and an A2A Agent Card would carry it as
   * `AgentCard.description`.
   */
  readonly description?: string | undefined;

  /**
   * The prompts this agent was created with (`options.examples`), in order, for a host that offers
   * them on a new chat. Omitted when the agent was created with none. Read-only description: it
   * never reaches a run. Frozen once.
   */
  readonly examples?: readonly string[] | undefined;

  /**
   * Descriptive metadata for the capabilities this agent offers, in the shape
   * of A2A's `AgentSkill` (specification section 4.4.5). Pure description: it
   * never reaches a run.
   *
   * Not the same as `skills`: `skills` is the runtime skill-catalog seam
   * (`AgentSkills`) that gives a run activatable instructions and tools,
   * while this list only tells a caller, or Bureau's agent discovery tool,
   * what the agent can do. An A2A Agent Card would map it to
   * `AgentCard.skills`.
   */
  readonly skillDescriptors?: readonly AgentSkillDescriptor[] | undefined;

  /**
   * A runtime witness for `H` (AB-234) — `output !== undefined` in the
   * options this agent was created with. See `RunnableAgent.hasOutput`'s
   * doc comment (`runnable-agent.ts`) for why this exists alongside the
   * compile-time-only `H` parameter.
   */
  readonly hasOutput: boolean;

  /**
   * This agent's immutable generation-capability snapshot (AB-64, AB-245),
   * computed once at `createAgent()` call time from `options.generate`'s
   * attached `BackendDescriptor`(s): `'fixed'` for exactly one, `'routed'`
   * for more than one, `'opaque'` for none — promoted to `'selectable'`
   * when `options.allowedCandidates` was supplied. Read it with
   * `readGenerationProfile(agent)` rather than this field directly.
   */
  readonly generationProfile: AgentGenerationProfile;

  /**
   * This agent's own hook tier, exactly as `options.hooks` supplied it
   * (COR-1265). `readonly` because it is construction-time only — see
   * `CreateAgentOptionsBase.hooks`.
   *
   * This is the SOURCE registry, not any run's effective plan: a run's plan
   * is a merged snapshot built at dispatch, so registering on this registry
   * after a run started does not change that run.
   */
  readonly hooks?: HookRegistry<OperativeHookMap> | undefined;

  /**
   * This agent's own guardrail declaration, exactly as `options.guardrails`
   * supplied it (COR-1367). Omitted when the agent declared none — the
   * resolved policy then depends on the host (see
   * `CreateAgentOptionsBase.guardrails`), so it is not a property of the
   * agent alone.
   */
  readonly guardrails?: GuardrailsOptions | false | undefined;

  /** This agent's skills, exactly as `options.skills` supplied them (COR-1367). */
  readonly skills?: AgentSkills | undefined;

  /**
   * The system instructions this agent was created with (`options.instructions`), exactly as
   * given. Omitted when the agent was created with none or with an empty string. Read-only
   * description for a host that shows or duplicates the agent (COR-1818): a run is given the same
   * text as its step 0 system message, and changing this value changes nothing.
   */
  readonly instructions?: string | undefined;

  /**
   * The names of the tools this agent was created with, in definition order: the keys of
   * `options.tools` (the canonical names; a namespaced key `plugin:tool` reaches the model as
   * `plugin__tool`), or the names of the tools in
   * `options.toolbox`, each name once even when the toolbox holds two tools under it. Read-only
   * description for a host that wants to show what the agent can do: it never reaches a run, and it
   * leaves out the skill tools (`activate_skill`, `deactivate_skill`) a run adds when `skills` is
   * set. An agent created without tools lists `[]`.
   */
  readonly toolNames: readonly string[];

  /**
   * Always `true`: a `createAgent` agent resolves its own guardrails and
   * honors `AgentRunContext.inheritedGuardrails`, so a host hands its policy
   * down rather than layering it on top (COR-1367).
   */
  readonly [OPERATIVE_RESOLVES_GUARDRAILS]: true;

  /**
   * Start a new in-memory run.
   *
   * - `run('some text')` starts a fresh conversation: `instructions` (if
   *   given) is appended as a system message, followed by `input` as a user
   *   message.
   * - `run({ conversation })` starts the loop from an existing
   *   `ConversationHistory` — the shape a stateless HTTP chat host holds
   *   between requests. The history is SNAPSHOTTED: this run CLONES it
   *   before wrapping it in a fresh internal `Conversation`, so the run's
   *   state and the caller's `ConversationHistory` object are independent
   *   from the moment `run()` is called — the run never mutates the
   *   caller's object, and later mutations by the caller (a stateless host
   *   commonly holds a mutable reference it keeps touching between turns)
   *   never affect an in-flight run. This matches the durable path's
   *   existing snapshot semantics. `instructions` is NOT re-appended in
   *   this form — the supplied history is assumed to already carry
   *   whatever system context it needs, so resuming it repeatedly never
   *   duplicates system messages.
   *
   * `context` (AB-21's `AgentRunContext`) is optional, matching
   * `RunnableAgent.run`: `signal` becomes `RunOptions.signal`, `agentName`
   * overrides the run's stamped agent name, `traceContext` becomes
   * `RunOptions.parentContext`, and `withTraceContext` is forwarded as-is.
   *
   * Returns an `AgentRun` handle — NOT a Promise (non-thenable by design).
   * Access the result via `handle.result()`.
   *
   * Declared as a property-typed function, not method shorthand — see
   * `RunnableAgent.run`'s doc comment (`runnable-agent.ts`) for why.
   */
  run: (input: AgentInput, context?: AgentRunContext) => AgentRun<O, H>;
}

// Re-export AgentRun from agent-run.ts so callers who import from create-agent
// still get the canonical type.
export type { AgentRun };

// ---------------------------------------------------------------------------
// createAgent — the public factory
// ---------------------------------------------------------------------------

/**
 * COR-1879 — a tool's configuration under the key `options.tools` gives it. A bare key becomes the
 * tool's name, so the model calls the tool by its key, prefixed `<namespace>__` when the tool was
 * authored in a namespace of its own. A namespaced key (`plugin:tool`) becomes
 * the identity's namespace and name, keeping the tool's own version: the durable record pins
 * `plugin:tool@version`, the model calls it `plugin__tool` (Armorer's default provider naming),
 * and the toolbox resolves that name back to the tool, so two namespaces' `search` stay apart.
 */
function toolEntryUnderKey(key: string, tool: Tool): ToolConfiguration {
  const separator = key.indexOf(':');
  const namespace = key.slice(0, separator);
  const name = key.slice(separator + 1);
  if (separator < 1 || name === '' || name.includes(':') || name.includes('@')) {
    return { ...tool.configuration, name: key };
  }
  const { version } = tool.configuration.identity;
  return {
    ...tool.configuration,
    name,
    identity: { namespace, name, ...(version === undefined ? {} : { version }) },
  };
}

/**
 * Creates a standalone, bureau-less agent. `generate` is required — there is
 * no bureau to inherit a provider from. Runs are in-memory and ephemeral;
 * there is no durability, no session, no shared memory.
 *
 * For bureau-owned agents (with shared tools, hooks, memory, and durability),
 * use `bureau.agent({...})` instead (Phase E).
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   generate: myProvider,
 *   instructions: 'You are a research assistant.',
 *   tools: { search: searchTool },
 * });
 *
 * const run = agent.run('Summarize the Q3 report.');
 * for await (const event of run) { ... }  // iterate, OR
 * const result = await run.result();       // await — same handle
 * ```
 *
 * @example Stateless chat host with a shared toolbox and park-on-approval
 * ```ts
 * import { createToolbox } from 'armorer';
 * import { createAgent, stopWhen } from '@lostgradient/operative';
 *
 * // Built once for this process. This example requires both HTTP requests to
 * // reach this toolbox instance. Multi-process or restart-safe hosts must also
 * // configure every toolbox with the same durable ApprovalStateStore.
 * // Approval-gated tools must declare a stable version, for example `version: '1'`.
 * const toolbox = createToolbox([deleteFileTool], {
 *   approvalPolicy: { mode: 'on-mutation' },
 *   approvalSecret: Bun.env['APPROVAL_SECRET'],
 * });
 *
 * const requestContext = {
 *   authority: {
 *     principalId: currentUser.id,
 *     tenantId: currentTenant.id,
 *     ownerId: currentSession.id,
 *     capabilities: currentAuthorization.capabilities,
 *     authorizationRevision: currentAuthorization.revision,
 *   },
 *   audience: 'tenant',
 *   agentId,
 *   runId,
 * } as const;
 *
 * const agent = createAgent({
 *   generate: myProvider,
 *   toolbox,
 *   executeOptions: { requestContext },
 *   // Combined with noToolCalls(): pendingApproval() alone never stops a
 *   // normal, no-tool-call turn, so a plain text reply would otherwise run
 *   // to maximumSteps instead of finishing.
 *   stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
 * });
 *
 * // Turn 1: run from the client-POSTed history.
 * const run = agent.run({ conversation: clientHistory });
 * const result = await run.result();
 * const pending = result.steps.at(-1)?.results.find((r) => r.pendingApproval)?.pendingApproval;
 * // ...send `pending` to a human, store `result.conversation.current` server-side...
 *
 * // Later, authenticate the approval request and build a fresh context with
 * // the same bound identity fields. Do not reuse an expired request deadline.
 * const approvalRequestContext = {
 *   authority: {
 *     principalId: approvalUser.id,
 *     tenantId: approvalTenant.id,
 *     ownerId: approvalSession.id,
 *     capabilities: approvalAuthorization.capabilities,
 *     authorizationRevision: approvalAuthorization.revision,
 *   },
 *   audience: requestContext.audience,
 *   agentId: requestContext.agentId,
 *   runId: requestContext.runId,
 *   deadline: Date.now() + 30_000,
 * };
 * const resumedResult = await toolbox.resumeApproval(signedApproval, {
 *   requestContext: approvalRequestContext,
 * });
 * // `result.conversation` already has an `action_required` tool-result for
 * // this call (the loop appends it before stopWhen ever runs) — appending
 * // `resumedResult` on top would leave two results for the same call, which
 * // most providers reject on the next turn. Use conversationalist's
 * // resolveToolResult(conversation, callId, resumedResult) to replace the
 * // pending result before starting the next run.
 * ```
 */
export function createAgent<O>(
  options: CreateAgentOptions & { output: ZodType<O> },
): StandaloneAgent<O, true>;
export function createAgent(options: CreateAgentOptions & { output?: undefined }): StandaloneAgent;
export function createAgent(options: CreateAgentOptions): StandaloneAgent<unknown, boolean>;
export function createAgent(options: CreateAgentOptions): StandaloneAgent<unknown, boolean> {
  validateCreateAgentOptions(options);

  const {
    generate,
    tools,
    toolbox: providedToolbox,
    instructions,
    permissions,
    toolboxOptions,
    output,
    name: configuredName,
    description,
    examples,
    skillDescriptors,
    // Default to `noToolCalls()` when the caller doesn't supply a `stopWhen`
    // — see the doc comment on `CreateAgentOptionsBase.stopWhen`. Falls back
    // to `createActiveRun`'s own "no stop conditions at all" behavior only
    // when explicitly overridden with an empty array.
    stopWhen = noToolCalls(),
    // Consumed only to build `generationProfile` below (AB-245) — neither
    // field is a `RunOptions` member, so both are destructured out here
    // rather than left to fall into `...rest` and leak onto the
    // `RunOptions` bag `buildRunOptions` hands to `createActiveRun`.
    generationPreferences,
    allowedCandidates,
    // COR-1584 — likewise consumed only by `generationProfile`.
    revision = 1,
    // AB-92/AB-252 — destructured out (rather than left in `...rest`) so it
    // can be resolved to a concrete `RuntimeServices` instance exactly once
    // below, at agent construction, and that SAME instance handed to every
    // run this agent starts.
    runtime: providedRuntime,
    // COR-1265 — destructured out rather than left in `...rest` so the raw
    // agent registry never reaches `RunOptions.hooks` directly. What a run
    // gets is the MERGED snapshot `buildRunOptions` composes below; handing
    // this instance over instead would let a later `agent.hooks.on(...)`
    // reach a run already in flight.
    hooks: agentHooks,
    // COR-1367 — destructured out so neither reaches `RunOptions` through
    // `...rest`: both are resolved per run below into hook registrations and
    // toolbox contributions, which is the only form a run consumes them in.
    guardrails: declaredGuardrails,
    additionalGuardrails,
    skills,
    // Review findings (AB-241): `principal` is inherently per-call
    // attribution (AB-21's `AgentRunContext.principal`), never a
    // construction-time concept — `CreateAgentOptionsBase` declares no such
    // field. But TypeScript's excess-property check only fires against an
    // object LITERAL, so a caller passing a widened or plain-JS options
    // object that happens to carry a `principal` key would otherwise have
    // it survive into `rest` undetected. Destructured out and discarded
    // here (the cast is narrow and exists ONLY to name and strip this one
    // unsupported key; `principal` itself is never read from `options`)
    // rather than merely reordering the later spread, since reordering
    // alone still leaked a construction-time value through on a run whose
    // own `context.principal` was omitted (the later conditional spread is
    // a no-op when `context?.principal` is `undefined`, so nothing
    // overwrites whatever `rest.principal` would otherwise have carried).
    principal: _discardedConstructionTimePrincipal,
    // Resolved per run below, so each run seals its own epoch chain.
    createContextEpoch,
    ...rest
  } = options as CreateAgentOptions & { principal?: unknown };

  const resolvedName = configuredName ?? '(agent)';

  // AB-92/AB-252: resolved once, here, rather than per-run — two runs from
  // this agent share one clock; two agents never share one.
  const runtime = providedRuntime ?? createDefaultRuntimeServices();

  // AB-64 AC2/AB-245: exactly one attached descriptor is `'fixed'`, more
  // than one is `'routed'` (e.g. `createRoutingGenerate`'s union), none is
  // `'opaque'` — never invented for a custom `GenerateFunction`. Supplying
  // `allowedCandidates` promotes the mode to `'selectable'` regardless of
  // descriptor count. `selector` always reads `'unavailable'`: a
  // `createAgent` agent has no Bureau, no policy, and no catalog, so it can
  // never select (AB-64's verification walk).
  const attachedDescriptors = readBackendDescriptors(generate);
  const generationProfile: AgentGenerationProfile = Object.freeze({
    mode: allowedCandidates
      ? 'selectable'
      : attachedDescriptors.length === 1
        ? 'fixed'
        : attachedDescriptors.length > 1
          ? 'routed'
          : 'opaque',
    revision,
    projection: 'privileged',
    descriptors: attachedDescriptors,
    ...(generationPreferences
      ? { preferences: freezeGenerationPreferences(generationPreferences) }
      : {}),
    ...(allowedCandidates ? { allowedCandidates: freezeAllowedCandidates(allowedCandidates) } : {}),
    freshness: runtime.clock.nowISO(),
    selector: 'unavailable',
  });

  // Pre-compute tool entries once (pure transform — no per-run state).
  // The map key is canonical, whatever the tool was authored with. Skipped
  // entirely when a pre-built `toolbox` is supplied (mutually exclusive).
  const toolEntries = tools
    ? Object.entries(tools).map(([key, tool]) => toolEntryUnderKey(key, tool))
    : [];

  // The names the model calls the tools by: the map keys (see above), or the names in a supplied
  // toolbox, which has no way to add a tool after it is built. A pre-built toolbox may hold two
  // tools under one name, and a name is listed once: a host keys what it shows by it. Frozen once.
  const toolNames: readonly string[] = Object.freeze(
    providedToolbox === undefined
      ? Object.keys(tools ?? {})
      : [...new Set(providedToolbox.tools().map((tool) => tool.name))],
  );

  // Shared by `run()` and the AB-21 definition-resolution protocol below —
  // both need the exact same `RunOptions` bag; only what happens to it
  // (start an in-memory run vs. hand it to a durable engine) differs.
  function buildRunOptions(input: AgentInput, context?: AgentRunContext): RunOptions {
    // A caller-supplied `toolbox` is used AS-IS, shared across every run —
    // that's the point (see the `toolbox` option's doc comment: it's what
    // makes armorer's cross-request approval flow possible). Otherwise
    // build a fresh Toolbox for each run: `createActiveRun` attaches
    // listeners to the toolbox emitter and the toolbox tracks per-instance
    // state (loop detection, budget counters), so a toolbox this factory
    // owns must not be shared between concurrent runs.
    const baseToolbox =
      providedToolbox ??
      createToolbox(
        toolEntries,
        toolboxOptions !== undefined
          ? toolboxOptions(context)
          : permissions
            ? { policy: createHeadlessPermissionPolicyHooks(permissions) }
            : undefined,
      );

    // COR-1367 — the agent's own declaration first, then whatever the host
    // handed down, then the AB-40 preset. Resolved per run because the
    // inherited half arrives with the run's context.
    const runGuardrails = resolveAgentGuardrails(
      declaredGuardrails,
      context?.inheritedGuardrails,
      additionalGuardrails,
    );
    // COR-1265 — the agent tier becomes this run's effective hook plan, as a
    // fresh merged snapshot rather than the agent's own registry.
    // `mergeHookRegistries` copies every entry into a new registry that holds
    // no reference back, so a registration added to `agentHooks` after this
    // run was dispatched cannot reach it. Left `undefined` when the agent has
    // neither hooks nor policy, so such an agent keeps the absent
    // `RunOptions.hooks` it always had rather than an empty registry per run.
    //
    // Only the agent tier participates here. Bureau's tier is composed at
    // Bureau's own dispatch sites, and there is no direct tier on this path:
    // `AgentRunContext` declares no `hooks` field, so a caller of
    // `agent.run()` has no per-call hook surface.
    const hasPolicy = runGuardrails !== undefined || skills !== undefined;
    const hooks =
      agentHooks === undefined && !hasPolicy
        ? undefined
        : mergeHookRegistries(undefined, agentHooks, undefined);
    const toolbox =
      hooks !== undefined && hasPolicy
        ? composeAgentRunPolicy({
            guardrails: runGuardrails,
            skills,
            toolbox: baseToolbox,
            hooks,
            agentName: context?.agentName ?? resolvedName,
            runtime,
          })
        : baseToolbox;

    assertAgentInput(input);
    const conversation = !isConversationInput(input)
      ? (() => {
          // Build a fresh Conversation for each run (ephemeral — no session state).
          // AB-321: the same resolved `runtime` this function forwards into
          // `RunOptions` below, so the fresh conversation's id/timestamps
          // read through the identical seam.
          const fresh = new Conversation(undefined, { runtime });
          if (instructions) {
            fresh.appendSystemMessage(instructions);
          }
          // A string or an ordered list of parts becomes exactly one user
          // message; a part list is cloned so the run and the caller's array
          // are independent from the moment `run()` is called. The row's id comes from the
          // run's id: a durable run's options are rebuilt when it is replayed or recovered, and a
          // row minted at random would get a new id each time (COR-1581).
          appendAgentInput(fresh, input, undefined, inputMessageIdentifier(context?.runId));
          return fresh;
        })()
      : // Snapshot semantics: CLONE the supplied history before wrapping it
        // in a fresh Conversation instance. `Conversation`'s constructor
        // only validates its input — it does not copy it — so without the
        // clone this run's initial node would alias the caller's own
        // ConversationHistory object. A stateless host commonly holds a
        // mutable reference it keeps touching between turns; aliasing
        // would let either side's mutations leak into the other. The
        // clone makes this run's state and the caller's object fully
        // independent from the moment `run()` is called: later mutations
        // by the caller (or by another run resuming the same object)
        // never affect this in-flight run, and this run never mutates the
        // caller's object (`ConversationHistory` is a structuredClone-safe
        // tree — see `durable/types.ts`).
        new Conversation(structuredClone(input.conversation), { runtime });

    return {
      generate,
      toolbox,
      conversation,
      stopWhen,
      output,
      // AB-92/AB-252 — the SAME instance resolved once above, shared by
      // every run this agent starts.
      runtime,
      // Review finding (AB-241): `rest` comes BEFORE every per-call
      // `AgentRunContext`-derived field below, not after. `CreateAgentOptions`
      // declares no `principal` (or `signal`/`childRegistry`/etc.) of its own,
      // but TypeScript's excess-property check only fires against an object
      // LITERAL — a caller passing a widened or plain-JS options object that
      // happens to carry one of these keys would otherwise have it survive
      // into `rest` and silently clobber the correct per-call value spread
      // after it. `principal` in particular is inherently per-call
      // attribution, never a construction-time concept, so a stray
      // construction-time value must never be able to override the run's
      // actual caller-supplied principal.
      ...rest,
      // COR-716: an agent that declares an input guardrail with an unverified-asset policy
      // holds media a `beforeGenerate` handler adds to the same policy, unless the caller
      // set `assetSafety` on the agent directly.
      ...(rest.assetSafety === undefined && runGuardrails?.input?.assetSafety !== undefined
        ? { assetSafety: runGuardrails.input.assetSafety }
        : {}),
      // The merged agent-tier plan built above, policy registrations included.
      ...(hooks === undefined ? {} : { hooks }),
      ...(createContextEpoch === undefined ? {} : { contextEpoch: createContextEpoch() }),
      // AB-21: `AgentRunContext` fields translate onto their `RunOptions`
      // equivalents — `agentName` stamps curated `tool.*` events (falling
      // back to this agent's own `name`), `signal` drives per-run abort,
      // `traceContext` is `RunOptions.parentContext` (the field this engine
      // already uses for the same concept), and `withTraceContext` forwards
      // unchanged.
      agentName: context?.agentName ?? resolvedName,
      // COR-1302 — a pre-assigned run id becomes this run's own id, so a
      // deferred handle wrapping this run reports the id the run does.
      ...(context?.runId !== undefined ? { runId: context.runId } : {}),
      ...(context?.signal ? { signal: context.signal } : {}),
      ...(context?.traceContext !== undefined ? { parentContext: context.traceContext } : {}),
      ...(context?.withTraceContext ? { withTraceContext: context.withTraceContext } : {}),
      // AB-233 — also thread `childRegistry` into `RunOptions` itself (not
      // just `createAgentRun`'s option below), so `run-step.ts` can hand it
      // to every tool call as `ToolContext.executionContext.childRegistry`.
      ...(context?.childRegistry ? { childRegistry: context.childRegistry } : {}),
      // AB-300 — thread `delegatedAuthority` into `RunOptions` itself, so
      // `run-step.ts` can hand it to every tool call as
      // `ToolContext.executionContext.delegatedAuthority`, exactly as
      // `childRegistry` does above.
      ...(context?.delegatedAuthority !== undefined
        ? { delegatedAuthority: context.delegatedAuthority }
        : {}),
      // AB-241 — `AgentRunContext.principal` forwards into `RunOptions.principal`
      // the same way `signal`/`traceContext` do above.
      ...(context?.principal !== undefined ? { principal: context.principal } : {}),
      // COR-1269 — `AgentRunContext.childCorrelation` forwards the same way, so
      // a child run's hook-plan observations name the parent-child pair that
      // dispatched it. Correlation only: it reaches the observer attachment in
      // `startRunLifecycle` and nothing else reads it.
      ...(context?.childCorrelation !== undefined
        ? { childCorrelation: context.childCorrelation }
        : {}),
      // COR-814 — `AgentRunContext.parentSignals` forwards into
      // `RunOptions.parentSignals`, so `run-step.ts` hands this run's own
      // port to every tool call as `ToolContext.executionContext.parentSignals`.
      ...(context?.parentSignals !== undefined ? { parentSignals: context.parentSignals } : {}),
    };
  }

  return {
    name: resolvedName,
    hasOutput: output !== undefined,
    ...(description === undefined ? {} : { description }),
    ...(examples === undefined ? {} : { examples: Object.freeze([...examples]) }),
    ...(skillDescriptors === undefined ? {} : { skillDescriptors }),
    generationProfile,
    // COR-1265 — omitted entirely rather than set to `undefined` when the
    // agent declares no hooks, so `'hooks' in agent` distinguishes "no tier"
    // from "a tier that happens to be empty".
    ...(agentHooks === undefined ? {} : { hooks: agentHooks }),
    // COR-1367 — omitted when not declared, matching `hooks` above.
    ...(declaredGuardrails === undefined ? {} : { guardrails: declaredGuardrails }),
    ...(skills === undefined ? {} : { skills }),
    // COR-1818 — omitted when undeclared or empty, matching `skills` above.
    ...(instructions === undefined || instructions === '' ? {} : { instructions }),
    toolNames,
    [OPERATIVE_RESOLVES_GUARDRAILS]: true,
    run(input: AgentInput, context?: AgentRunContext): AgentRun<unknown, boolean> {
      // AB-241 review finding: `createActiveRun` derives `LivenessSnapshot.owner`
      // exclusively from its third `dependencies.owner` argument, not from
      // `RunOptions.principal` — passing `principal` only into `RunOptions` (via
      // `buildRunOptions` above) left every direct-dispatch run's settled
      // snapshot reporting `owner: undefined` regardless of the supplied
      // principal, contradicting the promised branch-independent attribution.
      const runOptions = buildRunOptions(input, context);
      const activeRun = createActiveRun(
        runOptions,
        undefined,
        runOptions.principal !== undefined ? { owner: runOptions.principal } : undefined,
      );
      return createAgentRun<unknown, boolean>(activeRun, {
        hasOutput: output !== undefined,
        // AB-50 — opt-in: only present when the caller supplied one.
        ...(context?.childRegistry ? { childRegistry: context.childRegistry } : {}),
      });
    },
    // AB-21's definition-resolution protocol: resolves the same `RunOptions`
    // bag `run()` builds, without starting an in-memory run, so a durable
    // engine can drive it through `createActiveRun(options, durable)`
    // directly. Private/unstable — see `runnable-agent.ts`.
    [OPERATIVE_RESOLVE_RUN_OPTIONS](
      input: AgentInput,
      context?: AgentRunContext,
    ): Promise<RunOptions> {
      return Promise.resolve(buildRunOptions(input, context));
    },
  };
}
