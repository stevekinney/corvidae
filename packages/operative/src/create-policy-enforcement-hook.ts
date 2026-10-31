import { type ToolIdentity, toolListEntryMatches } from 'armorer';
import type { ToolPolicy } from 'armorer/protocol';

export type { ToolPolicy };

export interface ToolLike {
  name: string;
  /** With it, a list entry matches as Armorer's `toolListEntryMatches` says (COR-1879). */
  identity?: ToolIdentity | undefined;
}

function listed<T extends ToolLike>(list: readonly string[], tool: T): boolean {
  return list.some((entry) =>
    toolListEntryMatches(entry, { toolName: tool.name, identity: tool.identity }),
  );
}

export interface CreatePolicyEnforcementHookOptions {
  /** Persona tool policy (static for the run). */
  personaToolPolicy?: ToolPolicy | undefined;
  /** Returns the currently active skill's tool policy (dynamic, changes during run). */
  getActiveSkillToolPolicy?: () => ToolPolicy | undefined;
}

/**
 * Applies a single tool policy to a tool array.
 *
 * Allow list restricts to only named tools. Deny list excludes named tools.
 * When both are present, deny list wins — a tool present in both lists is excluded.
 * A namespaced entry (`plugin:tool`) names that tool by its unversioned id; a bare entry names
 * only a tool in the default namespace, so `search` never reaches into a plugin's namespace.
 */
function applyPolicy<T extends ToolLike>(tools: T[], policy: ToolPolicy | undefined): T[] {
  if (!policy) return tools;

  const { allowList, denyList } = policy;
  let filtered = tools;

  if (allowList) {
    filtered = filtered.filter((tool) => listed(allowList, tool));
  }

  if (denyList) {
    filtered = filtered.filter((tool) => !listed(denyList, tool));
  }

  return filtered;
}

/**
 * Creates a tool-filtering function that enforces persona and active skill tool policies.
 *
 * The effective tool set is: `tools intersection persona.toolPolicy intersection skill.toolPolicy`.
 * Deny lists always win over allow lists within each policy layer.
 *
 * The returned function is generic — it preserves the concrete tool type of the input array,
 * requiring only that each element has a `name: string` property.
 */
export function createPolicyEnforcementHook(
  options: CreatePolicyEnforcementHookOptions,
): <T extends ToolLike>(tools: T[]) => T[] {
  const { personaToolPolicy, getActiveSkillToolPolicy } = options;

  return <T extends ToolLike>(tools: T[]): T[] => {
    let filtered = applyPolicy(tools, personaToolPolicy);

    if (getActiveSkillToolPolicy) {
      filtered = applyPolicy(filtered, getActiveSkillToolPolicy());
    }

    return filtered;
  };
}
