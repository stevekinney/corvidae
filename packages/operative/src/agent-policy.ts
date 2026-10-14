/**
 * Per-agent guardrails and skills (COR-1367).
 *
 * `createAgent` owns these two policies the way it already owns its provider,
 * toolbox, stop conditions, step cap and instructions: declared once at
 * construction, applied to every run the agent starts, and travelling with the
 * agent's own `RunOptions` into whichever host dispatches it. The helpers here
 * are shared with Bureau so the two layers cannot drift into different
 * answers for the same configuration.
 */

import type { HookRegistry, RuntimeServices, TypedEventTarget } from '@lostgradient/lifecycle';
import {
  createSkillArtifactLoader,
  createSkillClient,
  createSkillClientToolbox,
  renderActiveSkillInstructions,
  renderClientCatalog,
  type SkillArtifactLoader,
  type SkillCatalogRevision,
  type SkillEventMap,
  type SkillGuardrailOptions,
} from '@lostgradient/skills';
import type { AnyToolbox } from 'armorer';
import { combineToolboxes, createToolbox } from 'armorer';

import type { ToolPolicy } from './create-policy-enforcement-hook';
import { createPolicyEnforcementHook } from './create-policy-enforcement-hook';
import { createGuardrails } from './guardrails/create-guardrails';
import { createDefaultGuardrailsPreset } from './guardrails/default-preset';
import type { GuardrailHooks, GuardrailsOptions } from './guardrails/types';
import type { OperativeHookMap } from './hooks';

/**
 * A guardrail declaration: a configuration to run, or `false` for none.
 * `undefined` everywhere it appears means "not declared at this layer".
 */
export type GuardrailsDeclaration = GuardrailsOptions | false;

/**
 * Per-agent skills, the `createAgent` counterpart of Bureau's deprecated
 * `BureauOptions.skills`.
 */
export interface AgentSkillsOptions {
  /**
   * The catalog revision this agent's runs see. A revision, not a set of
   * sources, for the reason `SkillRuntimeConfiguration.catalog` gives: a run's
   * skills are an immutable input, so discovery (and the decision about which
   * sources to trust) happens before the agent is built, with
   * `discoverSkills` from `@lostgradient/skills`.
   */
  catalog: SkillCatalogRevision;
  /**
   * Whether the model is handed `activate_skill`, `load_skill_resource` and
   * `deactivate_skill` and shown the catalog at step 0. Defaults to `true`.
   * `false` keeps the catalog out of the model's reach entirely; there is then
   * nothing that can activate a skill.
   */
  includeTools?: boolean | undefined;
  /**
   * Reads a catalog record's artifact. Defaults to
   * `createSkillArtifactLoader({})`, which follows filesystem sources only. A
   * catalog that includes `storage` records needs a loader built over that
   * store, which is what Bureau supplies for its own runs.
   */
  loadArtifact?: SkillArtifactLoader | undefined;
  /** Where skill lifecycle events are dispatched. Silence when omitted. */
  events?: TypedEventTarget<SkillEventMap> | undefined;
}

/**
 * Resolves the guardrails an agent's run applies.
 *
 * Precedence, most specific first: the agent's own declaration, then the
 * policy its host hands down through `AgentRunContext.inheritedGuardrails`,
 * then the AB-40 preset. `false` at whichever layer answers first means no
 * guardrails at all — an explicit opt-out is an answer, not an absence.
 *
 * Returns `undefined` for "no guardrails", so a caller narrows once.
 */
export function resolveAgentGuardrails(
  declared: GuardrailsDeclaration | undefined,
  inherited: GuardrailsDeclaration | undefined,
): GuardrailsOptions | undefined {
  const resolved = declared ?? inherited ?? createDefaultGuardrailsPreset();
  return resolved === false ? undefined : resolved;
}

/**
 * Carries a guardrail configuration onto the skill client and skill toolbox
 * (COR-1226): skill bodies and resources are untrusted instruction input, and
 * they reach the model through tool results rather than `prepareStep`, so they
 * are scanned directly and their detections folded back into the same
 * session-wide taint state the input guardrail reads.
 *
 * `undefined` when there is no input guardrail to carry. The taint wiring
 * mirrors `createGuardrails`'s own, including its confidence threshold.
 */
