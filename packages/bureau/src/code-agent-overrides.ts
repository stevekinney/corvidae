/**
 * What a person may change on a code agent, checked against the deployment (COR-2009, COR-2228).
 *
 * A code agent is one the catalog runs: a built-in agent the host itself defines, or the agent of
 * a running plugin (`plugin:name`). An agent file keeps its own history, and a plugin's content
 * agent is a read-only file, so only a code agent takes overrides, and only one that resolves its
 * run options, because that is what an override is applied to. {@link createCodeAgentOverrides} is
 * the catalog's `overrides` member: it decides which agents those are, checks a save the way an
 * agent file's frontmatter is checked (the tools must be ones the deployment holds, each Asks
 * entry must name an allowed tool, each model must be in the model catalog and allowed by the
 * model policy, each guardrail is listed once and configured as its schema allows), and leaves the
 * versions to `agent-override-store.ts`.
 *
 * @module code-agent-overrides
 */

import type { BackendDescriptor } from '@lostgradient/operative';

import { type AgentContributions, refusedGuardrailConfigurations } from './agent-contributions';
import { AgentFileError, type AgentFileIssue, agentGuardrailSelectionsSchema } from './agent-file';
import { resolveModelDescriptor } from './agent-file-catalog';
import type { AgentFileSaveOptions } from './agent-file-writer';
import {
  type AgentOverrides,
  type AgentOverrideState,
  type AgentOverrideStore,
  type AgentOverrideVersionRecord,
  type AgentOverrideWriteResult,
  agentOverridesSchema,
} from './agent-override-store';
import { modelPolicyDenialOf, type BureauModelPolicyOptions } from './model-policy';
import { ownerOrLocal } from './owner-of-record';

/** The overrides of the code agents, as `bureau.agents.overrides` offers them. */
export interface CodeAgentOverrides {
  /**
   * Whether `id` is a code agent the catalog runs: a built-in agent, or the agent of a running
   * plugin (`plugin:name`). Not a file, a plugin's content agent, or a disabled plugin's agent.
   */
  isCodeAgent(id: string): boolean;
  /**
   * The overrides of code agent `id` in force now, with the hash a save names as its
   * `expectedHash`; `undefined` when `id` is not a code agent the catalog runs.
   */
  get(id: string): Promise<AgentOverrideState | undefined>;
  /**
   * Saves `overrides` as the next version of code agent `id`, replacing every override in
   * force (a key left out is no longer overridden), if those still hash to `options.expectedHash`.
   * Overrides equal to those in force write nothing. Fails with `AgentFileError`
   * `agent-file-not-found` for an identifier that is no agent, `agent-file-read-only` for an agent
   * file or a plugin's content agent, `agent-unavailable` for the agent of a plugin that is not
   * running, `agent-not-overridable` for a code agent that resolves no run options (so there is
   * nothing to apply an override to), `invalid-frontmatter` for overrides that are not well formed,
   * `unknown-tool` for a tool the deployment does not hold, `unknown-approval-tool` for an Asks
   * entry on a tool the agent may not use, `unknown-model` and `model-policy-denied` for a model
   * the catalog lacks or the policy forbids, `invalid-frontmatter` for a guardrail listed twice and
   * `invalid-guardrail-configuration` for a configuration its schema refuses (COR-2118), and with
   * `AgentFileConflictError` when the overrides changed since; each writes nothing.
   */
  save(
    id: string,
    overrides: AgentOverrides,
    options: { readonly expectedHash: string } & AgentFileSaveOptions,
  ): Promise<AgentOverrideWriteResult>;
  /** The saved versions of code agent `id`, newest first; empty for any other identifier. */
  versions(id: string): Promise<readonly AgentOverrideVersionRecord[]>;
  /**
   * The overrides of code agent `id` in force, as this Bureau last read them from the store
   * ({@link load}) or saved them; empty for an agent never changed and for any other identifier.
   * Synchronous, so the catalog can hand a run the agent with its overrides applied.
   */
  inForce(id: string): AgentOverrides;
  /**
   * The tools code agent `id` states itself, before any override: what a version that does
   * not override `tools` allows. Empty for any other identifier.
   */
  ownTools(id: string): readonly string[];
  /**
   * Reads the overrides in force of every code agent from the store, for {@link inForce}. The
   * Bureau calls it once it is built and whenever the catalog is refreshed, so a version another
   * process saved on the same store is read then.
   */
  load(): Promise<void>;
  /**
   * Saves version `version` of code agent `id` again as a new version, under the checks and
   * failures of {@link save}, and `agent-version-not-found` when no such version is stored.
   */
  restore(
    id: string,
    version: number,
    options: { readonly expectedHash: string } & AgentFileSaveOptions,
  ): Promise<AgentOverrideWriteResult>;
}

