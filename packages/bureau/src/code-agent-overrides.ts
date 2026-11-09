/**
 * What a person may change on a built-in agent, checked against the deployment (COR-2009).
 *
 * A built-in agent is a code agent the host itself defines: its identifier has no `plugin:`
 * prefix. A plugin's code agent is read-only (its page offers Duplicate instead), and an agent file
 * keeps its own history, so only a built-in agent takes overrides. {@link createCodeAgentOverrides}
 * is the catalog's `overrides` member: it decides which agents those are, checks a save the way an
 * agent file's frontmatter is checked (the tools must be ones the deployment holds, each Asks
 * entry must name an allowed tool, each model must be in the model catalog and allowed by the
 * model policy), and leaves the versions to `agent-override-store.ts`.
 *
 * @module code-agent-overrides
 */

import type { BackendDescriptor } from '@lostgradient/operative';

import { AgentFileError, type AgentFileIssue } from './agent-file';
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

/** The overrides of the built-in agents, as `bureau.agents.overrides` offers them. */
export interface CodeAgentOverrides {
  /**
   * Whether `id` is a built-in agent, the only kind that takes overrides: a code agent the host
   * defines, not a plugin's (`plugin:name`) and not a file.
   */
  isBuiltIn(id: string): boolean;
  /**
   * The overrides of built-in agent `id` in force now, with the hash a save names as its
   * `expectedHash`; `undefined` when `id` is not a built-in agent.
   */
  get(id: string): Promise<AgentOverrideState | undefined>;
  /**
   * Saves `overrides` as the next version of built-in agent `id`, replacing every override in
   * force (a key left out is no longer overridden), if those still hash to `options.expectedHash`.
   * Overrides equal to those in force write nothing. Fails with `AgentFileError`
   * `agent-file-not-found` for an identifier that is no agent, `agent-file-read-only` for a
   * plugin's agent or an agent file, `invalid-frontmatter` for overrides that are not well formed,
   * `unknown-tool` for a tool the deployment does not hold, `unknown-approval-tool` for an Asks
   * entry on a tool the agent may not use, `unknown-model` and `model-policy-denied` for a model
   * the catalog lacks or the policy forbids, and with `AgentFileConflictError` when the overrides
   * changed since; each writes nothing.
   */
  save(
    id: string,
    overrides: AgentOverrides,
    options: { readonly expectedHash: string } & AgentFileSaveOptions,
  ): Promise<AgentOverrideWriteResult>;
  /** The saved versions of built-in agent `id`, newest first; empty for any other identifier. */
  versions(id: string): Promise<readonly AgentOverrideVersionRecord[]>;
  /**
   * The overrides of built-in agent `id` in force, as this Bureau last read them from the store
   * ({@link load}) or saved them; empty for an agent never changed and for any other identifier.
   * Synchronous, so the catalog can hand a run the agent with its overrides applied.
   */
  inForce(id: string): AgentOverrides;
  /**
   * The tools built-in agent `id` states itself, before any override: what a version that does
   * not override `tools` allows. Empty for any other identifier.
   */
  ownTools(id: string): readonly string[];
  /**
   * Reads the overrides in force of every built-in agent from the store, for {@link inForce}. The
   * Bureau calls it once it is built and whenever the catalog is refreshed, so a version another
   * process saved on the same store is read then.
   */
  load(): Promise<void>;
  /**
   * Saves version `version` of built-in agent `id` again as a new version, under the checks and
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
  /** The code-defined agents by identifier, with the tools each names. */
  readonly builtInAgents: ReadonlyMap<string, { readonly tools: readonly string[] }>;
  /** Whether `id` names an agent the catalog lists as something other than a code-defined one. */
  readonly listsOtherAgent: (id: string) => boolean;
  /** The tool names the deployment's tool catalog holds. */
  readonly toolNames: () => ReadonlySet<string>;
  /** The deployment's model catalog as it is now. */
  readonly descriptors: () => readonly BackendDescriptor[];
  /** The model policy as it is now. */
  readonly modelPolicy: () => BureauModelPolicyOptions | undefined;
}

function refused(
  code: 'unknown-tool' | 'unknown-approval-tool' | 'unknown-model' | 'model-policy-denied',
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

/** The `overrides` member of the agent catalog; see {@link CodeAgentOverrides}. */
export function createCodeAgentOverrides(options: CodeAgentOverridesOptions): CodeAgentOverrides {
  const { store, builtInAgents } = options;
  const isBuiltIn = (id: string) => builtInAgents.has(id) && !id.includes(':');
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
      if (isBuiltIn(id)) await loadOne(id);
      throw error;
    }
  }

  function requireBuiltIn(id: string): { readonly tools: readonly string[] } {
    const agent = isBuiltIn(id) ? builtInAgents.get(id) : undefined;
    if (agent !== undefined) return agent;
    if (builtInAgents.has(id) || options.listsOtherAgent(id)) {
      throw new AgentFileError(
        'agent-file-read-only',
        `Agent "${id}" is not a built-in agent, so it takes no overrides.`,
      );
    }
    throw new AgentFileError('agent-file-not-found', `No agent is named "${id}".`);
  }

  function check(id: string, overrides: AgentOverrides): AgentOverrides {
    const agent = requireBuiltIn(id);
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
    isBuiltIn,
    async get(id) {
      return isBuiltIn(id) ? store.current(id) : undefined;
    },
    async save(id, overrides, writeOptions) {
      const checked = check(id, overrides);
      return writing(id, async () => ({
        result: await store.save(id, checked, saveOptionsOf(writeOptions)),
        overrides: checked,
      }));
    },
    async versions(id) {
      return isBuiltIn(id) ? store.list(id) : [];
    },
    async restore(id, version, writeOptions) {
      requireBuiltIn(id);
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
      return (isBuiltIn(id) ? inForce.get(id) : undefined) ?? {};
    },
    ownTools(id) {
      return (isBuiltIn(id) ? builtInAgents.get(id)?.tools : undefined) ?? [];
    },
    async load() {
      await Promise.all([...builtInAgents.keys()].filter(isBuiltIn).map(loadOne));
    },
  };
}
