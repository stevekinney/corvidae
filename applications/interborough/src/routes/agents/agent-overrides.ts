/**
 * A code agent's page edits overrides, not a file (COR-2229). A built-in agent the host defines and
 * a running plugin's agent have no file, so what a person changes on their Settings and Access tabs
 * is saved as a numbered version of overrides over what the agent states itself
 * (`bureau.agents.overrides.get` and `.update`), and Restore writes one back
 * (`bureau.agents.versions.restore`). The Bureau states only the agent's own tools, its own
 * instructions, model and models (already with the overrides applied), and the overrides
 * themselves; the agent's own effort, step limit, approvals, guardrails and spend limit are not on
 * the wire, so those controls show what is overridden and nothing else.
 *
 * The tabs are the file agent's own components, not forks of them. They are given the agent as a
 * definition (`overridableDetail`: the agent's statement with the overrides applied, under the
 * hash of the overrides), and a writer that turns the definition they write back into overrides
 * (`AgentOverridesBinding`). A save sends the whole set (`overrides.update` replaces the set in
 * force), so each writer sends every override as last read or written and changes only the keys of
 * its own tab, and only those the person changed: a key left alone keeps the override it had, which
 * is none for an agent nobody has changed, so the agent's own value keeps applying and a later
 * change to it, in a newer plugin version, still reaches the agent.
 *
 * "Changed" is judged against what the tab itself was filled with, or last wrote, which the tab
 * passes with each write (`filled`), never against a copy this binding keeps: a form fills from the
 * Bureau's definition and overrides together, and the two reads can land apart, or the tab can
 * mount again after a write, so a copy of the binding's own could disagree with what the person
 * saw, and a field they never touched would count as changed.
 */
import { HttpClientError } from '@lostgradient/weft';

import {
  updateAgentOverrides,
  type AgentDefinitionInput,
  type AgentDetail,
  type AgentOverridesInput,
  type AgentOverridesState,
  type AgentWriteResult,
} from '../../lib/agent-definitions.ts';

/** The definition of an agent as the tabs read it. */
type Definition = NonNullable<AgentDetail['definition']>;

/** Which tab writes: Settings owns its model, models, effort, step limit and instructions; Access the rest. */
export type OverridesTab = 'settings' | 'access';

/**
 * Whether the page can change the agent through overrides: a code agent the catalog runs, which is
 * one that is ready and states itself. A plugin's agent that is unavailable is only read.
 */
export function isOverridable(detail: AgentDetail | undefined): boolean {
  return detail?.source === 'code' && detail.state === 'ready' && detail.codeDefinition !== null;
}

/**
 * The agent as a definition, with its overrides applied: what the tabs show and fill their forms
 * from. The tools are the overrides' or, with none, the agent's own; the instructions, model and
 * models the Bureau already states with the overrides applied; every other key is the override
 * or, with none, empty, because the agent's own value is not on the wire.
 */
export function overridesDefinition(detail: AgentDetail, state: AgentOverridesState): Definition {
  const code = detail.codeDefinition;
  const { overrides } = state;
  return {
    name: code?.name ?? detail.name,
    description: code?.description ?? detail.description,
    model: overrides.model ?? code?.model ?? '',
    models:
      (overrides.models ?? code?.models ?? []).length === 0
        ? null
        : [...(overrides.models ?? code?.models ?? [])],
    effort: overrides.effort,
    tools: [...(overrides.tools ?? state.ownTools)],
    card: code?.card ?? [],
    skills: code === null || code.skills.length === 0 ? null : [...code.skills],
    children: null,
    a2a: detail.a2a,
    limits: {
      steps: overrides.limits?.steps ?? null,
      cost: overrides.limits?.cost ?? null,
      tools: overrides.limits?.tools ?? null,
    },
    retry: null,
    compaction: null,
    interceptors: overrides.interceptors,
    references: null,
    guardrails: overrides.guardrails,
    approvals: overrides.approvals,
    from: null,
    instructions: overrides.instructions ?? code?.instructions ?? '',
  };
}