/** What {@link createCodeAgentOverrides} reads from the catalog. */
export interface CodeAgentOverridesOptions {
  /** Where the versions live. */
  readonly store: AgentOverrideStore;
  /**
   * The code agents the catalog runs, by identifier: the built-in agents and the agents of running
   * plugins. `tools` is what each names itself, and `resolvesRuns` whether it has a definition
   * resolver, without which an override has nothing to be applied to.
   */
  readonly codeAgents: ReadonlyMap<
    string,
    { readonly tools: readonly string[]; readonly resolvesRuns: boolean }
  >;
  /** Whether `id` is the agent of a plugin that is not running, which the catalog lists `unavailable`. */
  readonly isUnavailable: (id: string) => boolean;
  /** Whether `id` names an agent the catalog lists as something other than a code agent. */
  readonly listsOtherAgent: (id: string) => boolean;
  /** The tool names the deployment's tool catalog holds. */
  readonly toolNames: () => ReadonlySet<string>;
  /** The deployment's model catalog as it is now. */
  readonly descriptors: () => readonly BackendDescriptor[];
  /** The model policy as it is now. */
  readonly modelPolicy: () => BureauModelPolicyOptions | undefined;
  /**
   * The guardrails a `guardrails` override may name, whose schemas check its configurations
   * (COR-2118). Omitted, no configuration is checked, as no guardrail resolves.
   */
  readonly contributions?: AgentContributions | undefined;
}

function refused(
  code:
    | 'unknown-tool'
    | 'unknown-approval-tool'
    | 'unknown-model'
    | 'model-policy-denied'
    | 'invalid-frontmatter'
    | 'invalid-guardrail-configuration',
  message: string,
  issues: readonly AgentFileIssue[],
): AgentFileError {
  return new AgentFileError(code, message, { code, message, issues });
}

function checkTools(
  overrides: AgentOverrides,
  agentTools: readonly string[],
  held: ReadonlySet<string>,
) {
  const own = new Set(agentTools);
  const missing = (overrides.tools ?? []).flatMap((name, index) =>
    own.has(name) || held.has(name)
      ? []
      : [{ path: `tools.${index}`, message: `No tool is named "${name}".`, reference: name }],
  );
  if (missing.length > 0) {
    throw refused(
      'unknown-tool',
      'The overrides name a tool the deployment does not hold.',
      missing,
    );
  }
  const allowed = new Set(overrides.tools ?? agentTools);
  const strays = Object.keys(overrides.approvals ?? {}).flatMap((name) =>
    allowed.has(name)
      ? []
      : [
          {
            path: `approvals.${name}`,
            message: `The agent may not use "${name}".`,
            reference: name,
          },
        ],
  );
  if (strays.length > 0) {
    throw refused(
      'unknown-approval-tool',
      'The overrides say how a tool asks that the agent may not use.',
      strays,
    );
  }
}

function checkModels(
  overrides: AgentOverrides,
  descriptors: readonly BackendDescriptor[],
  policy: BureauModelPolicyOptions | undefined,
) {
  const named = [
    ...(overrides.model === undefined ? [] : [{ path: 'model', model: overrides.model }]),
    ...(overrides.models ?? []).map((model, index) => ({ path: `models.${index}`, model })),
  ];
  const unknown: AgentFileIssue[] = [];
  const denied: AgentFileIssue[] = [];
  for (const { path, model } of named) {
    const row = resolveModelDescriptor(model, descriptors);
    if ('code' in row) {
      unknown.push({ path, message: row.message, reference: model });
    } else if (modelPolicyDenialOf(row, policy) !== undefined) {
      denied.push({ path, message: `The model policy forbids "${model}".`, reference: model });
    }
  }
  if (unknown.length > 0) {
    throw refused(
      'unknown-model',
      'The overrides name a model the catalog does not hold.',
      unknown,
    );
  }
  if (denied.length > 0) {
    throw refused('model-policy-denied', 'The overrides name a model the policy forbids.', denied);
  }
}

/**
 * Refuses a `guardrails` override that lists an id twice, or configures a guardrail in a way its
 * schema refuses (COR-2118). A record stored before COR-2118 may repeat an id and still reads; a
 * save, or a restore of it, is checked as a new save is.
 */
