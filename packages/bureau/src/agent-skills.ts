/**
 * Per-agent skills for `createAgent` (COR-1367).
 *
 * Operative defines the seam (`AgentSkills`) and Bureau implements it over its
 * skills subsystem (`./skills`). The subsystem never imports Operative
 * (`test/skills/boundaries.test.ts` forbids it), and Operative must not name a
 * private workspace, so the composition lives here.
 */

import type { TypedEventTarget } from '@lostgradient/lifecycle';
import type {
  AgentSkills,
  AgentSkillsRun,
  GuardrailHooks,
  GuardrailsOptions,
} from '@lostgradient/operative';
import { AGENT_POLICY_HOOK_SOURCE, withActiveSkillToolPolicy } from '@lostgradient/operative';
import type { AnyToolbox } from 'armorer';
import { createToolbox } from 'armorer';

import {
  availableRecords,
  createSkillArtifactLoader,
  createSkillClient,
  createSkillClientToolbox,
  renderActiveSkillInstructions,
  renderClientCatalog,
  type SkillArtifactLoader,
  type SkillCatalogRevision,
  type SkillEventMap,
  type SkillGuardrailOptions,
} from './skills';
import type { SkillClient } from './skills/client/skill-client';
import { withAddedTools, withToolboxLayer } from './toolbox-additions';

/**
 * The names of the skill lifecycle tools. An active skill's `allowed-tools` never narrows these
 * (COR-1633): a skill that left them out could neither deactivate itself nor load its own
 * resources for the rest of the run.
 */
const SKILL_LIFECYCLE_TOOL_NAMES: readonly string[] = [
  'activate_skill',
  'load_skill_resource',
  'deactivate_skill',
];

/**
 * The tool policy an active skill's `allowed-tools` imposes on a run: the narrowed tool names plus
 * the exact names of the skill lifecycle tools, or `undefined` when no active skill narrows. Both
 * Bureau policy builders (`createAgentSkills` and the runtime composition) call this on their
 * final list, so an attenuated client's grant is exempted the same way. The fail-closed policy
 * for unverifiable skill recovery does not pass through here and still refuses every tool.
 */
export function activeSkillToolPolicy(
  narrowed: readonly string[] | undefined,
): { allowList: string[] } | undefined {
  if (narrowed === undefined) return undefined;
  return { allowList: [...new Set([...narrowed, ...SKILL_LIFECYCLE_TOOL_NAMES])] };
}

/**
 * One run's skill client, as Bureau needs it to persist and recover the active set: the client
 * that owns the run's toolbox, the catalog revision it was built over, and the hook that makes the
 * first step wait for a recovery.
 */
export interface AgentSkillsRunHandle {
  readonly client: SkillClient;
  readonly catalog: SkillCatalogRevision;
  /**
   * Re-validates stored activation records against the live catalog. The run's first step waits
   * for it, so nothing reads a half-filled active set.
   */
  recover: SkillClient['recover'];
}

const runHandles = new WeakMap<object, AgentSkillsRunHandle>();

/**
 * The skill client a run's agent composed, found by the run's resolved hook plan
 * (`RunOptions.hooks`), or `undefined` when the agent has no skills. Bureau uses the agent's own
 * client rather than building a second one, because that client already owns the run's toolbox.
 */
export function agentSkillsRun(hooks: object | undefined): AgentSkillsRunHandle | undefined {
  return hooks === undefined ? undefined : runHandles.get(hooks);
}

const skillCatalogs = new WeakMap<object, SkillCatalogRevision>();

/**
 * The names of the executable skills an agent's `skills` value (`createAgent({ skills })`) makes
 * available: the available records of the catalog revision {@link createAgentSkills} was given,
 * ordered by name. Empty for an agent with no skills, and for a `skills` value that did not come
 * from {@link createAgentSkills}, whose catalog Bureau cannot read. An unavailable skill (an
 * untrusted source, say) is not named: the agent cannot activate it.
 */
export function agentSkillNames(skills: object | undefined): readonly string[] {
  const catalog = skills === undefined ? undefined : skillCatalogs.get(skills);
  return catalog === undefined ? [] : availableRecords(catalog).map((record) => record.name);
}

