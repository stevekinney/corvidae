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
import { combineToolboxes, createToolbox } from 'armorer';

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
} from './skills';

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
 * Active skills are not persisted across a durable recovery on this path: a
 * catalog-dispatched run has no Bureau session to snapshot them into, so a
 * recovered run starts with an empty active set and the model re-activates
 * what it needs.
 */
export function createAgentSkills(options: AgentSkillsOptions): AgentSkills {
  return {
    composeRun(run: AgentSkillsRun): AnyToolbox {
      const skillGuardrail =
        run.guardrails === undefined
          ? undefined
          : createSkillGuardrailOptions(run.guardrails.configuration, run.guardrails.hooks);
      const client = createSkillClient({
        catalog: options.catalog,
        loadArtifact: options.loadArtifact ?? createSkillArtifactLoader({}),
        runtime: run.runtime,
        correlation: { agentName: run.agentName },
        ...(skillGuardrail === undefined ? {} : { guardrail: skillGuardrail }),
        ...(options.events === undefined ? {} : { events: options.events }),
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
        toolbox = combineToolboxes(
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
        (context) => {
          const instructions = renderActiveSkillInstructions(client.active());
          if (instructions !== undefined) {
            context.conversation.appendSystemMessage(instructions, { _skillContentInjected: true });
          }
          return Promise.resolve();
        },
        {
          id: 'agent:skill-client-instructions',
          source: AGENT_POLICY_HOOK_SOURCE,
          replay: 'safe',
        },
      );

      return withActiveSkillToolPolicy(toolbox, () => {
        const narrowed = client.narrowedTools();
        return narrowed === undefined ? undefined : { allowList: [...narrowed] };
      });
    },
  };
}