/**
 * The agent as the file agent's tabs take it: a definition under the hash of the overrides, so a
 * write names the hash the Bureau holds, and a Restore does too. It is shown as a file because the
 * tabs' forms are the file agent's; nothing else reads it.
 */
export function overridableDetail(detail: AgentDetail, state: AgentOverridesState): AgentDetail {
  return {
    ...detail,
    source: 'file',
    hash: state.hash,
    definition: overridesDefinition(detail, state),
  };
}

/**
 * Writes what a tab changed: the hash the tab holds, the definition it writes, and the definition
 * it was filled with, or last wrote, which is what counts as no change.
 */
export type OverridesWriter = (
  expectedHash: string,
  definition: AgentDefinitionInput,
  filled: AgentDefinitionInput,
) => Promise<AgentWriteResult>;

/** The keys of a definition a tab owns, as the overrides they become. */
interface Owned {
  readonly instructions: string;
  readonly model: string;
  readonly models: readonly string[] | null;
  readonly effort: Definition['effort'];
  readonly steps: number | null;
  readonly tools: readonly string[];
  readonly approvals: Definition['approvals'];
  readonly guardrails: Definition['guardrails'];
  readonly cost: Definition['limits']['cost'];
}

/** Every key a tab owns, in the order a write considers them. */
const OWNED_KEYS = [
  'instructions',
  'model',
  'models',
  'effort',
  'steps',
  'tools',
  'approvals',
  'guardrails',
  'cost',
] as const satisfies readonly (keyof Owned)[];

/**
 * The values of `definition` that `tab` writes, each a copy: the tab owns the definition it passed
 * (its tools and approvals are its live state), and a later change must not reach what was read
 * here. A key the definition leaves out is `undefined`, which a write never changes.
 */
function ownedBy(
  tab: OverridesTab,
  definition: AgentDefinitionInput,
): { readonly [Key in keyof Owned]?: Owned[Key] | undefined } {
  if (tab === 'settings') {
    const models = definition.models ?? null;
    return {
      instructions: definition.instructions,
      model: definition.model,
      models: models === null || models.length === 0 ? null : [...models],
      effort: definition.effort,
      steps: definition.limits?.steps,
    };
  }
  const { approvals, guardrails } = definition;
  return {
    tools: [...definition.tools],
    approvals: approvals === undefined || approvals === null ? approvals : { ...approvals },
    guardrails: guardrails === undefined || guardrails === null ? guardrails : [...guardrails],
    cost: definition.limits?.cost === undefined ? undefined : copyOfCost(definition.limits.cost),
  };
}

/** A spend limit as the definition holds it, with its `warn` fractions copied. */
function copyOfCost(cost: NonNullable<AgentDefinitionInput['limits']>['cost']): Owned['cost'] {
  if (cost === undefined || cost === null) return null;
  return {
    run: cost.run,
    ...(cost.chat === undefined ? {} : { chat: cost.chat }),
    ...(cost.warn === undefined ? {} : { warn: [...cost.warn] }),
  };
}

/** Whether two values are the same, a key a definition leaves out being the same as one that is `null`. */
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** A set of overrides as it is built for the next save: every key can be set or taken away. */
type OverridesDraft = { -readonly [Key in keyof AgentOverridesInput]: AgentOverridesInput[Key] };

/** The limits of a set of overrides, as built for the next save. */
type LimitsDraft = {
  -readonly [Key in keyof NonNullable<AgentOverridesInput['limits']>]: NonNullable<
    AgentOverridesInput['limits']
  >[Key];
};

