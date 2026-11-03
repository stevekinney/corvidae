/**
 * COR-2009 — code-defined agents that hold Bureau's own tools.
 *
 * Bureau's tools (`discover-agents`, the workflow tools) read the Bureau they belong to, so they are
 * built inside `createBureau`, after the caller has already built its agents. An agent file names
 * them as `bureau:discover-agents`; a code-defined agent cannot, because its toolbox is fixed when
 * `createAgent` returns. {@link BureauOptions.agentsWithBureauTools} closes the gap: each entry is a
 * function that builds the agent from the built-in plugin's tools, which `createBureau` calls once
 * those tools exist, before any plugin is composed. The agent then joins the catalog under its key
 * exactly as an entry of {@link BureauOptions.agents} does, and a plugin agent of the same name is
 * skipped as a clash, as it would be for one of those.
 *
 * The tools handed over are the ones the built-in plugin contributes, rebuilt the same way, so an
 * agent's toolbox holds `bureau:workflows-create@1.0.0`, the identity an approval and a durable
 * record pin, and the catalog counts the agent among the tool's users.
 *
 * @module agents-with-bureau-tools
 */

import type { AnyTool, Tool } from 'armorer';

import type { AgentDefinitions, AnyRunnableAgent } from './agent-catalog.ts';
import { BUREAU_PLUGIN_NAME, BUREAU_PLUGIN_VERSION } from './plugins/bureau-plugin.ts';
import { pluginTool } from './plugins/plugin-tools.ts';

/**
 * Bureau's own tools, by the name an agent file uses for them: `bureau:discover-agents`, and with a
 * `workflowSource` `bureau:workflows-create`, `bureau:workflows-update`, `bureau:workflows-pause`,
 * `bureau:workflows-resume` and `bureau:workflows-list`.
 */
export type BureauOwnTools = Readonly<Record<string, Tool>>;

/** Builds one code-defined agent from {@link BureauOwnTools}. Called once, while the Bureau is built. */
export type AgentWithBureauTools = (tools: BureauOwnTools) => AnyRunnableAgent;

/** `tools`, the built-in plugin's, keyed and rebuilt as the plugin contributes them. */
export function bureauOwnTools(tools: readonly AnyTool[]): BureauOwnTools {
  const own: Record<string, Tool> = Object.create(null) as Record<string, Tool>;
  for (const tool of tools) {
    const rebuilt = pluginTool(tool, BUREAU_PLUGIN_NAME, BUREAU_PLUGIN_VERSION);
    own[`${BUREAU_PLUGIN_NAME}:${rebuilt.name}`] = rebuilt;
  }
  return Object.freeze(own);
}

/**
 * `agents` with every agent of `builders` built from `tools` and added under its key. A key that
 * `agents` already holds, or the reserved `reserved`, is refused through `refuse` (which throws),
 * before any builder runs. Returns `agents` itself when there is nothing to build.
 */
export function withAgentsBuiltFromBureauTools<D extends AgentDefinitions>(
  agents: D | undefined,
  builders: Readonly<Record<string, AgentWithBureauTools>> | undefined,
  tools: BureauOwnTools,
  reserved: string,
  refuse: (message: string) => never,
): D | undefined {
  const names = Object.keys(builders ?? {});
  if (builders === undefined || names.length === 0) return agents;
  for (const name of names) {
    if (name === reserved) {
      refuse(
        `"options.agentsWithBureauTools" names the agent "${reserved}", which is reserved for the Bureau-wide default agent`,
      );
    }
    if (agents !== undefined && Object.hasOwn(agents, name)) {
      refuse(
        `"options.agentsWithBureauTools" names the agent "${name}", which "options.agents" already holds`,
      );
    }
  }
  const built: Record<string, AnyRunnableAgent> = {};
  for (const [name, build] of Object.entries(builders)) built[name] = build(tools);
  // `D` describes the caller's own agents; the built ones are found by runtime name, as plugin agents are.
  return { ...agents, ...built } as D;
}
