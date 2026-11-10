/**
 * A built-in agent with its saved overrides in force (COR-2009).
 *
 * A built-in agent is a code agent the host defines, and what a person changes on it is saved as
 * overrides over what it states about itself (`agent-override-store.ts`). The newest version is
 * the overrides in force, and {@link effectiveCodeAgent} is the agent a run of it gets: the code
 * agent itself when nothing is overridden, and otherwise an agent that resolves the code agent's
 * own run options and then applies each override to them, so every way a run starts (a chat, a
 * task, a schedule, a child, a workflow step, a recovered run) runs under the same settings.
 *
 * Each override replaces the agent's own value:
 *
 * - `instructions` is the system message a run starts with.
 * - `tools`, `approvals` and `limits.tools` build the run's toolbox the way an agent file's is
 *   built: from the allowed tools (the agent's own, found in the toolbox its definition resolves
 *   to, and the deployment's tool catalog), asked as `approvals` says (a tool it does not list
 *   takes the default, `on-changes`, so a tool is never let through unasked because nothing was
 *   said), counted by `limits.tools`, and signed with the Bureau's agent approval secret. The code
 *   agent's own toolbox options do not carry over, because a toolbox does not expose them: once
 *   any of the three is overridden, the overrides say how every allowed tool asks. A tool the
 *   run's own composition added to that toolbox (a skill tool) is kept as it was.
 * - `model` is the default model, `models` the models a chat may be switched to, and
 *   `effort` the effort a step is sent when its steering names none. They are applied by the
 *   generate a file agent runs with, so the model policy is read at each step.
 * - `limits.cost` is what one run, and one chat, may spend; `limits.steps` is the most steps one run
 *   may take.
 * - `guardrails` are plugin guardrails added to the agent's own. An override cannot remove a
 *   guardrail the code agent declares itself.
 * - `interceptors` are plugin interceptors (`plugin:name`, COR-2253) added to the agent's own hook
 *   tier for the run, as an agent file's `interceptors` are, so the plugin's needs-setup refusal
 *   applies to a run that chose them, and an every-agent set the override also lists registers
 *   once (`run-hook-tiers.ts` leaves it out of the plugin tier). Each is built from the
 *   contributions at the run, so one a plugin no longer contributes is skipped.
 *
 * A code agent that cannot resolve its run options (one with no `OPERATIVE_RESOLVE_RUN_OPTIONS`)
 * has nothing the overrides can be applied to, and runs as it is.
 *
 * @module code-agent-effective
 */

import { HookRegistry, type RuntimeServices } from '@lostgradient/lifecycle';
import {
  AGENT_POLICY_HOOK_SOURCE,
  AGENT_POLICY_PINNED_LAST_PRIORITY,
  type AgentGenerationProfile,
  type AgentInput,
  type AgentRunContext,
  type BackendDescriptor,
  createActiveRun,
  createAgentRun,
  createDeferredAgentRun,
  createGuardrails,
  type GenerateFunction,
  hasDefinitionResolver,
  isConversationInput,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type OperativeHookMap,
  readGenerationProfile,
  resolveAgentGuardrails,
  type RunOptions,
  toolIdentityUnderKey,
} from '@lostgradient/operative';
import {
  type AnyToolbox,
  createToolbox,
  formatToolName,
  type Tool,
  type ToolConfiguration,
  type ToolSecretResolver,
} from 'armorer';
import { Conversation, replaceSystemMessage } from 'conversationalist';

import type { AnyRunnableAgent } from './agent-catalog';
import {
  type AgentContributions,
  guardrailAdditionsOf,
  interceptorsOf,
} from './agent-contributions';
import { allowedDescriptorsOfFileAgent, resolveModelDescriptor } from './agent-file-catalog';
import { describeAgentModels } from './agent-models';
import type { AgentOverrides } from './agent-override-store';
import { costBudgetOptions, runCostBudgetOf, toolboxBudgetOf } from './file-agent-cost-budget';
import { createFileAgentGenerate, type FileAgentGenerateOptions } from './file-agent-generate';
import { type BureauModelPolicyOptions, modelPolicyDenialOf } from './model-policy';
import { createToolApprovalHooks } from './tool-approval';