export function createSkillGuardrailOptions(
  configuration: GuardrailsOptions,
  guardrails: GuardrailHooks,
): SkillGuardrailOptions | undefined {
  const input = configuration.input;
  if (input === undefined) return undefined;
  return {
    detectors: input.detectors,
    ...(input.action !== undefined ? { action: input.action === 'warn' ? 'warn' : 'block' } : {}),
    getSessionTainted: () => guardrails.taint.isTainted(),
    onTriggered: (event) => {
      if (event.confidence >= (configuration.taint?.taintThreshold ?? 0.8)) {
        guardrails.taint.taint({
          reason: event.detail ?? `Detection by ${event.detector}`,
          detector: event.detector,
          confidence: event.confidence,
          step: 0,
          provenance: event.provenance,
        });
      }
      input.onTriggered?.(event);
    },
  };
}

/**
 * COR-1228 — narrows the tools a model sees to an active skill's
 * `allowed-tools`.
 *
 * A filter, not a per-call gate: `ToolPolicy` removes a tool before the model
 * learns it exists, and the per-call gate stays
 * `createHeadlessPermissionPolicyHooks`. The policy is read live on every
 * `tools()` call because the active set changes as the model activates and
 * deactivates skills, and a proxy keeps the toolbox's emitter, approval wiring
 * and request context untouched.
 */