/** Options for {@link createAgentSkills}. */
export interface AgentSkillsOptions {
  /**
   * The catalog revision this agent's runs see. A revision, not a set of
   * sources: a run's skills are an immutable input, so discovery (and the
   * decision about which sources to trust) happens before the agent is built,
   * with {@link discoverSkills}.
   */
  readonly catalog: SkillCatalogRevision;
  /**
   * The host's catalog as it is now, read each time a skill is used (COR-1926). It narrows what
   * {@link catalog} offered and never widens it: a run holding this revision is refused a skill
   * the current catalog no longer trusts at its next use, including a run that started before the
   * change. See `CreateSkillClientOptions.currentCatalog`.
   */
  readonly currentCatalog?: (() => SkillCatalogRevision) | undefined;
  /**
   * Whether the model is handed `activate_skill`, `load_skill_resource` and
   * `deactivate_skill` and shown the catalog at step 0. Defaults to `true`.
   * `false` keeps the catalog out of the model's reach, so nothing can
   * activate a skill.
   */
  readonly includeTools?: boolean | undefined;
  /**
   * Reads a catalog record's artifact. Defaults to
   * `createSkillArtifactLoader({})`, which follows filesystem sources only; a
   * catalog with `storage` records needs a loader built over that store.
   */
  readonly loadArtifact?: SkillArtifactLoader | undefined;
  /** Where skill lifecycle events are dispatched. Silence when omitted. */
  readonly events?: TypedEventTarget<SkillEventMap> | undefined;
}

/**
 * Carries a run's guardrail configuration onto the skill client and skill
 * toolbox (COR-1226): skill bodies and resources are untrusted instruction
 * input that reaches the model through tool results rather than
 * `prepareStep`, so it is scanned directly and its detections are folded back
 * into the same session-wide taint state the input guardrail reads.
 *
 * `undefined` when there is no input guardrail to carry. The taint wiring
 * mirrors operative's `createGuardrails`, including its confidence threshold.
 * Shared by Bureau's own runs and {@link createAgentSkills}.
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
 * Builds the `skills` value for `createAgent`.
 *
 * Each run gets a fresh skill client bound to `options.catalog` — the client
 * carries the run's active set, so sharing one across runs would leak one
 * run's activations into another. The catalog is shown at step 0, the skill
 * tools join the run's toolbox, the active instructions are re-rendered every
 * step (so they survive a compaction that rewrote the history), and an active
 * skill's `allowed-tools` narrows the tools the model sees. Skill content is
 * scanned by the agent's own resolved guardrails.
 *
 * Active skills survive a durable recovery (COR-323): the run's client is
 * registered against its hook plan ({@link agentSkillsRun}), and when Bureau
 * dispatches the run into a session it snapshots the client's activation
 * records after every step and, on a recovered run, re-validates the stored
 * records against the live catalog before the first step reads the active set.
 * A run outside a Bureau session (a bare `agent.run()`) has no session to
 * snapshot into and starts with an empty active set.
 */
export function createAgentSkills(options: AgentSkillsOptions): AgentSkills {
  const skills: AgentSkills = {
    composeRun(run: AgentSkillsRun): AnyToolbox {
      const skillGuardrail =
        run.guardrails === undefined
          ? undefined
          : createSkillGuardrailOptions(run.guardrails.configuration, run.guardrails.hooks);
      const client = createSkillClient({
        catalog: options.catalog,
        ...(options.currentCatalog === undefined ? {} : { currentCatalog: options.currentCatalog }),
        loadArtifact: options.loadArtifact ?? createSkillArtifactLoader({}),
        runtime: run.runtime,
        correlation: { agentName: run.agentName },
        ...(skillGuardrail === undefined ? {} : { guardrail: skillGuardrail }),
        ...(options.events === undefined ? {} : { events: options.events }),
      });

      let recovery: ReturnType<SkillClient['recover']> | undefined;
      runHandles.set(run.hooks, {
        client,
        catalog: options.catalog,
        recover: (records) => {
          recovery = client.recover(records);
          return recovery;
        },
      });

      let toolbox = run.toolbox;
      const toolset =
        options.includeTools === false
          ? undefined
          : createSkillClientToolbox(
              client,
              skillGuardrail === undefined ? undefined : { guardrail: skillGuardrail },
            );
      // `undefined` for an empty catalog, so no skill tool is exposed at all: a
      // model handed `activate_skill` against nothing invents a name to pass it.
      if (toolset !== undefined) {
        run.hooks.on(
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
        toolbox = withAddedTools(
          toolbox,
          createToolbox([
            toolset.activateSkill,
            toolset.loadSkillResource,
            toolset.deactivateSkill,
          ]) as AnyToolbox,
        );
      }

      run.hooks.on(
        'prepareStep',
        async (context) => {
          if (recovery !== undefined) await recovery;
          const instructions = renderActiveSkillInstructions(client.active());
          if (instructions !== undefined) {
            context.conversation.appendSystemMessage(instructions, { _skillContentInjected: true });
          }
        },
        {
          id: 'agent:skill-client-instructions',
          source: AGENT_POLICY_HOOK_SOURCE,
          replay: 'safe',
        },
      );

      const policy = () => activeSkillToolPolicy(client.narrowedTools());
      return withToolboxLayer(toolbox, (rebuilt) => withActiveSkillToolPolicy(rebuilt, policy));
    },
  };
  skillCatalogs.set(skills, options.catalog);
  return skills;
}