function checkGuardrails(overrides: AgentOverrides, contributions: AgentContributions | undefined) {
  const unique = agentGuardrailSelectionsSchema.safeParse(overrides.guardrails ?? []);
  if (!unique.success) {
    throw refused(
      'invalid-frontmatter',
      'The overrides list a guardrail more than once.',
      unique.error.issues.map((issue) => ({
        path: ['guardrails', ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    );
  }
  if (contributions === undefined) return;
  const issues = refusedGuardrailConfigurations(overrides, contributions);
  if (issues.length > 0) {
    throw refused(
      'invalid-guardrail-configuration',
      'The overrides configure a guardrail in a way it refuses.',
      issues,
    );
  }
}

/** The `overrides` member of the agent catalog; see {@link CodeAgentOverrides}. */
export function createCodeAgentOverrides(options: CodeAgentOverridesOptions): CodeAgentOverrides {
  const { store, codeAgents } = options;
  const isCodeAgent = (id: string) => codeAgents.has(id);
  const inForce = new Map<string, AgentOverrides>();

  async function loadOne(id: string): Promise<void> {
    const state = await store.current(id);
    inForce.set(id, state.overrides);
  }

  /** Runs a write, then holds what is in force after it: the saved overrides, or the store's. */
  async function writing(
    id: string,
    write: () => Promise<{
      readonly result: AgentOverrideWriteResult;
      readonly overrides: AgentOverrides;
    }>,
  ): Promise<AgentOverrideWriteResult> {
    try {
      const { result, overrides } = await write();
      inForce.set(id, overrides);
      return result;
    } catch (error) {
      // A stale write lost to a save another process made: read what that save put in force.
      if (isCodeAgent(id)) await loadOne(id);
      throw error;
    }
  }

  function requireOverridable(id: string): { readonly tools: readonly string[] } {
    const agent = codeAgents.get(id);
    if (agent !== undefined) {
      if (agent.resolvesRuns) return agent;
      throw new AgentFileError(
        'agent-not-overridable',
        `Agent "${id}" does not resolve its run options, so there is nothing an override could change.`,
      );
    }
    if (options.isUnavailable(id)) {
      throw new AgentFileError(
        'agent-unavailable',
        `Agent "${id}" belongs to a plugin that is not running, so it takes no overrides.`,
      );
    }
    if (options.listsOtherAgent(id)) {
      throw new AgentFileError(
        'agent-file-read-only',
        `Agent "${id}" is not a code agent, so it takes no overrides.`,
      );
    }
    throw new AgentFileError('agent-file-not-found', `No agent is named "${id}".`);
  }

  function check(id: string, overrides: AgentOverrides): AgentOverrides {
    const agent = requireOverridable(id);
    const parsed = agentOverridesSchema.safeParse(overrides);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw new AgentFileError('invalid-frontmatter', 'The overrides are not well formed.', {
        code: 'invalid-frontmatter',
        message: 'The overrides are not well formed.',
        issues,
      });
    }
    checkTools(parsed.data, agent.tools, options.toolNames());
    checkModels(parsed.data, options.descriptors(), options.modelPolicy());
    checkGuardrails(parsed.data, options.contributions);
    return parsed.data;
  }

  const saveOptionsOf = (
    writeOptions: { readonly expectedHash: string } & AgentFileSaveOptions,
  ) => ({
    expectedHash: writeOptions.expectedHash,
    savedBy: ownerOrLocal(writeOptions.savedBy),
    owner: ownerOrLocal(undefined),
  });

  return {
    isCodeAgent,
    async get(id) {
      return isCodeAgent(id) ? store.current(id) : undefined;
    },
    async save(id, overrides, writeOptions) {
      const checked = check(id, overrides);
      return writing(id, async () => ({
        result: await store.save(id, checked, saveOptionsOf(writeOptions)),
        overrides: checked,
      }));
    },
    async versions(id) {
      return isCodeAgent(id) ? store.list(id) : [];
    },
    async restore(id, version, writeOptions) {
      requireOverridable(id);
      const versions = await store.list(id);
      const restored = versions.find((record) => record.version === version);
      // Checked again: a tool or model a version named may have gone from the deployment since.
      if (restored !== undefined) check(id, restored.overrides);
      return writing(id, async () => ({
        result: await store.restore(id, version, saveOptionsOf(writeOptions)),
        overrides: restored?.overrides ?? {},
      }));
    },
    inForce(id) {
      return (isCodeAgent(id) ? inForce.get(id) : undefined) ?? {};
    },
    ownTools(id) {
      return (isCodeAgent(id) ? codeAgents.get(id)?.tools : undefined) ?? [];
    },
    async load() {
      await Promise.all([...codeAgents.keys()].map(loadOne));
    },
  };
}