export function withActiveSkillToolPolicy(
  toolbox: AnyToolbox,
  getActiveSkillToolPolicy: () => ToolPolicy | undefined,
): AnyToolbox {
  const filterTools = createPolicyEnforcementHook({ getActiveSkillToolPolicy });

  return new Proxy(toolbox, {
    get(target, property, receiver) {
      if (property === 'tools') {
        return () => filterTools([...target.tools()]);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/**
 * Priority placing an agent policy registration behind the agent's own hooks
 * on the same hook point.
 *
 * The input guardrail has to scan a step every other agent `prepareStep` hook
 * has already contributed to, and on the `validateResponse` waterfall the last
 * handler decides the response, so the output guardrail must not be overruled
 * by an ordinary agent hook. Far enough above `Number.MIN_SAFE_INTEGER` that
 * Bureau's own pinned-last registrations (`BUREAU_PINNED_LAST_PRIORITY` plus
 * its tier offset) still sort after these: under Bureau, Bureau's narrowing
 * keeps the final word.
 */
export const AGENT_POLICY_PINNED_LAST_PRIORITY = Number.MIN_SAFE_INTEGER + 100_000;

/** The ownership tier stamped on every registration this module makes. */
export const AGENT_POLICY_HOOK_SOURCE = 'agent';

/** Inputs for one run's policy composition. */
export interface ComposeAgentRunPolicyOptions {
  guardrails: GuardrailsOptions | undefined;
  skills: AgentSkillsOptions | undefined;
  toolbox: AnyToolbox;
  /** The run's hook plan. Policy registrations are added to it in place. */
  hooks: HookRegistry<OperativeHookMap>;
  agentName: string;
  runtime: RuntimeServices;
}

function registerGuardrails(
  hooks: HookRegistry<OperativeHookMap>,
  guardrails: GuardrailHooks,
): void {
  hooks.on('prepareStep', guardrails.prepareStep, {
    id: 'agent:guardrails-prepare-step',
    source: AGENT_POLICY_HOOK_SOURCE,
    priority: AGENT_POLICY_PINNED_LAST_PRIORITY,
    // Scans and may taint in-process session state; no external write.
    replay: 'safe',
  });
  hooks.on('validateResponse', guardrails.validateResponse, {
    id: 'agent:guardrails-validate-response',
    source: AGENT_POLICY_HOOK_SOURCE,
    priority: AGENT_POLICY_PINNED_LAST_PRIORITY,
    replay: 'safe',
  });
}

/**
 * Wires one run's skills: a fresh skill client bound to the agent's catalog,
 * the skill tools combined into the run's toolbox, the catalog shown at step
 * 0, the active instructions re-rendered every step, and the toolbox narrowed
 * by the active skills' tool policy. Returns the run's toolbox.
 */
function composeSkills(
  options: ComposeAgentRunPolicyOptions & { skills: AgentSkillsOptions },
  skillGuardrail: SkillGuardrailOptions | undefined,
): AnyToolbox {
  const { skills, hooks } = options;
  const client = createSkillClient({
    catalog: skills.catalog,
    loadArtifact: skills.loadArtifact ?? createSkillArtifactLoader({}),
    runtime: options.runtime,
    correlation: { agentName: options.agentName },
    ...(skillGuardrail === undefined ? {} : { guardrail: skillGuardrail }),
    ...(skills.events === undefined ? {} : { events: skills.events }),
  });

  let toolbox = options.toolbox;
  const toolset =
    skills.includeTools === false
      ? undefined
      : createSkillClientToolbox(
          client,
          skillGuardrail === undefined ? undefined : { guardrail: skillGuardrail },
        );
  // `undefined` for an empty catalog, so no skill tool is exposed at all: a
  // model handed `activate_skill` against nothing invents a name to pass it.
  if (toolset !== undefined) {
    hooks.on(
      'prepareStep',
      (context) => {
        if (context.step !== 0) return Promise.resolve();
        const rendered = renderClientCatalog(client);
        if (rendered !== undefined) {
          context.conversation.appendSystemMessage(rendered, { _skillCatalogInjected: true });
        }
        return Promise.resolve();
      },
      { id: 'agent:skill-client-catalog', source: AGENT_POLICY_HOOK_SOURCE, replay: 'safe' },
    );
    toolbox = combineToolboxes(
      toolbox,
      createToolbox([
        toolset.activateSkill,
        toolset.loadSkillResource,
        toolset.deactivateSkill,
      ]) as AnyToolbox,
    );
  }

  // Re-rendered every step rather than left in the transcript, so active
  // instructions survive a compaction strategy that rewrote the history.
  hooks.on(
    'prepareStep',
    (context) => {
      const instructions = renderActiveSkillInstructions(client.active());
      if (instructions !== undefined) {
        context.conversation.appendSystemMessage(instructions, { _skillContentInjected: true });
      }
      return Promise.resolve();
    },
    { id: 'agent:skill-client-instructions', source: AGENT_POLICY_HOOK_SOURCE, replay: 'safe' },
  );

  return withActiveSkillToolPolicy(toolbox, () => {
    const narrowed = client.narrowedTools();
    return narrowed === undefined ? undefined : { allowList: [...narrowed] };
  });
}

/**
 * Applies an agent's resolved guardrails and skills to one run.
 *
 * Called per run, never per agent: `createGuardrails` carries per-run taint
 * state and the skill client carries the run's active set, so sharing either
 * across runs would leak one run's detections or activations into another.
 * Registers into `options.hooks` in place and returns the run's toolbox, which
 * is `options.toolbox` itself when no skill tools are added.
 */
export function composeAgentRunPolicy(options: ComposeAgentRunPolicyOptions): AnyToolbox {
  const guardrails =
    options.guardrails === undefined ? undefined : createGuardrails(options.guardrails);
  const skillGuardrail =
    options.guardrails === undefined || guardrails === undefined
      ? undefined
      : createSkillGuardrailOptions(options.guardrails, guardrails);

  const toolbox =
    options.skills === undefined
      ? options.toolbox
      : composeSkills({ ...options, skills: options.skills }, skillGuardrail);

  // Registered after the skill hooks, and pinned behind every other agent
  // hook, so the input scan sees a step everything else already contributed to.
  if (guardrails !== undefined) registerGuardrails(options.hooks, guardrails);

  return toolbox;
}

/**
 * Marks an agent that resolves its guardrails itself and honors
 * `AgentRunContext.inheritedGuardrails` (COR-1367).
 *
 * A host reads it with {@link resolvesOwnGuardrails} to decide whether to hand
 * its policy down or to apply it itself: a `createAgent` agent carries the
 * marker, while a hand-written `RunnableAgent` or a `createLazyAgent` wrapper
 * (whose underlying agent is unknown until loaded) does not.
 */
export const OPERATIVE_RESOLVES_GUARDRAILS: unique symbol = Symbol.for(
  '@lostgradient/operative.resolvesGuardrails',
);

/** Whether `agent` resolves its own guardrails. See {@link OPERATIVE_RESOLVES_GUARDRAILS}. */
export function resolvesOwnGuardrails(agent: object): boolean {
  return Reflect.get(agent, OPERATIVE_RESOLVES_GUARDRAILS) === true;
}