/** What the deployment lends a built-in agent's overrides when they are applied to a run. */
export interface EffectiveCodeAgentDeployment {
  /** The deployment's model catalog as it is now. */
  readonly descriptors: () => readonly BackendDescriptor[];
  /** The model policy as it is now, read at each step a model override runs. */
  readonly modelPolicy: () => BureauModelPolicyOptions | undefined;
  /**
   * Turns a catalog row into the generate a run calls. Without it no generate can be built for a
   * model, so `model`, `models` and `effort` leave the agent's own generate in place.
   */
  readonly resolveGenerate?: ((row: BackendDescriptor) => GenerateFunction) | undefined;
  /**
   * The deployment's tool catalog by the name an override lists a tool under. Omitted, an override
   * may allow only the agent's own tools.
   */
  readonly toolCatalog?: (() => Readonly<Record<string, Tool>>) | undefined;
  /**
   * The plugin guardrails and interceptors a `guardrails` or `interceptors` override may name.
   * Omitted, none resolves.
   */
  readonly contributions?: AgentContributions | undefined;
  /** The secret that signs the approvals a rebuilt toolbox raises; unsigned without one. */
  readonly approvalSecret?: string | undefined;
  /** Resolves the secrets a rebuilt toolbox's tools ask for. */
  readonly secretResolver?: ToolSecretResolver | undefined;
  /** What to do with a step whose model cannot do `effort`; see the file agent generate. */
  readonly effortFallbackMode?: FileAgentGenerateOptions['effortFallbackMode'];
  /** The Bureau's services, whose clock a deferred run reads before its options resolve. */
  readonly runtime?: RuntimeServices | undefined;
}

/** Whether `overrides` overrides anything at all. */
export function hasAgentOverrides(overrides: AgentOverrides): boolean {
  return Object.values(overrides).some((value) => value !== undefined);
}

const GENERATE_KEYS = ['model', 'models', 'effort'] as const;

/** The name a call reports `configuration` by, and the name it was registered under. */
function namesOf(configuration: ToolConfiguration): readonly string[] {
  return [configuration.name, formatToolName(configuration.identity)];
}

/** `tool`'s configuration under `key`, as `createAgent` registers a tool under its `tools` key. */
function configurationUnderKey(key: string, tool: Tool): ToolConfiguration {
  const { namespace, name } = toolIdentityUnderKey(key, tool);
  if (name === key) return { ...tool.configuration, name: key };
  const { version } = tool.configuration.identity;
  return {
    ...tool.configuration,
    name,
    identity: { namespace, name, ...(version === undefined ? {} : { version }) },
  };
}

/** The models the overrides leave the agent with: its default row and the rows it may switch to. */
interface EffectiveModels {
  readonly defaultRow: BackendDescriptor | undefined;
  readonly allowed: readonly BackendDescriptor[];
}

function sameRow(
  left: { readonly provider: string; readonly model: string },
  right: { readonly provider: string; readonly model: string },
): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function effectiveModelsOf(
  agent: AnyRunnableAgent,
  overrides: AgentOverrides,
  descriptors: readonly BackendDescriptor[],
): EffectiveModels {
  const own = describeAgentModels(agent, descriptors);
  const rowOf = (choice: { readonly provider: string; readonly model: string } | null) =>
    choice === null ? undefined : descriptors.find((row) => sameRow(row, choice));
  const named =
    overrides.model === undefined
      ? undefined
      : resolveModelDescriptor(overrides.model, descriptors);
  // A model the catalog no longer holds leaves the agent's own default in place.
  const defaultRow = named !== undefined && 'provider' in named ? named : rowOf(own.default);
  const listed =
    overrides.models === undefined
      ? own.models.flatMap((choice) => rowOf(choice) ?? [])
      : allowedDescriptorsOfFileAgent(overrides.models, descriptors);
  const allowed =
    defaultRow === undefined || listed.some((row) => sameRow(row, defaultRow))
      ? listed
      : overrides.model === undefined && listed.length === 0
        ? listed
        : [defaultRow, ...listed];
  return { defaultRow, allowed };
}

