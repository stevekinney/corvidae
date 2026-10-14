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

import type { HookRegistry, RuntimeServices } from '@lostgradient/lifecycle';
import type { AnyToolbox } from 'armorer';

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
 * One run's slice of an agent's policy, handed to {@link AgentSkills.composeRun}.
 */
export interface AgentSkillsRun {
  /** The run's toolbox before skills: the agent's own tools, or its shared `toolbox`. */
  toolbox: AnyToolbox;
  /** The run's agent-tier hook plan. Skill hooks are registered on it in place. */
  hooks: HookRegistry<OperativeHookMap>;
  /** The run's stamped agent name, for skill event correlation. */
  agentName: string;
  /** The agent's resolved runtime services. */
  runtime: RuntimeServices;
  /**
   * The run's resolved guardrails — the configuration and the per-run hooks
   * built from it — so skill bodies and resources are scanned and fold their
   * detections into the same taint state (COR-1226). Absent when the run has
   * no guardrails.
   */
  guardrails?: { configuration: GuardrailsOptions; hooks: GuardrailHooks } | undefined;
}

/**
 * Per-agent skills (COR-1367) — the seam `createAgent`'s `skills` option
 * accepts, the per-agent counterpart of the deprecated `BureauOptions.skills`.
 *
 * Operative defines it and `@lostgradient/skills` implements it
 * (`createAgentSkills`), rather than operative importing the skills package:
 * operative is published to the registry and the skills package is a private
 * workspace, so a published operative never names it as a dependency.
 */
export interface AgentSkills {
  /**
   * Applies these skills to one run: registers whatever hooks they need on
   * `run.hooks` and returns the run's toolbox (`run.toolbox` itself when no
   * tools are added). Called once per run, so per-run state such as the active
   * skill set never crosses runs.
   */
  composeRun(run: AgentSkillsRun): AnyToolbox;
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
  skills: AgentSkills | undefined;
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

  const toolbox =
    options.skills === undefined
      ? options.toolbox
      : options.skills.composeRun({
          toolbox: options.toolbox,
          hooks: options.hooks,
          agentName: options.agentName,
          runtime: options.runtime,
          ...(options.guardrails === undefined || guardrails === undefined
            ? {}
            : { guardrails: { configuration: options.guardrails, hooks: guardrails } }),
        });

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
