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

/** What an agent remembers. */
export function agentMemoryPath(name: string): string {
  return `${agentPath(name)}/memories`;
}