/**
 * The generation profile a run and the catalog read for the agent: the code agent's own, or, when
 * `model` or `models` is overridden, a selectable one over the effective default and switchable
 * models. The revision stays the code agent's, so a recorded run still names the definition it
 * started under.
 */
function profileOf(
  agent: AnyRunnableAgent,
  overrides: AgentOverrides,
  models: EffectiveModels,
): AgentGenerationProfile {
  const own = readGenerationProfile(agent);
  if (overrides.model === undefined && overrides.models === undefined) return own;
  return Object.freeze({
    ...own,
    mode: models.allowed.length > 0 ? 'selectable' : own.mode,
    descriptors: Object.freeze(
      models.defaultRow === undefined ? own.descriptors : [models.defaultRow],
    ),
    allowedCandidates: Object.freeze(
      models.allowed.map((row) => Object.freeze({ provider: row.provider, model: row.model })),
    ),
  });
}

/**
 * The code agent `agent` with `overrides` in force, or `agent` itself when nothing is overridden or
 * it cannot resolve its run options. See the module comment for what each override does.
 */
export function effectiveCodeAgent(
  agent: AnyRunnableAgent,
  overrides: AgentOverrides,
  deployment: EffectiveCodeAgentDeployment,
): AnyRunnableAgent {
  if (!hasAgentOverrides(overrides) || !hasDefinitionResolver(agent)) return agent;
  const resolveOwn = agent[OPERATIVE_RESOLVE_RUN_OPTIONS].bind(agent);
  const descriptors = deployment.descriptors();
  const models = effectiveModelsOf(agent, overrides, descriptors);
  const generationProfile = profileOf(agent, overrides, models);
  const ownToolNames = (agent as { readonly toolNames?: unknown }).toolNames;
  const ownNames: readonly string[] =
    Array.isArray(ownToolNames) && ownToolNames.every((name) => typeof name === 'string')
      ? ownToolNames
      : [];
  const toolNames = Object.freeze([...(overrides.tools ?? ownNames)]);

  function generateOf(own: GenerateFunction): GenerateFunction {
    const { resolveGenerate } = deployment;
    if (
      resolveGenerate === undefined ||
      GENERATE_KEYS.every((key) => overrides[key] === undefined)
    ) {
      return own;
    }
    const { defaultRow, allowed } = models;
    const common = {
      allowed: () => allowed,
      resolveGenerate,
      costBudgeted: overrides.limits?.cost !== undefined,
      policyDenial: (row: BackendDescriptor) => modelPolicyDenialOf(row, deployment.modelPolicy()),
      defaultEffort: overrides.effort,
      effortFallbackMode: deployment.effortFallbackMode,
    };
    if (defaultRow !== undefined) {
      return createFileAgentGenerate({
        ...common,
        defaultGenerate: overrides.model === undefined ? own : resolveGenerate(defaultRow),
        defaultDescriptor: defaultRow,
      });
    }
    // An agent that states no model of its own keeps its generate for a step nobody steered; a
    // steered step runs the model it names, among the ones the overrides allow.
    const [first] = allowed;
    if (first === undefined) return own;
    const switching = createFileAgentGenerate({
      ...common,
      defaultGenerate: (context) => resolveGenerate(first)(context),
      defaultDescriptor: first,
    });
    return (context) => (context.steering?.model === undefined ? own(context) : switching(context));
  }

  function toolboxOf(own: AnyToolbox): AnyToolbox {
    // `limits.steps` and `limits.cost` are not the toolbox's: only the tools, how they ask, and the
    // tool limit rebuild it.
    if (
      overrides.tools === undefined &&
      overrides.approvals === undefined &&
      overrides.limits?.tools === undefined
    ) {
      return own;
    }
    const configurations = own.toJSON();
    const ownOf = (name: string) =>
      ownNames.includes(name)
        ? configurations.find((configuration) => namesOf(configuration).includes(name))
        : undefined;
    const catalog = deployment.toolCatalog?.() ?? {};
    const governed: Record<string, Pick<Tool, 'configuration'>> = {};
    const entries: ToolConfiguration[] = [];
    for (const name of toolNames) {
      const found = ownOf(name);
      const tool = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
      const configuration =
        found ?? (tool === undefined ? undefined : configurationUnderKey(name, tool));
      // A tool the deployment no longer holds is not offered; the save that named it was checked.
      if (configuration === undefined) continue;
      entries.push(configuration);
      governed[name] = { configuration };
    }
    // What the run's own composition added to the agent's toolbox, such as the skill tools.
    const ownConfigurations = new Set(ownNames.flatMap((name) => ownOf(name) ?? []));
    for (const configuration of configurations) {
      if (!ownConfigurations.has(configuration)) entries.push(configuration);
    }
    return createToolbox(entries, {
      policy: createToolApprovalHooks(overrides.approvals, { tools: governed }),
      ...(overrides.limits?.tools === undefined
        ? {}
        : { budget: toolboxBudgetOf(overrides.limits.tools) }),
      ...(deployment.approvalSecret === undefined
        ? {}
        : { approvalSecret: deployment.approvalSecret }),
      ...(deployment.secretResolver === undefined
        ? {}
        : { secretResolver: deployment.secretResolver }),
    });
  }

  function conversationOf(
    input: AgentInput,
    conversation: RunOptions['conversation'],
  ): RunOptions['conversation'] {
    // A run handed a conversation starts from it as it is; only a fresh one gets the instructions.
    if (overrides.instructions === undefined || isConversationInput(input)) return conversation;
    if (conversation instanceof Conversation) {
      conversation.replaceSystemMessage(overrides.instructions);
      return conversation;
    }
    return replaceSystemMessage(conversation, overrides.instructions);
  }

  /**
   * The agent's hooks with the interceptors the override names registered in the same tier
   * (COR-2253). `own` is the registry the agent resolved for this run, so what is added reaches this
   * run only; an entry `own` already holds under the same id is left alone.
   */
  function withInterceptors(own: RunOptions['hooks']): RunOptions['hooks'] {
    if (overrides.interceptors === undefined || deployment.contributions === undefined) return own;
    const chosen = interceptorsOf(
      { interceptors: overrides.interceptors },
      deployment.contributions,
    );
    if (chosen === undefined) return own;
    const hooks = own ?? new HookRegistry<OperativeHookMap>();
    const held = new Set(
      hooks.getHookNames().flatMap((name) => hooks.getHandlers(name).map((entry) => entry.id)),
    );
    for (const name of chosen.getHookNames()) {
      for (const entry of chosen.getHandlers(name)) {
        if (held.has(entry.id)) continue;
        hooks.on(name, entry.handler, { ...entry.options, id: entry.id });
      }
    }
    return hooks;
  }

  function hooksOf(agentHooks: RunOptions['hooks']): RunOptions['hooks'] {
    const own = withInterceptors(agentHooks);
    // COR-2118: a configured guardrail is built for this run from the override's configuration. A
    // save checks it against the guardrail's schema; one a plugin's later schema no longer accepts
    // throws here, so the run fails to start rather than run without a guardrail it chose.
    const additions =
      overrides.guardrails === undefined || deployment.contributions === undefined
        ? undefined
        : guardrailAdditionsOf({ guardrails: overrides.guardrails }, deployment.contributions);
    if (additions === undefined) return own;
    // The additions alone, as a tripwire beside the agent's own guardrails, which already run.
    const configuration = resolveAgentGuardrails(false, undefined, additions);
    if (configuration === undefined) return own;
    const guardrails = createGuardrails(configuration);
    const hooks = own ?? new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', guardrails.prepareStep, {
      id: 'agent:override-guardrails-prepare-step',
      source: AGENT_POLICY_HOOK_SOURCE,
      priority: AGENT_POLICY_PINNED_LAST_PRIORITY,
      replay: 'safe',
    });
    hooks.on('validateToolResult', guardrails.validateToolResult, {
      id: 'agent:override-guardrails-validate-tool-result',
      source: AGENT_POLICY_HOOK_SOURCE,
      priority: AGENT_POLICY_PINNED_LAST_PRIORITY,
      replay: 'safe',
    });
    hooks.on('validateResponse', guardrails.validateResponse, {
      id: 'agent:override-guardrails-validate-response',
      source: AGENT_POLICY_HOOK_SOURCE,
      priority: AGENT_POLICY_PINNED_LAST_PRIORITY,
      replay: 'safe',
    });
    // COR-2104 — the tool-call validators the override names.
    hooks.on('beforeToolExecution', guardrails.beforeToolExecution, {
      id: 'agent:override-guardrails-before-tool-execution',
      source: AGENT_POLICY_HOOK_SOURCE,
      priority: AGENT_POLICY_PINNED_LAST_PRIORITY,
      replay: 'safe',
    });
    return hooks;
  }

  function costOf(): Pick<RunOptions, 'costBudget' | 'costEstimation'> | Record<string, never> {
    const budget = overrides.limits?.cost;
    if (budget === undefined) return {};
    return models.defaultRow === undefined
      ? { costBudget: runCostBudgetOf(budget) }
      : costBudgetOptions(budget, models.defaultRow, models.allowed);
  }

  async function resolve(input: AgentInput, context?: AgentRunContext): Promise<RunOptions> {
    const own = await resolveOwn(input, context);
    const hooks = hooksOf(own.hooks);
    return {
      ...own,
      generate: generateOf(own.generate),
      toolbox: toolboxOf(own.toolbox),
      conversation: conversationOf(input, own.conversation),
      ...(hooks === undefined ? {} : { hooks }),
      ...costOf(),
      ...(overrides.limits?.steps === undefined ? {} : { maximumSteps: overrides.limits.steps }),
    };
  }

  /** Starts a run on options that have resolved, as `createAgent`'s own `run()` does. */
  function startOn(options: RunOptions, context: AgentRunContext | undefined) {
    const activeRun = createActiveRun(
      options,
      undefined,
      options.principal === undefined ? undefined : { owner: options.principal },
    );
    return createAgentRun<unknown, boolean>(activeRun, {
      hasOutput: agent.hasOutput,
      ...(context?.childRegistry === undefined ? {} : { childRegistry: context.childRegistry }),
    });
  }

  const effective = {
    ...agent,
    toolNames,
    generationProfile,
    ...(overrides.instructions === undefined ? {} : { instructions: overrides.instructions }),
    [OPERATIVE_RESOLVE_RUN_OPTIONS]: resolve,
    run(input: AgentInput, context?: AgentRunContext) {
      // The options resolve asynchronously, so the handle is returned at once and the run starts
      // behind it, as a lazy agent's does.
      return createDeferredAgentRun(
        async () => {
          const options = await resolve(input, context);
          return { ...effective, run: () => startOn(options, context) } as AnyRunnableAgent;
        },
        input,
        context,
        agent.name,
        ...(deployment.runtime === undefined ? [] : [deployment.runtime]),
      );
    },
  };
  return effective;
}