/** Sets `key` of `target` to `value`, or takes the key away for `null`, `undefined` and an empty text. */
function assign<Target extends object, Key extends keyof Target>(
  target: Target,
  key: Key,
  value: Target[Key] | null | undefined,
): void {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

/** The keys of a set of overrides, which a save drops when they hold nothing. */
const OVERRIDE_KEYS = [
  'instructions',
  'tools',
  'approvals',
  'guardrails',
  'interceptors',
  'escalations',
  'limits',
  'model',
  'models',
  'effort',
] as const satisfies readonly (keyof AgentOverridesInput)[];

/** A copy of `overrides` with every key that holds nothing taken away. */
function draftOf(overrides: AgentOverridesInput): OverridesDraft {
  const draft: OverridesDraft = { ...overrides };
  for (const key of OVERRIDE_KEYS) {
    if (draft[key] === null || draft[key] === undefined) delete draft[key];
  }
  return draft;
}

/** Holds the overrides in force for one agent's page, and writes each tab's changes over them. */
export class AgentOverridesBinding {
  readonly #id: string;
  #hash: string | undefined;
  #overrides: AgentOverridesInput | undefined;

  constructor(id: string) {
    this.#id = id;
  }

  /**
   * Takes up what the Bureau answered, unless it is the overrides this binding already holds. The
   * hash is of the overrides' content, so a Restore that brings an older set back answers with a
   * hash this binding held before: only the hash it holds now is skipped, and any other is taken.
   */
  sync(state: AgentOverridesState): void {
    if (state.hash === this.#hash) return;
    this.#hash = state.hash;
    this.#overrides = state.overrides;
  }

  /** The overrides as last read or written, or `undefined` before the first read. */
  get overrides(): AgentOverridesInput | undefined {
    return this.#overrides;
  }

  /**
   * The writer of one tab: the tab writes a definition over the hash it holds, with the definition
   * it was filled with, or last wrote (`filled`), and what the person changed from `filled` becomes
   * the next version of the overrides.
   */
  writerFor(tab: OverridesTab): OverridesWriter {
    return async (expectedHash, definition, filled) => {
      const current = this.#overrides;
      if (current === undefined) {
        throw new TypeError('The overrides of the agent have not been read.');
      }
      // A write names the hash of the overrides this binding built its changes over. A tab that
      // holds another (the overrides moved under it, by a Restore or another person) is stale: its
      // changes are not written over a set it never read, which the Bureau would also refuse.
      if (expectedHash !== this.#hash) {
        // The wire's own shape of the fault, which `agentFaultOf` sorts as `stale`.
        throw new HttpClientError(409, 'The overrides changed after the tab read them.', {
          data: { weftCode: 'StaleRevision', currentRevision: this.#hash },
        });
      }
      const before = ownedBy(tab, filled);
      const written = ownedBy(tab, definition);
      const changed = OWNED_KEYS.filter(
        (key) => written[key] !== undefined && !same(written[key], before[key]),
      );
      const next = draftOf(current);
      const limits: LimitsDraft = { ...current.limits };
      for (const key of changed) {
        switch (key) {
          case 'instructions':
            assign(next, 'instructions', written.instructions);
            break;
          case 'model':
            assign(next, 'model', written.model);
            break;
          case 'models':
            assign(next, 'models', written.models);
            break;
          case 'effort':
            assign(next, 'effort', written.effort);
            break;
          case 'tools':
            assign(next, 'tools', written.tools);
            break;
          case 'approvals':
            assign(next, 'approvals', written.approvals);
            break;
          case 'guardrails':
            assign(next, 'guardrails', written.guardrails);
            break;
          case 'steps':
            assign(limits, 'steps', written.steps);
            break;
          case 'cost':
            assign(limits, 'cost', written.cost);
            break;
        }
      }
      for (const key of ['steps', 'cost', 'tools'] as const) {
        if (limits[key] === null || limits[key] === undefined) delete limits[key];
      }
      if (Object.keys(limits).length === 0) delete next.limits;
      else next.limits = limits;

      const result = await updateAgentOverrides(this.#id, expectedHash, next);
      this.#hash = result.hash;
      this.#overrides = next;
      return { id: result.id, hash: result.hash };
    };
  }
}
