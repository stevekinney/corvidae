/**
 * The addresses of an agent: its page, its editor, and its memory. This is the one module that spells them, so a
 * link to an agent from the agent list, a schedule, or a goal cannot disagree about how a name is
 * encoded (`app/routes.test.ts` fails if another file builds one).
 */

/** An agent's page. */
export function agentPath(name: string): string {
  return `/agents/${encodeURIComponent(name)}`;
}

/** An agent's editor. */
export function agentEditPath(name: string): string {
  return `${agentPath(name)}/edit`;
}

/** The form for a new agent filled from the agent `name`: Duplicate. */
export function agentDuplicatePath(name: string): string {
  return `/agents/new?from=${encodeURIComponent(name)}`;
}

/** What an agent remembers. */
export function agentMemoryPath(name: string): string {
  return `${agentPath(name)}/memories`;
}

/** One memory of an agent, open beside the list of the others: the identifier is one path segment. */
export function agentMemoryItemPath(name: string, memory: string): string {
  return `${agentMemoryPath(name)}/${encodeURIComponent(memory)}`;
}

/**
 * The plugin that ships the agent `name`, or `null` for an owner's agent or one defined in code.
 * A plugin's agent is `plugin:name` (COR-1873), and an owner's file name never has a colon, so the
 * colon tells them apart the way the Bureau does.
 */
export function pluginOfAgent(name: string): string | null {
  const colon = name.indexOf(':');
  return colon === -1 ? null : name.slice(0, colon);
}
